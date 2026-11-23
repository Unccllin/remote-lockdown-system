/**
 * Regression tests for the canonical SQLite path resolver.
 *
 * The bug these lock down: both the dev entry and sqlitePool.js used to default
 * to a cwd-relative path (and disagreed about the filename), so launching the
 * dev server from a different directory created a brand-new empty database that
 * the dev entry then seeded with a second `admin` super-admin. Resolving from
 * dbPath.js means one launch can only ever mean one database.
 */

const path = require('path');

const {
  resolveDbPath,
  defaultDbPath,
  DEFAULT_DB_FILE,
  SERVER_ROOT,
} = require('../src/db/dbPath');

describe('dbPath', () => {
  it('defaults to the dev database inside the server directory', () => {
    expect(DEFAULT_DB_FILE).toBe('lockdown-dev.db');
    expect(defaultDbPath()).toBe(
      path.join(SERVER_ROOT, '.sqlite-data', 'lockdown-dev.db')
    );
    expect(path.isAbsolute(defaultDbPath())).toBe(true);
  });

  it('returns the same path regardless of the current working directory', () => {
    const originalCwd = process.cwd();
    const fromRepoRoot = resolveDbPath({});

    try {
      process.chdir('/');
      expect(resolveDbPath({})).toBe(fromRepoRoot);
      process.chdir(SERVER_ROOT);
      expect(resolveDbPath({})).toBe(fromRepoRoot);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('passes :memory: through untouched', () => {
    expect(resolveDbPath({ SQLITE_PATH: ':memory:' })).toBe(':memory:');
  });

  it('keeps absolute overrides exactly as given', () => {
    expect(resolveDbPath({ SQLITE_PATH: '/tmp/custom.db' })).toBe('/tmp/custom.db');
  });

  it('resolves relative overrides against the server directory, not the cwd', () => {
    const originalCwd = process.cwd();

    try {
      process.chdir('/');
      expect(resolveDbPath({ SQLITE_PATH: './.sqlite-data/other.db' })).toBe(
        path.join(SERVER_ROOT, '.sqlite-data', 'other.db')
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});
