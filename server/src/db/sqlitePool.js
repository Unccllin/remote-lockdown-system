/**
 * SQLite-based pool wrapper — provides the same interface as pg.Pool
 * but runs SQLite in-process via the `sqlite3` native module.
 *
 * Used by the Electron admin app (and optionally for local dev) instead
 * of PGlite, because PGlite (WASM) is incompatible with Electron 33/34.
 *
 * SQL Translation:
 *   The existing route code uses PostgreSQL syntax ($1 params, NOW(),
 *   INTERVAL, :: casts, pg_advisory_lock). This pool transparently
 *   translates PG syntax to SQLite equivalents so routes don't need
 *   changes.
 *
 * Interface (matches pg.Pool):
 *   - query(text, params) → Promise<{ rows, rowCount, command }>
 *   - connect() → Promise<client>  (client has query/release)
 *   - end() → Promise<void>
 */

const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const crypto = require('crypto');
const path = require('path');

let _db = null;
let _ready = null;

// --- Async mutex: serializes "clients" for withTransaction() ---
// SQLite is single-connection; concurrent BEGIN/COMMIT would interleave.
let _mutexPromise = Promise.resolve();

/**
 * Translate PostgreSQL SQL syntax to SQLite-compatible syntax.
 *
 * Handles:
 *   - $1, $2, ... → ?, ?, ...
 *   - NOW() → datetime('now')
 *   - CURRENT_TIMESTAMP → datetime('now')
 *   - INTERVAL 'N days' → used inline with datetime()
 *   - ::interval / ::text / ::type casts → stripped
 *   - pg_try_advisory_lock() / pg_advisory_unlock() → no-op (returns true)
 *   - gen_random_uuid() → lower(hex(randomblob(16))) [for migrations]
 *
 * @param {string} sql — PostgreSQL SQL string
 * @returns {string} SQLite-compatible SQL string
 */
function translateSql(sql) {
  let out = sql;

  // 1. Replace $N parameter placeholders with ?
  //    Match $1, $2, ..., $10, $25, etc. (not $foo)
  out = out.replace(/\$(\d+)/g, '?');

  // 2. Replace NOW() and CURRENT_TIMESTAMP with datetime('now')
  //    Case-insensitive, handles NOW() with optional spaces
  out = out.replace(/\bNOW\s*\(\s*\)/gi, "datetime('now')");
  out = out.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime('now')");

  // 3. Handle INTERVAL 'N days' syntax used in retentionScheduler
  //    Pattern: datetime('now') - INTERVAL '90 days'
  //    SQLite:  datetime('now', '-90 days')
  out = out.replace(
    /datetime\('now'\)\s*-\s*INTERVAL\s*'(\d+)\s*(days?|hours?|minutes?|seconds?)'/gi,
    (match, num, unit) => {
      const u = unit.toLowerCase()[0]; // d, h, m, s
      return `datetime('now', '-${num} ${u}')`;
    }
  );

  // 4. Handle ::interval cast with string concatenation
  //    Pattern: NOW() + ($2 || ' milliseconds')::interval
  //    SQLite:  datetime('now', '+' || ? || ' milliseconds')
  //    This is used by hmacAuth nonce_cache INSERT.
  out = out.replace(
    /datetime\('now'\)\s*\+\s*\((\?\|\|\s*'[^']*'\s*)\)::interval/gi,
    (match, inner) => {
      // inner is like: ?||' milliseconds'
      return `datetime('now', '+' || ${inner})`;
    }
  );

  // 5. Strip other ::type casts (::text, ::int, ::jsonb, etc.)
  out = out.replace(/::[a-zA-Z_]+/g, '');

  // 6. pg_try_advisory_lock / pg_advisory_unlock → return 1 (success)
  //    SQLite doesn't have advisory locks. In single-process Electron,
  //    in-memory JS locks suffice. We translate to SELECT 1 so the
  //    query succeeds and the caller gets a truthy result.
  out = out.replace(/pg_try_advisory_lock\s*\([^)]*\)/gi, '1');
  out = out.replace(/pg_advisory_unlock\s*\([^)]*\)/gi, '1');

  // 7. gen_random_uuid() → lower(hex(randomblob(16)))
  //    Used in migrations. Format: 32 hex chars (no dashes, but
  //    our code stores UUIDs as TEXT so format doesn't matter as
  //    long as it's unique).
  out = out.replace(/\bgen_random_uuid\s*\(\s*\)/gi, 'lower(hex(randomblob(16)))');

  return out;
}

/**
 * Detect whether a SQL string contains a RETURNING clause.
 * If so, we must use all()/get() instead of run() to get the rows.
 */
function hasReturning(sql) {
  return /\bRETURNING\b/i.test(sql);
}

/**
 * Detect whether a SQL string is a SELECT (or RETURNING INSERT/UPDATE/DELETE
 * that returns rows). These need all() to get rows back.
 */
