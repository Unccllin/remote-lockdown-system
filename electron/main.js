/**
 * main.js — Electron main process.
 *
 * This is the entry point for the Admin desktop app. It:
 *   1. Initializes config (load existing or generate new on first run)
 *   2. If mode is not yet chosen (first run), shows the setup wizard
 *   3. Based on the selected mode:
 *      - Local: starts the full Express server (API + SQLite + dashboard)
 *      - Serverless: starts a static-only server (dashboard UI only, API
 *        calls go to the Cloudflare Worker)
 *   4. Creates a BrowserWindow and loads the dashboard
 *   5. Handles app lifecycle (single instance, window management)
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { initConfig, saveMode } = require('./config');

// Keep a global reference to prevent garbage collection
let mainWindow = null;
let serverInfo = null;
let isFirstRun = false;
let appMode = null; // 'local' | 'serverless'

// --- Paths ---
function getSqlitePath() {
  const userDataPath = app.getPath('userData');
  const dbDir = path.join(userDataPath, 'database');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'lockdown.db');
}

function getDashboardDistPath() {
  // In production: dashboard files are bundled alongside the app
  // In dev: we'll use the Vite dev server (port 5173)
  const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;

  if (isDev) {
    return null; // Use Vite dev server in dev mode
  }

  // Production: look for dashboard/dist relative to the app
  const candidates = [
    path.join(__dirname, '..', 'dashboard', 'dist'),
    path.join(process.resourcesPath, 'dashboard', 'dist'),
    path.join(__dirname, 'dashboard', 'dist'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  console.error('[main] Dashboard dist not found. Checked:', candidates);
  return null;
}

// --- Single instance lock ---
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[main] Another instance is already running. Quitting.');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus the existing window when a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// --- Window creation ---
function createWindow(serverPort) {
  const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Remote Lockdown Admin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    // Security: prevent the window from being used as a drag-and-drop target
    // for arbitrary files (which could be used to extract file paths)
    show: false, // Show after ready-to-show to prevent white flash
  });

  // Load the dashboard
  if (isDev) {
    // Dev mode: load from Vite dev server
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    // Open DevTools in dev
    mainWindow.webContents.openDevTools();
  } else {
    // Production: load from the local server (full or static-only)
    mainWindow.loadURL(`http://localhost:${serverPort}`);
  }

  // Show window when ready (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in the default browser (not in Electron)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Prevent navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigins = isDev
      ? ['http://localhost:5173', 'http://localhost:3001']
      : [`http://localhost:${serverPort}`];

    const isAllowed = allowedOrigins.some((origin) => url.startsWith(origin));
    if (!isAllowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- App lifecycle ---
app.whenReady().then(async () => {
  try {
    // Initialize config (load existing or generate new on first run)
    const userDataPath = app.getPath('userData');
    let { config, isFirstRun: firstRun } = initConfig(userDataPath);
    isFirstRun = firstRun;
    console.log('[main] First run:', isFirstRun);

    // If mode is not yet chosen, show the setup wizard
    if (!config.mode) {
      console.log('[main] Mode not selected — showing setup wizard...');
      const { showSetupWizard } = require('./setup-wizard');
      const { mode, workerUrl } = await showSetupWizard();
      config = saveMode(userDataPath, mode, workerUrl);
      console.log(`[main] Mode selected: ${mode}${workerUrl ? ` (${workerUrl})` : ''}`);
    }

    appMode = config.mode;
    const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;
    const dashboardDistPath = getDashboardDistPath();

    if (appMode === 'serverless') {
      // --- Serverless mode ---
      // Set the API base URL for the preload script to inject into the dashboard.
      // The dashboard's axios client will use this instead of same-origin /api.
      process.env.ELECTRON_API_BASE_URL = config.serverless_worker_url;
      console.log('[main] Serverless mode — API base URL:', config.serverless_worker_url);

      // Start a static-only server (serves dashboard UI, no API routes)
      const { startStaticServer } = require('./server-starter');
      serverInfo = await startStaticServer({ dashboardDistPath });
      console.log(`[main] Static server started on port ${serverInfo.port}`);
    } else {
      // --- Local mode (default) ---
      // Set SQLite path for the bundled Express server
      process.env.SQLITE_PATH = getSqlitePath();
      console.log('[main] SQLite path:', process.env.SQLITE_PATH);

      // Start the full Express server (API + SQLite + dashboard)
      const { startServer } = require('./server-starter');
      serverInfo = await startServer({
        isDev,
        dashboardDistPath,
        // Don't seed admin via server-starter — the setup wizard handles it
      });
      console.log(`[main] Server started on port ${serverInfo.port}`);
    }

    // Create the browser window
    createWindow(serverInfo.port);

    // Phase 6: Initialize auto-updater (only works in production)
    try {
      const { initUpdater } = require('./updater');
      initUpdater(mainWindow);
    } catch (err) {
      console.warn('[main] Auto-updater not available:', err.message);
    }
  } catch (err) {
    console.error('[main] Failed to start:', err);
    // Show an error dialog and quit
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start the admin app:\n\n${err.message}\n\nFix: check that the dashboard is built, the server port is not in use, and all required environment variables are set. The application will now quit.`
    );
    app.quit();
  }
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// On macOS, re-create window when dock icon is clicked
app.on('activate', () => {
  if (mainWindow === null && serverInfo) {
    createWindow(serverInfo.port);
  }
});

// Clean up server on quit
app.on('before-quit', async () => {
  if (serverInfo) {
    try {
      serverInfo.server.close();
      if (serverInfo.pool) {
        await serverInfo.pool.end();
      }
    } catch (e) {
      // Ignore errors during shutdown
    }
  }
});
