/**
 * config.js — Persistent configuration for the Electron admin app.
 *
 * The Electron app is a serverless desktop shell — all API calls go to a
 * Cloudflare Worker. The only config we need is the Worker URL.
 *
 * On first run, the setup wizard asks for the Worker URL. On subsequent
 * runs, the config is loaded and the Worker URL is used.
 *
 * The config file contains:
 *   - worker_url: the Cloudflare Worker API URL (e.g. https://worker.dev/api)
 *   - created_at: when the config was first created
 *
 * Config file location (OS-specific userData directory):
 *   Windows: %APPDATA%/remote-lockdown-admin/config.json
 *   macOS:   ~/Library/Application Support/remote-lockdown-admin/config.json
 *   Linux:   ~/.config/remote-lockdown-admin/config.json
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = 'config.json';

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
 * Create a new config with the given Worker URL.
 * @param {string} workerUrl — the Cloudflare Worker API URL
 * @returns {object} config object
 */
function createConfig(workerUrl = null) {
  return {
    worker_url: workerUrl,
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

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

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
    console.error('[config] Failed to load config:', err.message, 'Fix: verify the config file exists at the expected path and contains valid JSON.');
    return null;
  }
}

/**
 * Save the Worker URL to config.
 * Called by the setup wizard after the user confirms the URL.
 * @param {string} userDataPath — Electron's app.getPath('userData')
 * @param {string} workerUrl — the Cloudflare Worker API URL
 * @returns {object} the updated config
 */
function saveWorkerUrl(userDataPath, workerUrl) {
  const existing = loadConfig(userDataPath) || createConfig();
  const updated = { ...existing, worker_url: workerUrl };
  saveConfig(userDataPath, updated);
  return updated;
}

/**
 * Initialize config: load existing or return null (first run).
 *
 * @param {string} userDataPath — Electron's app.getPath('userData')
 * @returns {{ config: object|null, isFirstRun: boolean }}
 */
function initConfig(userDataPath) {
  const config = loadConfig(userDataPath);
  const isFirstRun = !config || !config.worker_url;

  if (isFirstRun) {
    console.log('[config] First run — setup wizard will ask for Worker URL...');
  }

  return { config, isFirstRun };
}

module.exports = {
  getConfigPath,
  configExists,
  createConfig,
  saveConfig,
  loadConfig,
  saveWorkerUrl,
  initConfig,
};
