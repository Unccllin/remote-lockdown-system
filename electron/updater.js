/**
 * updater.js — Auto-update logic for the Electron admin app.
 *
 * Uses electron-updater to check for updates from GitHub Releases.
 * In development mode, auto-update is disabled.
 *
 * Flow:
 *   1. App starts → check for updates (after 10s delay)
 *   2. If update available → show notification to user
 *   3. User clicks "Update now" → download starts
 *   4. On download complete → prompt user to restart
 *   5. User clicks "Restart" → app quits and installs update
 *
 * GitHub Releases must be created with electron-builder's publish flow:
 *   npm run publish
 *
 * The release must include the latest.yml (Windows) / latest-mac.yml (macOS)
 * files that electron-builder generates automatically.
 */

const { app, dialog, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

// Use electron-log if available, otherwise console
let logger;
try {
  logger = require('electron-log');
  logger.transports.file.level = 'info';
  autoUpdater.logger = logger;
} catch (e) {
  logger = console;
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let updateInfo = null;
let mainWindow = null;

function initUpdater(window) {
  mainWindow = window;

  // Don't check for updates in development
  const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;
  if (isDev) {
    logger.info('[updater] Development mode — auto-update disabled');
    return;
  }

  logger.info('[updater] Initializing auto-updater...');

  // --- Event handlers ---

  autoUpdater.on('checking-for-update', () => {
    logger.info('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    logger.info('[updater] Update available:', info.version);
    updateInfo = info;

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${info.version}) is available.`,
      detail: `Current version: ${app.getVersion()}\n\nWould you like to download it now?`,
      buttons: ['Download Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        logger.info('[updater] User chose to download update');
        autoUpdater.downloadUpdate();
      } else {
        logger.info('[updater] User deferred update');
      }
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    logger.info('[updater] Up to date (version', app.getVersion() + ')');
  });

  autoUpdater.on('download-progress', (progress) => {
    logger.info(`[updater] Download progress: ${Math.round(progress.percent)}%`);
    // Could send to renderer for a progress bar
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info('[updater] Update downloaded:', info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(-1); // Reset progress bar
    }

    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: 'The update has been downloaded.',
      detail: 'The application will restart to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) {
        logger.info('[updater] User chose to restart and install');
        // setImmediate ensures the dialog closes before quitting
        setImmediate(() => {
          autoUpdater.quitAndInstall();
        });
      }
    });
  });

  autoUpdater.on('error', (err) => {
    logger.error('[updater] Error:', err.message);
    // Don't show error dialog — silent failure is better UX for updates
    // The user doesn't need to know if the update check failed
  });

  // Check for updates after a 10-second delay (let the app start first)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[updater] Failed to check for updates:', err.message);
    });
  }, 10000);

  // Check for updates every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.error('[updater] Periodic check failed:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
}

module.exports = { initUpdater };
