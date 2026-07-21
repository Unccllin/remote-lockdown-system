/**
 * Phase 0: HMAC auth middleware tests.
 *
 * Verifies:
 *   - Valid HMAC signature passes
 *   - Invalid signature is rejected (401)
 *   - Replay (same nonce) is rejected
 *   - Timestamp outside window is rejected
 *   - Missing signature headers → allowed during transition (REQUIRE_HMAC=false)
 *   - Missing signature headers → rejected when REQUIRE_HMAC=true
 *   - Nonce format validation
 */

const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const { hmacVerify, verifyHmac } = require('../src/middleware/hmacAuth');
const { generateApiKey, hashApiKey } = require('../src/db/apiKey');

const DEVICE_KEY = generateApiKey();
const DEVICE = {
  id: 'dev-hmac-1',
  hostname: 'HMAC-TEST',
  status: 'active',
  api_key_hash: hashApiKey(DEVICE_KEY),
};

function signRequest(key, bodyStr) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const payload = `${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return {
    'x-agent-key': key,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    'x-sig-version': '1',
  };
}

function createApp(opts = {}) {
  const app = express();
  // Capture raw body — same as index.js
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));
  // Simulate agentAuth: set req.device and req.deviceKey
  app.use((req, _res, next) => {
    req.device = DEVICE;
    req.deviceKey = DEVICE_KEY;
    next();
  });
  app.post('/test', hmacVerify(opts), (req, res) => {
    res.json({ ok: true, hmacVerified: req.hmacVerified || false });
  });
  return app;
}

/**
 * Helper: send a signed request. Pre-serializes the body to a compact JSON
 * string (matching the agent's _signed_post behavior) and sends it with
 * explicit Content-Type so express.json() runs the verify hook.
 */
async function sendSigned(app, bodyObj, extraHeaders = {}) {
  const bodyStr = JSON.stringify(bodyObj); // compact, no spaces
  const headers = { ...signRequest(DEVICE_KEY, bodyStr), ...extraHeaders };
  return request(app)
    .post('/test')
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(bodyStr);
}

beforeEach(() => {
  mockPool.query.reset();
  // nonce_cache table queries — mock to return empty (nonce is fresh)
  mockPool.query.setResult('INSERT INTO nonce_cache', { rows: [], rowCount: 1 });
  mockPool.query.setResult('SELECT 1 FROM nonce_cache', { rows: [] });
});

describe('hmacAuth middleware', () => {
  test('valid HMAC signature passes', async () => {
    const app = createApp();
    const res = await sendSigned(app, { test: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.hmacVerified).toBe(true);
  });

  test('invalid signature is rejected', async () => {
    const app = createApp();
    const res = await sendSigned(app, { test: 'hello' }, { 'x-signature': '0'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature mismatch/);
  });

  test('tampered body is rejected (body hash mismatch)', async () => {
    const app = createApp();
    const bodyObj = { test: 'hello' };
    const signedBodyStr = JSON.stringify(bodyObj);
    const headers = signRequest(DEVICE_KEY, signedBodyStr);
    // Send different body than what was signed
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(JSON.stringify({ test: 'tampered' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature mismatch/);
  });

  test('timestamp outside window is rejected', async () => {
    const app = createApp();
    const bodyStr = JSON.stringify({ test: 'hello' });
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const payload = `${oldTs}:${nonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', DEVICE_KEY).update(payload).digest('hex');
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set({
        'x-agent-key': DEVICE_KEY,
        'x-timestamp': oldTs,
        'x-nonce': nonce,
        'x-signature': signature,
        'x-sig-version': '1',
      })
      .send(bodyStr);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/timestamp/);
  });

  test('invalid nonce format is rejected', async () => {
    const app = createApp();
    const bodyStr = JSON.stringify({ test: 'hello' });
    const ts = String(Math.floor(Date.now() / 1000));
    const badNonce = 'not-hex!!!';
    const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const payload = `${ts}:${badNonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', DEVICE_KEY).update(payload).digest('hex');
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set({
        'x-agent-key': DEVICE_KEY,
        'x-timestamp': ts,
        'x-nonce': badNonce,
        'x-signature': signature,
        'x-sig-version': '1',
      })
      .send(bodyStr);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/nonce format/);
  });

  test('missing signature headers → allowed during transition (default)', async () => {
    const app = createApp(); // requireHmac defaults to false
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('x-agent-key', DEVICE_KEY)
      .send(JSON.stringify({ test: 'hello' }));
    expect(res.status).toBe(200);
    expect(res.body.hmacVerified).toBe(false);
  });

  test('missing signature headers → rejected when requireHmac=true', async () => {
    const app = createApp({ requireHmac: true });
    const res = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set('x-agent-key', DEVICE_KEY)
      .send(JSON.stringify({ test: 'hello' }));
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/HMAC signature required/);
  });

  test('replay with same nonce is rejected', async () => {
    const app = createApp();
    const bodyStr = JSON.stringify({ test: 'replay' });
    const headers = signRequest(DEVICE_KEY, bodyStr);
    // First request: should pass
    const res1 = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(bodyStr);
    expect(res1.status).toBe(200);
    // Second request with same nonce: should be rejected as replay
    const res2 = await request(app)
      .post('/test')
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(bodyStr);
    expect(res2.status).toBe(401);
    expect(res2.body.error).toMatch(/replay/);
  });
});

describe('verifyHmac (unit)', () => {
  test('returns ok for valid signature', () => {
    const body = 'test-body';
    const headers = signRequest(DEVICE_KEY, body);
    const result = verifyHmac(DEVICE_KEY, headers, body);
    expect(result.ok).toBe(true);
    expect(result.nonce).toBe(headers['x-nonce']);
  });

  test('returns reason for missing headers', () => {
    const result = verifyHmac(DEVICE_KEY, {}, 'body');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/);
  });

  test('returns reason for wrong key', () => {
    const body = 'test-body';
    const headers = signRequest(DEVICE_KEY, body);
    const result = verifyHmac('wrong-key', headers, body);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/signature mismatch/);
  });
});