function returnsRows(sql) {
  const upper = sql.trim().toUpperCase();
  return (
    upper.startsWith('SELECT') ||
    upper.startsWith('WITH') ||
    hasReturning(sql) ||
    upper.startsWith('PRAGMA')
  );
}

/**
 * Open (or reuse) the SQLite database connection.
 * @param {string} dbPath — path to .db file, or ':memory:'
 * @param {object} opts — { verbose: fn } for SQL logging
 */
async function openDb(dbPath, opts = {}) {
  if (_db) return _db;

  // Enable WAL mode for better concurrent read performance
  // (writes are still serialized, but readers don't block)
  _db = await sqlite.open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Enable foreign keys (off by default in SQLite)
  await _db.run('PRAGMA foreign_keys = ON');

  // WAL mode for better performance (commented out for :memory: compatibility)
  if (dbPath !== ':memory:') {
    try {
      await _db.run('PRAGMA journal_mode = WAL');
    } catch (e) {
      // WAL not supported (e.g. on network filesystems) — fall back to default
    }
  }

  _ready = true;
  return _db;
}

/**
 * Execute a query and return a pg-compatible result.
 * @param {string} sql — PostgreSQL SQL (will be translated)
 * @param {Array} params — bind parameters
 * @returns {Promise<{ rows: Array, rowCount: number, command: string }>}
 */
async function query(sql, params) {
  const db = await getDb();
  const translated = translateSql(sql);
  const cleanParams = params || [];

  if (returnsRows(translated)) {
    const rows = await db.all(translated, cleanParams);
    return {
      rows: rows || [],
      rowCount: rows ? rows.length : 0,
      command: getCommand(translated),
    };
  } else {
    const result = await db.run(translated, cleanParams);
    return {
      rows: [],
      rowCount: result.changes || 0,
      command: getCommand(translated),
    };
  }
}

/**
 * Extract the SQL command type (SELECT, INSERT, UPDATE, DELETE) for
 * pg-compatible result.command
 */
function getCommand(sql) {
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith('SELECT')) return 'SELECT';
  if (upper.startsWith('INSERT')) return 'INSERT';
  if (upper.startsWith('UPDATE')) return 'UPDATE';
  if (upper.startsWith('DELETE')) return 'DELETE';
  if (upper.startsWith('CREATE')) return 'CREATE';
  if (upper.startsWith('ALTER')) return 'ALTER';
  return 'UNKNOWN';
}

/**
 * Get the current DB instance (opens lazily if not yet open).
 */
async function getDb() {
  if (!_db) {
    const dbPath = process.env.SQLITE_PATH || path.join(process.cwd(), '.sqlite-data', 'lockdown.db');
    // Ensure directory exists for file-based DBs
    if (dbPath !== ':memory:') {
      const fs = require('fs');
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    await openDb(dbPath);
  }
  return _db;
}

/**
 * Acquire a "client" for use in withTransaction().
 * The mutex ensures only one transaction is active at a time.
 */
async function connect() {
  const db = await getDb();

  // Acquire mutex
  const prev = _mutexPromise;
  let releaseMutex;
  _mutexPromise = new Promise((resolve) => {
    releaseMutex = resolve;
  });
  await prev;

  let inTransaction = false;

  return {
    query: async (sql, params) => {
      const translated = translateSql(sql);

      // Track transaction state
      const upper = translated.trim().toUpperCase();
      if (upper === 'BEGIN') {
        await db.exec('BEGIN');
        inTransaction = true;
        return { rows: [], rowCount: 0, command: 'BEGIN' };
      }
      if (upper === 'COMMIT') {
        await db.exec('COMMIT');
        inTransaction = false;
        return { rows: [], rowCount: 0, command: 'COMMIT' };
      }
      if (upper === 'ROLLBACK') {
        await db.exec('ROLLBACK');
        inTransaction = false;
        return { rows: [], rowCount: 0, command: 'ROLLBACK' };
      }

      // Regular query within transaction
      return query(sql, params);
    },
    release: () => {
      // If user forgot to COMMIT/ROLLBACK, rollback to avoid stale state
      if (inTransaction) {
        db.exec('ROLLBACK').catch(() => {});
        inTransaction = false;
      }
      if (releaseMutex) {
        releaseMutex();
        releaseMutex = null;
      }
    },
  };
}

/**
 * Close the database connection.
 */
async function end() {
  if (_db) {
    await _db.close();
    _db = null;
    _ready = null;
    _mutexPromise = Promise.resolve();
  }
}

/**
 * Reset to in-memory mode (for tests).
 * Must be called before any query.
 */
function useInMemory() {
  if (_db) {
    throw new Error('useInMemory() called after DB is already open');
  }
  process.env.SQLITE_PATH = ':memory:';
}

// Export the pool object with the same interface as pg.Pool / pglitePool
const sqlitePool = {
  query,
  connect,
  end,
  useInMemory,
  // Exposed for testing
  _translateSql: translateSql,
  _hasReturning: hasReturning,
  _returnsRows: returnsRows,
};

module.exports = sqlitePool;
