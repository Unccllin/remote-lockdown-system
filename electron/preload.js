/**
 * preload.js — Electron preload script.
 *
 * Runs in the renderer process with Node.js access, before the page loads.
 * We use contextBridge to expose a minimal, safe API to the renderer.
 *
 * The dashboard communicates with the backend via HTTP/fetch. In local mode,
 * the backend is the bundled Express server (same-origin /api). In serverless
 * mode, the backend is a Cloudflare Worker, and the API base URL is injected
 * here so the dashboard's axios client can use it at runtime.
 */
const { contextBridge } = require('electron');

// The API base URL is set by main.js before the window loads.
// In local mode: null (dashboard falls back to same-origin /api).
// In serverless mode: the Worker URL (e.g. 'https://worker.dev/api').
const apiBaseUrl = process.env.ELECTRON_API_BASE_URL || null;

// Set by main.js from app.getVersion() before the window loads. The npm_package_version
// fallback only covers `npm start`; a packaged build has the env var, so the UI reports the
// version that was actually packaged instead of a hardcoded guess.
contextBridge.exposeInMainWorld('electronApp', {
  version: process.env.ELECTRON_APP_VERSION || process.env.npm_package_version || '',
  platform: process.platform,
  isElectron: true,
  apiBaseUrl,
});
