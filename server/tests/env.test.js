/**
 * Tests for src/config/env.js — central environment variable validation.
 *
 * Covers:
 *   - Valid production config passes
 *   - Placeholder values rejected in production
 *   - Short secrets rejected in production
 *   - Missing required env var rejected in production
 *   - _FILE convention reads from file (and fails if file missing)
 *   - Non-production guard (ALLOW_NON_PROD)
 *   - LOCATION_RETENTION_DAYS range warning
 *   - Multiple errors collected
 *   - DB_SSL_VERIFY validation
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateEnv, resolveFileSecrets } = require('../src/config/env');

// Valid 32-byte hex key (64 hex chars)
const VALID_HEX_KEY = 'a'.repeat(64);
// Valid 32-char secret
const VALID_SECRET = 'x'.repeat(40);

const PROD_ENV = {
  NODE_ENV: 'production',
  JWT_SECRET: VALID_SECRET,
  FIELD_ENCRYPTION_KEY: VALID_HEX_KEY,
  LOCATION_FIELD_KEY: VALID_HEX_KEY,
  AGENT_SHARED_KEY: VALID_SECRET,
  AGENT_KEY_PEPPER: VALID_SECRET,
  DATABASE_URL: 'postgres://user:pass@localhost/db',
};

function setEnv(env) {
  for (const k of Object.keys(env)) {
    process.env[k] = env[k];
  }
}

function clearEnvKeys(keys) {
  for (const k of keys) {
    delete process.env[k];
  }
}

// All env vars we might touch across tests
const ALL_ENV_KEYS = [
  'NODE_ENV',
  'JWT_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_KEY_FILE',
  'LOCATION_FIELD_KEY',
  'LOCATION_FIELD_KEY_FILE',
  'AGENT_SHARED_KEY',
  'AGENT_KEY_PEPPER',
  'AGENT_KEY_PEPPER_FILE',
  'DATABASE_URL',
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'DB_SSL_VERIFY',
  'USE_SQLITE',
  'JWT_SECRET_FILE',
  'AGENT_SHARED_KEY_FILE',
  'AGENT_KEY_PEPPER_FILE',
  'FIELD_ENCRYPTION_KEY_FILE',
  'LOCATION_FIELD_KEY_FILE',
  'SQLITE_PATH',
  'LOCATION_RETENTION_DAYS',
  'ALLOW_NON_PROD',
];

describe('env.js — validateEnv', () => {
  let exitSpy;
  let errorSpy;
  let warnSpy;

  beforeEach(() => {
    // Clear all relevant env vars, then set a valid baseline.
    clearEnvKeys(ALL_ENV_KEYS);
    setEnv(PROD_ENV);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const logger = require('../src/logger');
    errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    clearEnvKeys(ALL_ENV_KEYS);
    jest.restoreAllMocks();
  });

  test('valid config passes in production mode (no exit)', () => {
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('placeholder JWT_SECRET fails in production', () => {
    process.env.JWT_SECRET = 'change_this_to_a_long_random_secret';
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('short secret (< 32 chars) fails in production', () => {
    process.env.JWT_SECRET = 'tooshort';
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('missing required env var (JWT_SECRET) fails in production', () => {
    delete process.env.JWT_SECRET;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('_FILE convention reads from file (skips value check)', () => {
    const tmp = path.join(os.tmpdir(), `env-test-${Date.now()}.key`);
    fs.writeFileSync(tmp, VALID_HEX_KEY);
    process.env.FIELD_ENCRYPTION_KEY_FILE = tmp;
    delete process.env.FIELD_ENCRYPTION_KEY;
    expect(() => validateEnv()).not.toThrow();
    fs.unlinkSync(tmp);
  });

  test('_FILE convention fails if file does not exist (production)', () => {
    process.env.FIELD_ENCRYPTION_KEY_FILE = '/nonexistent/path/key.txt';
    delete process.env.FIELD_ENCRYPTION_KEY;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('non-production without ALLOW_NON_PROD fails', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOW_NON_PROD;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('non-production with ALLOW_NON_PROD=1 passes (with warnings)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_NON_PROD = '1';
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('LOCATION_RETENTION_DAYS out of range warns (not fatal)', () => {
    process.env.LOCATION_RETENTION_DAYS = '5';
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('multiple errors collected and reported (all in one exit)', () => {
    delete process.env.JWT_SECRET;
    delete process.env.FIELD_ENCRYPTION_KEY;
    delete process.env.LOCATION_FIELD_KEY;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // error logger called once with an array of errors
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const callArg = errorSpy.mock.calls[0][0];
    expect(callArg.errors).toBeInstanceOf(Array);
    expect(callArg.errors.length).toBeGreaterThanOrEqual(3);
  });

  test('DB_SSL_VERIFY invalid value warns', () => {
    process.env.DB_SSL_VERIFY = 'yes';
    expect(() => validateEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('DB_SSL_VERIFY=true passes without warning', () => {
    process.env.DB_SSL_VERIFY = 'true';
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // Regression: USE_SQLITE=true + NODE_ENV=production used to demand Postgres
  // credentials, so `docker-compose.test.yml` (production + SQLite, no DB vars)
  // exited at boot with "DB_HOST is required...". SQLite serves every query
  // from a file, so those vars are irrelevant in that mode.
  test('USE_SQLITE=true in production does not require Postgres vars', () => {
    delete process.env.DATABASE_URL;
    process.env.USE_SQLITE = 'true';
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('USE_SQLITE unset in production still requires Postgres vars', () => {
    delete process.env.DATABASE_URL;
    delete process.env.USE_SQLITE;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('env.js — _FILE secret resolution (CC12)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let exitSpy;
  let tmpDir;

  beforeEach(() => {
    clearEnvKeys(ALL_ENV_KEYS);
    setEnv(PROD_ENV);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Regression: JWT_SECRET_FILE had no consumer at all, so docker-compose.yml
  // (which passes only the *_FILE variants) left JWT_SECRET undefined and every
  // login threw "secretOrPrivateKey must have a value".
  test('JWT_SECRET_FILE is loaded into JWT_SECRET', () => {
    const value = 'x'.repeat(48);
    const file = path.join(tmpDir, 'jwt');
    fs.writeFileSync(file, value + '\n'); // trailing newline must be trimmed
    delete process.env.JWT_SECRET;
    process.env.JWT_SECRET_FILE = file;

    const resolved = resolveFileSecrets();

    expect(resolved).toContain('JWT_SECRET');
    expect(process.env.JWT_SECRET).toBe(value);
  });

  test('an explicit variable wins over its _FILE', () => {
    const file = path.join(tmpDir, 'jwt');
    fs.writeFileSync(file, 'y'.repeat(48));
    process.env.JWT_SECRET_FILE = file;
    process.env.JWT_SECRET = 'explicit-value-that-must-survive';

    resolveFileSecrets();

    expect(process.env.JWT_SECRET).toBe('explicit-value-that-must-survive');
  });

  test('a missing _FILE leaves the variable unset so validation reports it', () => {
    delete process.env.JWT_SECRET;
    process.env.JWT_SECRET_FILE = path.join(tmpDir, 'nope');
    expect(() => resolveFileSecrets()).not.toThrow();
    expect(process.env.JWT_SECRET).toBeUndefined();
  });

  test('validateEnv succeeds with all secrets supplied as files', () => {
    const names = ['JWT_SECRET', 'AGENT_SHARED_KEY', 'AGENT_KEY_PEPPER'];
    for (const name of names) {
      const file = path.join(tmpDir, name);
      fs.writeFileSync(file, 'z'.repeat(64));
      delete process.env[name];
      process.env[`${name}_FILE`] = file;
    }
    expect(() => validateEnv()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.env.JWT_SECRET).toHaveLength(64);
  });
});
