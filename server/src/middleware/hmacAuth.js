/**
 * hmacAuth — HMAC request signing + replay protection for agent endpoints.
 *
 * Phase 0 security hardening. Replaces bare API-key-in-header with:
 *   X-Timestamp:  unix seconds
 *   X-Nonce:      32-char hex random
 *   X-Signature:  HMAC-SHA256(device_key, "{timestamp}:{nonce}:{body_sha256}")
 *   X-Sig-Version: "1"
 *
 * The agent still sends X-Agent-Key for device identification and backwards
 * compatibility. If X-Signature is present, it is validated and replay is
 * rejected. If X-Signature is absent, the request is allowed during the
 * transition period but a warning is logged. Once all agents are upgraded,
 * set REQUIRE_HMAC=true to reject unsigned requests.
 *
 * Replay protection:
 *   - Timestamp must be within ±300s of server time
 *   - Nonce must not have been seen in the last 10 min (TTL > timestamp window)
 *   - In-memory Map with periodic cleanup (single-instance). For multi-instance
 *     deployments, set USE_DB_NONCE_CACHE=true to use the nonce_cache table.
 */

const crypto = require('crypto');
const logger = require('../logger');

const TIMESTAMP_WINDOW_SECONDS = parseInt(process.env.HMAC_TIMESTAMP_WINDOW_SECONDS || '300', 10);
const NONCE_TTL_MS = parseInt(process.env.HMAC_NONCE_TTL_MS || '600000', 10);
const CLEANUP_INTERVAL_MS = parseInt(process.env.HMAC_CLEANUP_INTERVAL_MS || '300000', 10);
const REQUIRE_HMAC = process.env.REQUIRE_HMAC === 'true';
const USE_DB_NONCE_CACHE = process.env.USE_DB_NONCE_CACHE === 'true';

// In-memory nonce cache: Map<nonce, expiresAt(ms)>
const nonceCache = new Map();

// Periodic cleanup of expired nonces
let cleanupTimer = null;
function startCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [n, expires] of nonceCache) {
      if (expires <= now) nonceCache.delete(n);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}
startCleanup();

/**
 * Verify HMAC signature from request headers against the device key.
 * @param {string} deviceKey - plaintext API key from DB lookup
 * @param {object} headers - request headers (lowercase keys)
 * @param {string} rawBody - raw request body string
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyHmac(deviceKey, headers, rawBody) {
  const timestamp = headers['x-timestamp'];
  const nonce = headers['x-nonce'];
  const signature = headers['x-signature'];

  if (!timestamp || !nonce || !signature) {
    return { ok: false, reason: 'missing signature headers' };
  }

  // Validate timestamp window
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, reason: 'timestamp outside allowed window' };
  }

  // Validate nonce format (32-char hex)
  if (!/^[0-9a-f]{32}$/i.test(nonce)) {
    return { ok: false, reason: 'invalid nonce format' };
  }

  // Compute expected signature
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const payload = `${timestamp}:${nonce}:${bodyHash}`;
  const expected = crypto.createHmac('sha256', deviceKey).update(payload).digest('hex');

  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true, nonce, ttl: NONCE_TTL_MS };
}

/**
 * Check and record a nonce to prevent replay.
 * @param {string} nonce
 * @param {number} ttlMs
 * @param {object|null} pool - DB pool (required if USE_DB_NONCE_CACHE)
 * @returns {Promise<boolean>} true if nonce is fresh (not seen before)
 */
async function checkAndRecordNonce(nonce, ttlMs, pool) {
  if (USE_DB_NONCE_CACHE && pool) {
    try {
      // INSERT ... ON CONFLICT DO NOTHING returns rowCount=1 if the row was
      // freshly inserted (nonce is new → not a replay) and rowCount=0 if the
      // nonce already existed (ON CONFLICT suppressed the insert → replay).
      // The previous code re-queried with SELECT, which could not distinguish
      // "just inserted" from "already existed" — both return a row, so replays
      // were silently accepted.
      const result = await pool.query(
        `INSERT INTO nonce_cache (nonce, expires_at) VALUES ($1, NOW() + ($2 || ' milliseconds')::interval)
         ON CONFLICT (nonce) DO NOTHING`,
        [nonce, String(ttlMs)]
      );
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      // If nonce_cache table doesn't exist, fall back to in-memory
      logger.warn({ err }, 'hmacAuth: DB nonce cache failed, falling back to in-memory');
    }
  }

  // In-memory check
  const now = Date.now();
  if (nonceCache.has(nonce)) {
    return false; // replay
  }
  nonceCache.set(nonce, now + ttlMs);
  return true;
}

/**
 * Express middleware factory. Must be used AFTER agentAuth (which sets req.device
 * and req.deviceKey).
 *
 * @param {object} opts
 * @param {boolean} opts.requireHmac - if true, reject unsigned requests
 */
function hmacVerify(opts = {}) {
  const requireHmac = opts.requireHmac !== undefined ? opts.requireHmac : REQUIRE_HMAC;

  return async function hmacVerifyMiddleware(req, res, next) {
    // req.deviceKey is set by agentAuth (the plaintext key, available only during
    // the request lifecycle — not stored on req.device which is the DB row)
    const deviceKey = req.deviceKey;
    const hasSig = req.headers['x-signature'];

    if (!hasSig) {
      if (requireHmac) {
        return res.status(401).json({ error: 'HMAC signature required. Include X-Timestamp, X-Nonce, X-Signature, and X-Sig-Version headers. See the HMAC signing documentation for the signature format.' });
      }
      // Transition period: allow unsigned requests with warning
      logger.warn(
        'hmacAuth: unsigned request from device %s at %s — upgrade agent to support HMAC signing',
        req.device?.id || 'unknown',
        req.path
      );
      return next();
    }

    if (!deviceKey) {
      // Can't verify HMAC without the device key. This happens if auth succeeded
      // via legacy shared key (we don't have the per-device key in that case).
      // Allow during transition.
      logger.warn('hmacAuth: HMAC present but no device key for device %s — allowing (legacy)', req.device?.id);
      return next();
    }

    // rawBody is populated by express.json() verify hook (see index.js)
    const rawBody = req.rawBody || '';
    const result = verifyHmac(deviceKey, req.headers, rawBody);
    if (!result.ok) {
      return res.status(401).json({ error: `HMAC verification failed: ${result.reason}. Ensure the agent is using the correct device API key and that the X-Timestamp, X-Nonce, and X-Signature headers are correctly computed.` });
    }

    // Replay protection
    const pool = require('../db/pool');
    const fresh = await checkAndRecordNonce(result.nonce, result.ttl, pool);
    if (!fresh) {
      return res.status(401).json({ error: 'replay detected (nonce already used). Generate a new X-Nonce for each request.' });
    }

    req.hmacVerified = true;
    next();
  };
}

module.exports = { hmacVerify, verifyHmac, checkAndRecordNonce };
