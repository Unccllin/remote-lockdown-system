/**
 * Single source of truth for the local SQLite database path.
 *
 * Why this module exists
 * ----------------------
 * The dev entry (`dev-start-sqlite.js`) and the pool (`sqlitePool.js`) used to
 * each carry their own default, both relative to `process.cwd()`:
 *
 *   dev-start-sqlite.js : './.sqlite-data/lockdown-dev.db'
 *   sqlitePool.js       : path.join(process.cwd(), '.sqlite-data', 'lockdown.db')
 *
 * Two problems came out of that. The filenames disagreed, so a launch that fell
 * through to the pool default opened a different database than the dev entry
 * had just migrated. And because both were cwd-relative, starting the server
 * from a different directory silently created a brand-new empty database —
 * which the dev entry then seeded with a fresh `admin` super-admin. That is how
 * one machine ended up with super-admin accounts spread across several files.
 *
 * Everything resolves from this file's location instead, so the path is the
 * same no matter where the process was started, and only one module can decide
 * what it is.
 */

const path = require('path');

/** Filename used for the local development database. */
const DEFAULT_DB_FILE = 'lockdown-dev.db';

/** The `server/` directory (this file lives in `server/src/db/`). */
const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Absolute path of the default development database.
 * @returns {string}
 */
function defaultDbPath() {
  return path.join(SERVER_ROOT, '.sqlite-data', DEFAULT_DB_FILE);
}

/**
 * Resolve the SQLite path for this process.
 *
 * - unset  -> the canonical default (absolute, cwd-independent)
 * - ':memory:' -> passed through untouched (tests rely on it)
 * - absolute override -> used as given
 * - relative override -> resolved against `server/`, never the cwd
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function resolveDbPath(env = process.env) {
  const configured = env.SQLITE_PATH;

  if (!configured) return defaultDbPath();
  if (configured === ':memory:') return configured;
  if (path.isAbsolute(configured)) return configured;

  return path.resolve(SERVER_ROOT, configured);
}

module.exports = { resolveDbPath, defaultDbPath, DEFAULT_DB_FILE, SERVER_ROOT };
