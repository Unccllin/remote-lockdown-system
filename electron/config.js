/**
 * config.js — Persistent configuration for the Electron admin app.
 *
 * On first run, generates random security keys and saves them to a
 * config file in the Electron userData directory. On subsequent runs,
 * loads the config and sets environment variables before the server starts.
 *
 * The config file contains:
 *   - AGENT_KEY_PEPPER: pepper for per-device API key hashing
 *   - JWT_SECRET: secret for JWT signing
 *   - FIELD_ENCRYPTION_KEY: AES-256 key for encrypting sensitive DB fields
 *   - LOCATION_FIELD_KEY: AES-256 key for encrypting location data
 *   - AGENT_SHARED_KEY: transitional shared key (for legacy agents)
 *   - server_port: the port the Express server listens on
 *   - created_at: when the config was first created
 *
 * Security notes:
 *   - The config file is stored in the OS-specific userData directory:
 *       Windows: %APPDATA%/remote-lockdown-admin/config.json
 *       macOS:   ~/Library/Application Support/remote-lockdown-admin/config.json
 *       Linux:   ~/.config/remote-lockdown-admin/config.json
 *   - The file contains secrets and must not be committed to version control.
 *   - File permissions are set to 0600 (owner read/write only) on Unix.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILENAME = 'config.json';

/**
 * Generate a cryptographically random hex string of the given byte length.
 * 32 bytes = 256 bits = 64 hex chars (suitable for AES-256 keys and HMAC secrets).
 */
function generateKey(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a random alphanumeric password/key (for AGENT_SHARED_KEY).
 * 24 chars, mixed case + digits.
 */
function generateSharedKey(length = 24) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let key = '';
  for (let i = 0; i < length; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

/**
 * Get the path to the config file in the userData directory.
 * @param {string} userDataPath — Electron's app.getPath('userData')
 */
function getConfigPath(userDataPath) {
  return path.join(userDataPath, CONFIG_FILENAME);
}

/**
 * Check if a config file already exists.
 */
function configExists(userDataPath) {
  return fs.existsSync(getConfigPath(userDataPath));
}

/**
 * Create a new config with randomly generated keys.
 * @returns {object} config object
 */
function createConfig() {
  return {
    AGENT_KEY_PEPPER: generateKey(32),
    JWT_SECRET: generateKey(32),
    FIELD_ENCRYPTION_KEY: generateKey(32),
    LOCATION_FIELD_KEY: generateKey(32),
    AGENT_SHARED_KEY: generateSharedKey(32),
    server_port: 0, // 0 = OS picks an available port
    created_at: new Date().toISOString(),
  };
}

/**
 * Save config to the userData directory.
 * Sets file permissions to 0600 on Unix (owner read/write only).
 */
function saveConfig(userDataPath, config) {
  const configPath = getConfigPath(userDataPath);
  const dir = path.dirname(configPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write config file
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  // Set restrictive permissions on Unix (0600 = owner read/write only)
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o600);
  }

  console.log('[config] Saved to:', configPath);
  return configPath;
}

/**
 * Load config from the userData directory.
 * @returns {object|null} config object, or null if not found
 */
function loadConfig(userDataPath) {
  const configPath = getConfigPath(userDataPath);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    console.log('[config] Loaded from:', configPath);
    return config;
  } catch (err) {
    console.error('[config] Failed to load config:', err.message);
    return null;
  }
}

/**
 * Initialize config: load existing or create new.
 * Sets environment variables from the config.
 *
 * @param {string} userDataPath — Electron's app.getPath('userData')
 * @returns {{ config: object, isFirstRun: boolean }}
 */
function initConfig(userDataPath) {
  let config = loadConfig(userDataPath);
  let isFirstRun = false;

  if (!config) {
    console.log('[config] First run — generating new security keys...');
    config = createConfig();
    saveConfig(userDataPath, config);
    isFirstRun = true;
  }

  // Set environment variables from config
  process.env.AGENT_KEY_PEPPER = config.AGENT_KEY_PEPPER;
  process.env.JWT_SECRET = config.JWT_SECRET;
  process.env.FIELD_ENCRYPTION_KEY = config.FIELD_ENCRYPTION_KEY;
  process.env.LOCATION_FIELD_KEY = config.LOCATION_FIELD_KEY;
  process.env.AGENT_SHARED_KEY = config.AGENT_SHARED_KEY;
  process.env.PORT = String(config.server_port || 0);

  return { config, isFirstRun };
}

module.exports = {
  getConfigPath,
  configExists,
  createConfig,
  saveConfig,
  loadConfig,
  initConfig,
  generateKey,
  generateSharedKey,
};
