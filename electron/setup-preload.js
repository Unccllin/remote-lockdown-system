/**
 * setup-preload.js — Preload script for the first-run setup wizard window.
 *
 * Exposes a minimal IPC channel for the wizard to communicate the Worker URL
 * back to the main process. The wizard page calls
 * `window.wizardAPI.confirmUrl(url)` when the user confirms.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wizardAPI', {
  confirmUrl: (url) => ipcRenderer.send('setup:confirm-url', url),
  testWorkerUrl: (url) => ipcRenderer.invoke('setup:test-worker-url', url),
});
