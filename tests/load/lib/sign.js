/**
 * HMAC request signing for the load-test scripts.
 *
 * `server/src/middleware/hmacAuth.js` verifies:
 *
 *   payload   = `${x-timestamp}:${x-nonce}:${sha256hex(rawBody)}`
 *   signature = hex(HMAC-SHA256(deviceApiKey, payload))
 *
 * with `x-nonce` required to be 32 hex characters and unique per request (the
 * server keeps a replay cache), and `x-timestamp` inside
 * `HMAC_TIMESTAMP_WINDOW_SECONDS` of server time.
 *
 * Why the scripts historically ran unsigned: signing needs the *per-device*
 * plaintext key. With only a shared `AGENT_SHARED_KEY`, `agentAuth` has no
 * device key, so `hmacAuth` deliberately allows the request through
 * ("HMAC present but no device key … allowing (legacy)").
 *
 * Rather than shipping N keys, both sides derive them from one secret:
 *
 *   key_i = base64(HMAC-SHA256(K6_HMAC_SECRET, "load-test-device-0000i"))
 *
 * `scripts/seed-loadtest-devices.js --hmac-secret <same secret>` stores
 * `api_key_hash = HMAC-SHA256(AGENT_KEY_PEPPER, key_i)` for device i, so the
 * plaintext key exists only as that derivation.
 *
 * Usage in a script:
 *
 *   const payload = JSON.stringify(body);
 *   const headers = authHeaders(AGENT_KEY, __VU, payload);
 *   http.post(url, payload, { headers });
 *
 * Set both `K6_HMAC_SECRET` (k6) and `--hmac-secret` (seeder) to the same value,
 * and run the server with `REQUIRE_HMAC=true`. Leave the secret unset and the
 * helpers fall back to the legacy unsigned shared-key path.
 */
import crypto from 'k6/crypto';

const DEVICE_PREFIX = 'load-test-device-';

/**
 * Derive a device's API key. Must match the seeder byte for byte.
 * @param {string} secret - shared derivation secret (K6_HMAC_SECRET)
 * @param {number} vuId - k6 VU id (1-based)
 * @returns {string} base64-encoded key, same shape as a real enrolled key
 */
export function deviceKey(secret, vuId) {
  const idx = String(vuId).padStart(5, '0');
  return crypto.hmac('sha256', secret, DEVICE_PREFIX + idx, 'base64');
}

/** 32 lowercase hex chars — the format the server's nonce check requires. */
function randomHex(bytes) {
  const buf = new Uint8Array(crypto.randomBytes(bytes));
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Build signed headers for one request.
 * @param {string} apiKey - this VU's device key
 * @param {string} body - the exact request body string that will be sent
 */
export function signedHeaders(apiKey, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomHex(16);
  const bodyHash = crypto.sha256(body, 'hex');
  const signature = crypto.hmac('sha256', apiKey, `${ts}:${nonce}:${bodyHash}`, 'hex');
  return {
    'Content-Type': 'application/json',
    'x-agent-key': apiKey,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': signature,
    'x-sig-version': 'v1',
  };
}

/**
 * Headers for a request: signed when K6_HMAC_SECRET is set, legacy unsigned
 * shared-key headers otherwise. Keeping one entry point means a script cannot
 * accidentally send an unsigned request while a signing secret is configured.
 */
export function authHeaders(sharedKey, vuId, body) {
  const secret = __ENV.K6_HMAC_SECRET;
  if (!secret) {
    return { 'Content-Type': 'application/json', 'x-agent-key': sharedKey };
  }
  return signedHeaders(deviceKey(secret, vuId), body);
}
