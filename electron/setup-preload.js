/**
 * setup-preload.js — Preload script for the first-run setup wizard window.
 *
 * Exposes a minimal IPC channel for the wizard to communicate the user's
 * mode selection back to the main process. The wizard page calls
 * `window.wizardAPI.selectMode(mode, workerUrl)` when the user confirms.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wizardAPI', {
  selectMode: (mode, workerUrl) => ipcRenderer.send('setup:select-mode', { mode, workerUrl }),
  testWorkerUrl: (url) => ipcRenderer.invoke('setup:test-worker-url', url),
});
