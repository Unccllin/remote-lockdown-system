/**
 * Shared AES-256-GCM encryption primitives for field-level encryption at rest.
 *
 * Used by:
 *   - FA2 (DB integrity): encrypts encryption_keys.key_material and bios_passwords.password
 *   - FA5 (privacy): encrypts location_reports city/region/country/ip_address
 *
 * Consensus CC1: ONE shared module. Callers pass their own key (different env vars
 * for different data classes = different blast radii).
 *
 * Key format: 32-byte (256-bit) key, provided as hex (64 chars) via env var.
 *   FIELD_ENCRYPTION_KEY  — for key material / BIOS passwords (FA2)
 *   LOCATION_FIELD_KEY    — for location PII fields (FA5)
 *
 * Supports the _FILE convention (CC12): if <NAME>_FILE is set, the key is read
 * from that file path instead of the env var directly. This lets Docker mounts
 * and KMS-backed secrets files provide the key without it appearing in env.
 */

const crypto = require('crypto');
const fs = require('fs');

/**
 * Resolve an encryption key from env, supporting the _FILE convention.
 * @param {string} envVarName — e.g. 'FIELD_ENCRYPTION_KEY'
 * @returns {Buffer} 32-byte key
 */
function resolveKey(envVarName) {
  const fileVar = process.env[`${envVarName}_FILE`];
  let hexKey;
  if (fileVar) {
    hexKey = fs.readFileSync(fileVar, 'utf8').trim();
  } else {
    hexKey = process.env[envVarName];
  }

  if (!hexKey) {
    throw new Error(`${envVarName} (or ${envVarName}_FILE) is required for encryption at rest`);
  }

  // Accept either hex (64 chars = 32 bytes) or base64 (44 chars = 32 bytes)
  let keyBuf;
  if (/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    keyBuf = Buffer.from(hexKey, 'hex');
  } else {
    keyBuf = Buffer.from(hexKey, 'base64');
    if (keyBuf.length !== 32) {
      throw new Error(`${envVarName} must be a 32-byte key (64 hex chars or 44 base64 chars)`);
    }
  }

  if (keyBuf.length !== 32) {
    throw new Error(`${envVarName} must be exactly 32 bytes (got ${keyBuf.length})`);
  }

  return keyBuf;
}

// Cache resolved keys by env var name
const _keyCache = new Map();

/**
 * Get (or cache) the encryption key for a given env var.
 * Keys are cached at first use; call clearKeyCache() in tests if needed.
 */
function getKey(envVarName) {
  if (!_keyCache.has(envVarName)) {
    _keyCache.set(envVarName, resolveKey(envVarName));
  }
  return _keyCache.get(envVarName);
}

/** Clear the key cache (for testing). */
function clearKeyCache() {
  _keyCache.clear();
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext
 * @param {Buffer} key — 32-byte key (from getKey())
 * @returns {{ ciphertext: string, nonce: Buffer, tag: Buffer }}
 *   - ciphertext: base64-encoded
 *   - nonce: 12-byte Buffer (store as BYTEA)
 *   - tag: 16-byte Buffer (store as BYTEA)
 */
function encrypt(plaintext, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString('base64'),
    nonce,
    tag,
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @param {string} ciphertextB64 — base64-encoded ciphertext
 * @param {Buffer} nonce — 12-byte nonce (from DB BYTEA column)
 * @param {Buffer} tag — 16-byte auth tag (from DB BYTEA column)
 * @param {Buffer} key — 32-byte key
 * @returns {string} plaintext
 * @throws if auth tag verification fails (tampered ciphertext or wrong key)
 */
function decrypt(ciphertextB64, nonce, key, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce));
  decipher.setAuthTag(Buffer.from(tag));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt, getKey, resolveKey, clearKeyCache };
