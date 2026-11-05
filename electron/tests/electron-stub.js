/**
 * Jest stub for the `electron` module (S246).
 *
 * Why this exists
 * ---------------
 * The tests run in Node, not in the Electron runtime, but `main.js` does
 * `require('electron')`. Before this stub the suite depended on the Electron *binary*
 * having been downloaded by the package's postinstall — so an upgrade whose binary could
 * not be fetched (Electron 42's install.js is ESM and refuses to run under Node 20, which
 * is what this host has) turned a unit-test run into
 * "Electron failed to install correctly. Please delete node_modules/electron…".
 *
 * A unit test should not need a 100 MB browser binary to check URL validation. The stub
 * provides the API surface `main.js` touches; anything else it grows should be added here
 * deliberately rather than reached through the real module.
 */

const noop = () => {};
const fn = () => jest.fn();

const app = {
  whenReady: () => Promise.resolve(),
  on: noop,
  once: noop,
  quit: noop,
  exit: noop,
  getPath: () => '/tmp',
  getName: () => 'lockdown-electron',
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  setAppUserModelId: noop,
  setName: noop,
};

class BrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this.webContents = {
      on: noop,
      once: noop,
      send: noop,
      setWindowOpenHandler: noop,
      session: { webRequest: { onBeforeRequest: noop } },
    };
    this.loadedUrls = [];
  }

  loadURL(url) {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }

  loadFile(file) {
    this.loadedUrls.push(file);
    return Promise.resolve();
  }

  on() {
    return this;
  }

  once() {
    return this;
  }

  show = noop;
  focus = noop;
  isMinimized = () => false;
  restore = noop;
  destroy = noop;
  close = noop;
  isDestroyed = () => false;
  setMenu = noop;
  static getAllWindows() {
    return [];
  }
}

module.exports = {
  app,
  BrowserWindow,
  shell: { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve() },
  dialog: { showErrorBox: noop, showMessageBox: () => Promise.resolve({ response: 0 }) },
  ipcMain: { on: noop, once: noop, handle: noop, removeHandler: noop },
  Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
  Tray: class {
    setToolTip = noop;
    setContextMenu = noop;
    on = noop;
  },
  session: { defaultSession: { webRequest: { onBeforeRequest: noop } } },
  nativeTheme: { on: noop, shouldUseDarkColors: false },
  Notification: class {
    show = noop;
  },
  // Exposed so a test can assert something was called if it ever needs to.
  __jest: fn,
};
