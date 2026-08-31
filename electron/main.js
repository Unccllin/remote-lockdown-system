/**
 * main.js — Electron main process.
 *
 * This is the entry point for the Admin desktop app. The app is a
 * serverless desktop shell — all API calls go to a Cloudflare Worker.
 * No local server, no database, no security keys.
 *
 * Flow:
 *   1. Load config (Worker URL from previous run)
 *   2. If no Worker URL configured (first run), show setup wizard
 *   3. Start a static-only server to serve the dashboard UI
 *   4. Inject the Worker URL via preload so the dashboard's axios client
 *      sends API calls to the Worker
 *   5. Create a BrowserWindow and load the dashboard
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { initConfig, saveWorkerUrl } = require('./config');

let mainWindow = null;
let serverInfo = null;

// --- Paths ---
function getDashboardDistPath() {
  const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;

  if (isDev) {
    return null; // Use Vite dev server in dev mode
  }

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
    show: true,
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(`http://localhost:${serverPort}`);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

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
    const userDataPath = app.getPath('userData');
    let { config, isFirstRun } = initConfig(userDataPath);

    // First run or no Worker URL — show setup wizard
    if (isFirstRun || !config.worker_url) {
      console.log('[main] No Worker URL configured — showing setup wizard...');
      const { showSetupWizard } = require('./setup-wizard');
      const { workerUrl } = await showSetupWizard();
      config = saveWorkerUrl(userDataPath, workerUrl);
      console.log('[main] Worker URL saved:', config.worker_url);
    }

    // Inject the Worker URL into the preload script
    process.env.ELECTRON_API_BASE_URL = config.worker_url;
    console.log('[main] API base URL:', config.worker_url);

    // In dev mode, load directly from the Vite dev server — no static server needed.
    // In production mode, start a static server to serve the built dashboard.
    const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;
    let serverPort = null;

    if (!isDev) {
      const dashboardDistPath = getDashboardDistPath();
      const { startStaticServer } = require('./server-starter');
      serverInfo = await startStaticServer({ dashboardDistPath });
      serverPort = serverInfo.port;
      console.log(`[main] Static server started on port ${serverInfo.port}`);
    } else {
      console.log('[main] Dev mode — loading from Vite dev server');
    }

    createWindow(serverPort);

    // Auto-updater (only works in production)
    try {
      const { initUpdater } = require('./updater');
      initUpdater(mainWindow);
    } catch (err) {
      console.warn('[main] Auto-updater not available:', err.message);
    }
  } catch (err) {
    console.error('[main] Failed to start:', err);
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start the admin app:\n\n${err.message}\n\nFix: check that the dashboard is built and the Worker URL is reachable. The application will now quit.`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null && serverInfo) {
    createWindow(serverInfo.port);
  }
});

app.on('before-quit', () => {
  if (serverInfo) {
    try {
      serverInfo.server.close();
    } catch (e) {
      // Ignore errors during shutdown
    }
  }
});
