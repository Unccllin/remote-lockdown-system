/**
 * Contract test for the load-test HMAC signing scheme (tests/load/lib/sign.js).
 *
 * `sign.js` runs inside k6, so it cannot be imported into Jest. What can be
 * locked down is the contract it implements, using the server's own code:
 *
 *   1. a device key derives deterministically from (K6_HMAC_SECRET, hostname)
 *   2. that key hashes to an `api_key_hash` the server accepts
 *   3. a request signed the way sign.js signs it passes `verifyHmac`, and every
 *      single-field tamper fails
 *
 * Before this existed, the only proof was a manual probe run against a live
 * server, so a regression in either half would have gone unnoticed until a load
 * test mysteriously returned 401s.
 */

const crypto = require('crypto');

const { hashApiKey, verifyApiKey } = require('../src/db/apiKey');
const { verifyHmac } = require('../src/middleware/hmacAuth');

const PEPPER = 'test_agent_key_pepper_do_not_use_in_prod_64hex_00';

/** Exactly what sign.js does inside k6 (k6/crypto hmac with 'base64' output). */
function deviceKey(secret, vuId) {
  const idx = String(vuId).padStart(5, '0');
  return crypto.createHmac('sha256', secret).update(`load-test-device-${idx}`).digest('base64');
}

/** Exactly what sign.js sends. */
function signedHeaders(apiKey, body, { ts, nonce } = {}) {
  const timestamp = ts !== undefined ? String(ts) : String(Math.floor(Date.now() / 1000));
  const n = nonce || crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto
    .createHmac('sha256', apiKey)
    .update(`${timestamp}:${n}:${bodyHash}`)
    .digest('hex');
  return {
    'x-agent-key': apiKey,
    'x-timestamp': timestamp,
    'x-nonce': n,
    'x-signature': signature,
    'x-sig-version': 'v1',
  };
}

const SECRET = 'k6-load-secret';
const BODY = JSON.stringify({
  hostname: 'load-test-device-00001',
  mac_address: '02:00:00:00:00:01',
  hardware_uuid: '00000000-0000-4000-8000-000000000001',
});

beforeAll(() => {
  process.env.AGENT_KEY_PEPPER = PEPPER;
});

describe('load-test HMAC signing contract', () => {
  test('device key is deterministic and shaped like a real enrolled key', () => {
    const a = deviceKey(SECRET, 1);
    const b = deviceKey(SECRET, 1);
    expect(a).toBe(b);
    expect(a).toHaveLength(44); // base64 of a 32-byte digest, as generateApiKey() produces
    expect(deviceKey(SECRET, 2)).not.toBe(a); // distinct per device
    expect(deviceKey('other-secret', 1)).not.toBe(a); // distinct per secret
  });

  test('the derived key hashes to an api_key_hash the server accepts', () => {
    const key = deviceKey(SECRET, 1);
    expect(verifyApiKey(key, hashApiKey(key))).toBe(true);
    expect(verifyApiKey(deviceKey(SECRET, 2), hashApiKey(key))).toBe(false);
  });

  test('a sign.js-shaped request verifies', () => {
    const key = deviceKey(SECRET, 1);
    const result = verifyHmac(key, signedHeaders(key, BODY), BODY);
    expect(result.ok).toBe(true);
    expect(result.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  test.each([
    ['tampered body', (k) => [signedHeaders(k, BODY), `${BODY} `]],
    ['wrong key', () => [signedHeaders(deviceKey(SECRET, 2), BODY), BODY]],
    ['stale timestamp', (k) => [signedHeaders(k, BODY, { ts: 1 }), BODY]],
    ['stale timestamp (future)', (k) => [signedHeaders(k, BODY, { ts: 9999999999 }), BODY]],
    ['malformed nonce', (k) => [signedHeaders(k, BODY, { nonce: 'nothex' }), BODY]],
    ['short nonce', (k) => [signedHeaders(k, BODY, { nonce: 'abc123' }), BODY]],
  ])('%s is rejected', (_label, build) => {
    const key = deviceKey(SECRET, 1);
    const [headers, body] = build(key);
    expect(verifyHmac(key, headers, body).ok).toBe(false);
  });

  test('missing signature headers are rejected', () => {
    const key = deviceKey(SECRET, 1);
    const { 'x-signature': _drop, ...rest } = signedHeaders(key, BODY);
    expect(verifyHmac(key, rest, BODY).ok).toBe(false);
  });

  test('a signature over a different body does not transfer', () => {
    const key = deviceKey(SECRET, 1);
    const headers = signedHeaders(key, BODY);
    const otherBody = JSON.stringify({ hostname: 'load-test-device-00002' });
    expect(verifyHmac(key, headers, otherBody).ok).toBe(false);
  });
});
