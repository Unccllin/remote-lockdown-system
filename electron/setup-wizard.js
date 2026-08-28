/**
 * setup-wizard.js — First-run setup wizard for Worker URL configuration.
 *
 * Shows a BrowserWindow with setup.html that asks the user for their
 * Cloudflare Worker URL. Validates the URL by fetching /health and
 * checking for `serverless: true`.
 *
 * Exports `showSetupWizard` which returns a Promise resolving to
 * `{ workerUrl }` when the user confirms.
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

/**
 * Show the setup wizard and wait for the user's Worker URL.
 *
 * @returns {Promise<{ workerUrl: string }>}
 */
function showSetupWizard() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 480,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Remote Lockdown Admin — Setup',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'setup-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.loadFile(path.join(__dirname, 'setup.html'));

    // Prevent closing without making a choice
    win.on('close', (e) => {
      e.preventDefault();
    });

    // Handle URL confirmation from the wizard
    const confirmHandler = (_event, workerUrl) => {
      win.removeAllListeners('close');
      win.close();
      ipcMain.removeListener('setup:confirm-url', confirmHandler);
      resolve({ workerUrl });
    };
    ipcMain.on('setup:confirm-url', confirmHandler);

    // Handle Worker URL validation requests
    const testHandler = async (_event, url) => {
      try {
        return await validateWorkerUrl(url);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };
    ipcMain.handle('setup:test-worker-url', testHandler);

    win.on('closed', () => {
      ipcMain.removeHandler('setup:test-worker-url');
    });
  });
}

/**
 * Validate a Worker URL by fetching /health and checking for serverless: true.
 *
 * @param {string} url — the Worker URL (may or may not end with /api)
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function validateWorkerUrl(url) {
  if (!url || !url.trim()) {
    return { ok: false, error: 'URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, error: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'URL must use http or https protocol' };
  }

  // Fetch /health from the Worker. The URL may or may not include /api.
  const base = url.trim().replace(/\/$/, '');
  const candidates = [
    base.replace(/\/api$/, '') + '/health',
    base + '/health',
    base + '/api/health',
  ];

  for (const healthUrl of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) continue;

      const data = await res.json();
      if (data.serverless === true) {
        return { ok: true };
      }
      return { ok: false, error: 'This URL does not appear to be a serverless Worker (no serverless: true in /health response)' };
    } catch {
      continue;
    }
  }

  return { ok: false, error: 'Could not reach the Worker URL. Check the URL and your internet connection.' };
}

module.exports = { showSetupWizard, validateWorkerUrl };
