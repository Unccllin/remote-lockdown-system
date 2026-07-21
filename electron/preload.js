/**
 * preload.js — Electron preload script.
 *
 * Runs in the renderer process with Node.js access, before the page loads.
 * We use contextBridge to expose a minimal, safe API to the renderer.
 *
 * The dashboard doesn't need any Electron-specific APIs (it communicates
 * with the server via HTTP/fetch), so the preload is intentionally minimal.
 * It only exposes app info for display purposes.
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronApp', {
  version: process.env.npm_package_version || '1.0.0',
  platform: process.platform,
  isElectron: true,
});
