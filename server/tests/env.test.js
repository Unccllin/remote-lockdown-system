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

const { validateEnv } = require('../src/config/env');

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
});
