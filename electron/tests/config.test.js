const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createConfig,
  saveConfig,
  loadConfig,
  saveWorkerUrl,
  initConfig,
  configExists,
  getConfigPath,
} = require('../config');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config.js (serverless-only)', () => {
  describe('createConfig', () => {
    it('creates config with worker_url: null and created_at', () => {
      const config = createConfig();
      expect(config.worker_url).toBeNull();
      expect(config.created_at).toBeDefined();
    });

    it('creates config with a specific worker URL', () => {
      const url = 'https://worker.example.com/api';
      const config = createConfig(url);
      expect(config.worker_url).toBe(url);
    });
  });

  describe('saveWorkerUrl', () => {
    it('saves the worker URL to config', () => {
      const url = 'https://lockdown-serverless.example.workers.dev/api';
      const config = saveWorkerUrl(tmpDir, url);
      expect(config.worker_url).toBe(url);

      const loaded = loadConfig(tmpDir);
      expect(loaded.worker_url).toBe(url);
    });

    it('overwrites an existing worker URL', () => {
      saveWorkerUrl(tmpDir, 'https://old-worker.example.com/api');
      expect(loadConfig(tmpDir).worker_url).toBe('https://old-worker.example.com/api');

      const config = saveWorkerUrl(tmpDir, 'https://new-worker.example.com/api');
      expect(config.worker_url).toBe('https://new-worker.example.com/api');
    });
  });

  describe('initConfig', () => {
    it('returns isFirstRun=true when no config exists', () => {
      const { config, isFirstRun } = initConfig(tmpDir);
      expect(isFirstRun).toBe(true);
      expect(config).toBeNull();
    });

    it('returns isFirstRun=true when config exists but has no worker_url', () => {
      // Simulate a config file without worker_url
      saveConfig(tmpDir, { created_at: '2026-01-01T00:00:00.000Z' });
      const { config, isFirstRun } = initConfig(tmpDir);
      expect(isFirstRun).toBe(true);
      expect(config.worker_url).toBeUndefined();
    });

    it('returns isFirstRun=false when config has worker_url', () => {
      saveWorkerUrl(tmpDir, 'https://worker.example.com/api');
      const { config, isFirstRun } = initConfig(tmpDir);
      expect(isFirstRun).toBe(false);
      expect(config.worker_url).toBe('https://worker.example.com/api');
    });
  });

  describe('getConfigPath', () => {
    it('returns path ending with config.json', () => {
      const p = getConfigPath(tmpDir);
      expect(p).toBe(path.join(tmpDir, 'config.json'));
    });
  });

  describe('configExists', () => {
    it('returns false when no config exists', () => {
      expect(configExists(tmpDir)).toBe(false);
    });

    it('returns true after saving config', () => {
      saveWorkerUrl(tmpDir, 'https://worker.example.com/api');
      expect(configExists(tmpDir)).toBe(true);
    });
  });
});
