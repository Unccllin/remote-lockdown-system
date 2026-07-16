/**
 * apiKey — per-device API key generation and verification.
 *
 * FA3 / CC5 / CC6: Per-device API keys replace the global AGENT_SHARED_KEY.
 *
 * Key format: 32-byte random, base64-encoded (44 chars). Stored as
 * HMAC-SHA256 hash in devices.api_key_hash. The plaintext key is returned
 * to the admin ONCE at enrollment and never stored server-side.
 *
 * Hashing: HMAC-SHA256 with a pepper (AGENT_KEY_PEPPER env var, separate
 * from AGENT_SHARED_KEY). The pepper prevents offline brute-force even if
 * the DB is compromised. Constant-time comparison via crypto.timingSafeEqual.
 *
 * CC5: Per-device legacy fallback. If api_key_hash IS NULL for a device,
 * the agent auth falls back to AGENT_SHARED_KEY for that device only.
 * Once a device has an api_key_hash, the shared key stops working for it.
 *
 * CC6: No mandatory x-device-id header. The device is identified by
 * hash lookup: SELECT * FROM devices WHERE api_key_hash = $1.
 */

const crypto = require('crypto');

/**
 * Generate a new random API key (32 bytes, base64-encoded).
 * @returns {string} 44-char base64 key
 */
function generateApiKey() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Get the pepper for hashing API keys.
 * Falls back to AGENT_SHARED_KEY if AGENT_KEY_PEPPER is not set
 * (transitional — during migration, AGENT_SHARED_KEY is the pepper).
 * Supports _FILE convention: if AGENT_KEY_PEPPER_FILE is set, read from file.
 * @returns {string}
 */
function getPepper() {
  const fs = require('fs');
  const fileVar = process.env.AGENT_KEY_PEPPER_FILE;
  if (fileVar) {
    return fs.readFileSync(fileVar, 'utf8').trim();
  }
  return process.env.AGENT_KEY_PEPPER || process.env.AGENT_SHARED_KEY || '';
}

/**
 * Hash an API key using HMAC-SHA256 with a pepper.
 * @param {string} apiKey — plaintext base64 key
 * @returns {string} hex-encoded hash
 */
function hashApiKey(apiKey) {
  const pepper = getPepper();
  if (!pepper) {
    throw new Error('AGENT_KEY_PEPPER or AGENT_SHARED_KEY must be set for API key hashing');
  }
  return crypto
    .createHmac('sha256', pepper)
    .update(apiKey)
    .digest('hex');
}

/**
 * Verify an API key against a stored hash using constant-time comparison.
 * @param {string} apiKey — plaintext base64 key from the request header
 * @param {string} storedHash — hex-encoded hash from the DB
 * @returns {boolean} true if the key matches
 */
function verifyApiKey(apiKey, storedHash) {
  if (!apiKey || !storedHash) return false;
  const computedHash = hashApiKey(apiKey);
  // Use timingSafeEqual for constant-time comparison
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a legacy shared key (CC5 fallback for devices without api_key_hash).
 * Uses constant-time comparison.
 * @param {string} providedKey — key from the request header
 * @param {string} sharedKey — AGENT_SHARED_KEY from env
 * @returns {boolean}
 */
function verifySharedKey(providedKey, sharedKey) {
  if (!providedKey || !sharedKey) return false;
  const a = Buffer.from(providedKey);
  const b = Buffer.from(sharedKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateApiKey, hashApiKey, verifyApiKey, verifySharedKey };
