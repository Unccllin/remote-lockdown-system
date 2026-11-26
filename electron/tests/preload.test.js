/**
 * preload.js must tell the UI the version that was actually packaged.
 *
 * The version used to be `process.env.npm_package_version || '1.0.0'`. `npm_package_version` only
 * exists when the app is started through npm, so a packaged 1.0.5 build displayed 1.0.0 — the
 * S286 shape one layer down: an identity that cannot tell two builds apart, this time in the UI.
 * main.js now hands `app.getVersion()` over the same env channel it already uses for the API base
 * URL, and the fallback no longer invents a version.
 */

function bridgeWith(env) {
  const saved = {
    app: process.env.ELECTRON_APP_VERSION,
    npm: process.env.npm_package_version,
  };
  delete process.env.ELECTRON_APP_VERSION;
  delete process.env.npm_package_version;
  Object.assign(process.env, env);

  jest.resetModules();
  // Fresh registry so preload.js re-reads process.env. The stub is re-instantiated by that reset
  // too, so the exposures must be read from the instance preload actually used — not from one
  // captured before resetModules().
  let exposed;
  jest.isolateModules(() => {
    require('../preload');
    exposed = require('./electron-stub').__exposed;
  });

  if (saved.app === undefined) delete process.env.ELECTRON_APP_VERSION;
  else process.env.ELECTRON_APP_VERSION = saved.app;
  if (saved.npm === undefined) delete process.env.npm_package_version;
  else process.env.npm_package_version = saved.npm;

  return exposed.electronApp;
}

describe('preload bridge', () => {
  it('reports the version main.js hands it — the packaged version', () => {
    expect(bridgeWith({ ELECTRON_APP_VERSION: '1.0.5' }).version).toBe('1.0.5');
  });

  it('prefers that over npm_package_version when both exist', () => {
    const bridge = bridgeWith({ ELECTRON_APP_VERSION: '1.0.5', npm_package_version: '0.0.0-dev' });
    expect(bridge.version).toBe('1.0.5');
  });

  it('falls back to npm_package_version when started through npm', () => {
    expect(bridgeWith({ npm_package_version: '1.0.5' }).version).toBe('1.0.5');
  });

  it('does not invent a version when neither is set', () => {
    // An empty value is honest: "unknown" is visible, a hardcoded 1.0.0 is a lie that survives
    // every future bump.
    expect(bridgeWith({}).version).toBe('');
  });

  it('main.js supplies the packaged version rather than a literal', () => {
    // main.js is not imported by the suite (it creates windows), so this contract is pinned at
    // the source level: the env var must be set from app.getVersion(), not from a constant.
    const mainSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
    expect(mainSource).toMatch(/process\.env\.ELECTRON_APP_VERSION\s*=\s*app\.getVersion\(\)/);
  });
});
