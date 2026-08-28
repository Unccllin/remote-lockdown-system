/**
 * setup-wizard.js — First-run setup wizard for mode selection.
 *
 * Shows a BrowserWindow with setup.html that lets the user choose between
 * "Local Server" (bundled Express + SQLite) and "Cloud (Serverless)"
 * (Cloudflare Worker). For serverless mode, validates the Worker URL by
 * fetching /health and checking for `serverless: true`.
 *
 * Exports a single function `showSetupWizard` that returns a Promise
 * resolving to `{ mode, workerUrl }` when the user confirms their choice.
 */

const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

/**
 * Show the setup wizard and wait for the user's selection.
 *
 * @param {string} userDataPath — Electron's app.getPath('userData')
 * @returns {Promise<{ mode: 'local'|'serverless', workerUrl: string|null }>}
 */
function showSetupWizard() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 640,
      height: 720,
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

    // Load the setup wizard HTML
    win.loadFile(path.join(__dirname, 'setup.html'));

    // Prevent the user from closing the wizard without making a choice
    win.on('close', (e) => {
      // If the promise hasn't resolved yet, prevent close and let the
      // user make a selection. The window is only closed programmatically
      // after resolve.
      e.preventDefault();
    });

    // Handle mode selection from the wizard
    const selectHandler = (_event, { mode, workerUrl }) => {
      win.removeAllListeners('close');
      win.close();
      ipcMain.removeListener('setup:select-mode', selectHandler);
      resolve({ mode, workerUrl });
    };
    ipcMain.on('setup:select-mode', selectHandler);

    // Handle Worker URL validation requests from the wizard
    const testHandler = async (event, url) => {
      try {
        const result = await validateWorkerUrl(url);
        event.sender.send('setup:test-worker-url-result', result);
        // ipcRenderer.invoke expects a return value, not a send
        return result;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    };
    ipcMain.handle('setup:test-worker-url', testHandler);

    // Clean up handlers when window is closed
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
  // Try /health first (Worker root), then /api/health.
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
      // Response was OK but not serverless — might be an Express server
      return { ok: false, error: 'This URL does not appear to be a serverless Worker (no serverless: true in /health response)' };
    } catch {
      // Try next candidate URL
      continue;
    }
  }

  return { ok: false, error: 'Could not reach the Worker URL. Check the URL and your internet connection.' };
}

module.exports = { showSetupWizard, validateWorkerUrl };
