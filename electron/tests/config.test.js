const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createConfig,
  saveConfig,
  loadConfig,
  updateConfig,
  saveMode,
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
  // Clean up env vars set by initConfig
  delete process.env.AGENT_KEY_PEPPER;
  delete process.env.JWT_SECRET;
  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.LOCATION_FIELD_KEY;
  delete process.env.AGENT_SHARED_KEY;
  delete process.env.PORT;
});

describe('config.js dual-mode fields', () => {
  describe('createConfig', () => {
    it('creates config with mode: null and serverless_worker_url: null', () => {
      const config = createConfig();
      expect(config.mode).toBeNull();
      expect(config.serverless_worker_url).toBeNull();
    });

    it('generates all security keys', () => {
      const config = createConfig();
      expect(config.AGENT_KEY_PEPPER).toHaveLength(64);
      expect(config.JWT_SECRET).toHaveLength(64);
      expect(config.FIELD_ENCRYPTION_KEY).toHaveLength(64);
      expect(config.LOCATION_FIELD_KEY).toHaveLength(64);
      expect(config.AGENT_SHARED_KEY).toHaveLength(32);
    });
  });

  describe('saveMode', () => {
    it('saves local mode with null worker URL', () => {
      const config = saveMode(tmpDir, 'local');
      expect(config.mode).toBe('local');
      expect(config.serverless_worker_url).toBeNull();

      const loaded = loadConfig(tmpDir);
      expect(loaded.mode).toBe('local');
      expect(loaded.serverless_worker_url).toBeNull();
    });

    it('saves serverless mode with worker URL', () => {
      const url = 'https://lockdown-serverless.example.workers.dev/api';
      const config = saveMode(tmpDir, 'serverless', url);
      expect(config.mode).toBe('serverless');
      expect(config.serverless_worker_url).toBe(url);

      const loaded = loadConfig(tmpDir);
      expect(loaded.mode).toBe('serverless');
      expect(loaded.serverless_worker_url).toBe(url);
    });

    it('clears worker URL when switching from serverless to local', () => {
      // First save as serverless
      saveMode(tmpDir, 'serverless', 'https://worker.example.com/api');
      expect(loadConfig(tmpDir).serverless_worker_url).toBe('https://worker.example.com/api');

      // Switch to local
      const config = saveMode(tmpDir, 'local');
      expect(config.mode).toBe('local');
      expect(config.serverless_worker_url).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('merges partial config into existing config', () => {
      // Create initial config
      const initial = createConfig();
      saveConfig(tmpDir, initial);

      // Update only the mode
      const updated = updateConfig(tmpDir, { mode: 'serverless' });
      expect(updated.mode).toBe('serverless');
      // Other fields preserved
      expect(updated.AGENT_KEY_PEPPER).toBe(initial.AGENT_KEY_PEPPER);
      expect(updated.JWT_SECRET).toBe(initial.JWT_SECRET);
    });

    it('creates config if none exists', () => {
      const updated = updateConfig(tmpDir, { mode: 'local' });
      expect(updated.mode).toBe('local');
      expect(updated.AGENT_KEY_PEPPER).toBeDefined();
      expect(configExists(tmpDir)).toBe(true);
    });
  });

  describe('initConfig backfill', () => {
    it('backfills mode: null for configs created before dual-mode support', () => {
      // Simulate an old config without mode field
      const oldConfig = {
        AGENT_KEY_PEPPER: 'a'.repeat(64),
        JWT_SECRET: 'b'.repeat(64),
        FIELD_ENCRYPTION_KEY: 'c'.repeat(64),
        LOCATION_FIELD_KEY: 'd'.repeat(64),
        AGENT_SHARED_KEY: 'e'.repeat(32),
        server_port: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      };
      saveConfig(tmpDir, oldConfig);

      const { config, isFirstRun } = initConfig(tmpDir);
      expect(isFirstRun).toBe(false);
      expect(config.mode).toBeNull();
      expect(config.serverless_worker_url).toBeNull();
      // Original keys preserved
      expect(config.AGENT_KEY_PEPPER).toBe('a'.repeat(64));
    });

    it('preserves existing mode when loading', () => {
      saveMode(tmpDir, 'serverless', 'https://worker.example.com/api');
      const { config } = initConfig(tmpDir);
      expect(config.mode).toBe('serverless');
      expect(config.serverless_worker_url).toBe('https://worker.example.com/api');
    });

    it('returns isFirstRun=true when no config exists', () => {
      const { config, isFirstRun } = initConfig(tmpDir);
      expect(isFirstRun).toBe(true);
      expect(config.mode).toBeNull();
      // Security keys generated
      expect(config.AGENT_KEY_PEPPER).toHaveLength(64);
    });

    it('sets environment variables from config', () => {
      const { config } = initConfig(tmpDir);
      expect(process.env.AGENT_KEY_PEPPER).toBe(config.AGENT_KEY_PEPPER);
      expect(process.env.JWT_SECRET).toBe(config.JWT_SECRET);
      expect(process.env.FIELD_ENCRYPTION_KEY).toBe(config.FIELD_ENCRYPTION_KEY);
      expect(process.env.LOCATION_FIELD_KEY).toBe(config.LOCATION_FIELD_KEY);
      expect(process.env.AGENT_SHARED_KEY).toBe(config.AGENT_SHARED_KEY);
    });
  });

  describe('getConfigPath', () => {
    it('returns path ending with config.json', () => {
      const p = getConfigPath(tmpDir);
      expect(p).toBe(path.join(tmpDir, 'config.json'));
    });
  });
});
