/**
 * fieldCrypto — higher-level helpers for encrypting/decrypting sensitive
 * DB fields (encryption_keys.key_material, bios_passwords.password).
 *
 * Wraps the low-level crypto.js primitives with the FIELD_ENCRYPTION_KEY.
 *
 * A3: Encryption at rest for key material and BIOS passwords.
 * CC16: Dual-mode read — if encrypted columns are populated, decrypt;
 *       if not (legacy plaintext row), return the plaintext column as-is.
 *       This allows a backfill migration to run while the read code
 *       already handles both formats.
 */

const { encrypt, decrypt, getKey } = require('./crypto');

/**
 * Encrypt a plaintext value for storage at rest.
 * Returns { ciphertext, nonce, tag } all as base64 strings (for TEXT columns).
 */
function encryptField(plaintext, keyEnvVar = 'FIELD_ENCRYPTION_KEY') {
  const key = getKey(keyEnvVar);
  const { ciphertext, nonce, tag } = encrypt(plaintext, key);
  return {
    ciphertext,
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt a value from encrypted DB columns.
 * @param {string|null} ciphertextB64
 * @param {string|null} nonceB64
 * @param {string|null} tagB64
 * @returns {string} plaintext
 */
function decryptField(ciphertextB64, nonceB64, tagB64, keyEnvVar = 'FIELD_ENCRYPTION_KEY') {
  if (!ciphertextB64 || !nonceB64 || !tagB64) return null;
  const key = getKey(keyEnvVar);
  return decrypt(
    ciphertextB64,
    Buffer.from(nonceB64, 'base64'),
    key,
    Buffer.from(tagB64, 'base64')
  );
}

/**
 * CC16: Dual-mode read — decrypt if encrypted columns exist, fall back to plaintext.
 * @param {object} row — DB row with both encrypted and plaintext columns
 * @param {string} plaintextCol — e.g. 'key_material'
 * @param {string} encCol — e.g. 'key_material_encrypted'
 * @param {string} nonceCol — e.g. 'key_enc_nonce'
 * @param {string} tagCol — e.g. 'key_enc_tag'
 * @returns {string|null} the plaintext value
 */
function readDualMode(row, plaintextCol, encCol, nonceCol, tagCol, keyEnvVar = 'FIELD_ENCRYPTION_KEY') {
  if (!row) return null;
  // If encrypted columns are populated, decrypt
  if (row[encCol] && row[nonceCol] && row[tagCol]) {
    return decryptField(row[encCol], row[nonceCol], row[tagCol], keyEnvVar);
  }
  // Fall back to plaintext column (legacy row, pre-backfill)
  return row[plaintextCol] || null;
}

module.exports = { encryptField, decryptField, readDualMode };
