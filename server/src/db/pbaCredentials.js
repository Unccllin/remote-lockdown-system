/**
 * pbaCredentials.js — Shared utility for grouping PBA credentials by type.
 *
 * Extracted from routes/agent.js and routes/devices.js to eliminate
 * duplicated password_type discriminator logic. Both routes query
 * bios_passwords and need to pick the most recent credential of each
 * type (setup, power_on, bitlocker_pin, bitlocker_recovery).
 *
 * The query must already be sorted ORDER BY created_at DESC so the
 * first row of each type is the most recent.
 */

const { readDualMode } = require('./fieldCrypto');

/**
 * Group bios_password rows by password_type, returning the most recent
 * credential of each type.
 *
 * @param {Array<object>} rows - bios_passwords query rows (sorted by created_at DESC)
 * @returns {object} - { setup_password, power_on_password, bitlocker_pin, bitlocker_recovery_password }
 *   Each field is the decrypted password string, or null if no row of that type exists.
 */
function groupPbaCredentials(rows) {
  const credentials = {
    setup_password: null,
    power_on_password: null,
    bitlocker_pin: null,
    bitlocker_recovery_password: null,
  };

  for (const row of rows) {
    const pw = readDualMode(
      row,
      'password',
      'password_encrypted',
      'pw_enc_nonce',
      'pw_enc_tag'
    );
    // T8: password_type discriminator (defaults to 'setup' for pre-migration rows)
    const pwType = row.password_type || 'setup';
    if (pwType === 'setup' && !credentials.setup_password) {
      credentials.setup_password = pw;
    } else if (pwType === 'power_on' && !credentials.power_on_password) {
      credentials.power_on_password = pw;
    } else if (pwType === 'bitlocker_pin' && !credentials.bitlocker_pin) {
      credentials.bitlocker_pin = pw;
    } else if (pwType === 'bitlocker_recovery' && !credentials.bitlocker_recovery_password) {
      credentials.bitlocker_recovery_password = pw;
    }
  }

  return credentials;
}

module.exports = { groupPbaCredentials };
