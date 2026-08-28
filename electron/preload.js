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

contextBridge.exposeInMainWorld('electronApp', {
  version: process.env.npm_package_version || '1.0.0',
  platform: process.platform,
  isElectron: true,
  apiBaseUrl,
});
