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
const path = require('path');

let _db = null;
let _ready = null;

// --- In-flight query tracking ---
//
// `end()` closes the connection, but a query that already took the handle can
// still be mid-await (waiting on a prev-promise, a param expansion, its own
// native round-trip) when the close lands. The sqlite3 driver then raises
// "SQLITE_MISUSE: Database handle is closed" from its *native error callback* —
// an uncaught exception that kills the process, not a rejected promise a caller
// could handle. That is how the E2E suite died intermittently (exit 2, no
// test-level failure, S196 in the agent helpers and again in S267 for the
// lockdown/recovery suites).
//
// pg.Pool.end() has the same hazard and solves it by refusing new work and
// waiting for checked-out clients; this is that wait, plus the same
// catchable refusal (`Cannot use a pool after calling end on the pool`).
let _inflight = 0;
let _drainWaiters = [];
// True only for the duration of end(): new queries are refused with a normal
// JS Error instead of reaching a handle that is about to disappear. Cleared
// once the close completes, so a later query still reopens the DB exactly as
// before (getDb() is lazy; `end()` then `query()` was never an error).
let _closing = false;

function trackStart() {
  _inflight += 1;
}

function trackEnd() {
  _inflight -= 1;
  if (_inflight === 0 && _drainWaiters.length) {
    const waiters = _drainWaiters;
    _drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Resolve once no query is in flight (or after `timeoutMs`, so a wedged
 *  driver can never hang shutdown forever). */
function awaitDrain(timeoutMs = 5000) {
  if (_inflight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    _drainWaiters.push(resolve);
    const timer = setTimeout(resolve, timeoutMs);
    // Never hold the event loop open just for this deadline.
    if (typeof timer.unref === 'function') timer.unref();
  });
}

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

  // 3b. Handle INTERVAL addition (Phase 5: command expiry)
  //    Pattern: datetime('now') + INTERVAL '30 days'
  //    SQLite:  datetime('now', '+30 days')
  out = out.replace(
    /datetime\('now'\)\s*\+\s*INTERVAL\s*'(\d+)\s*(days?|hours?|minutes?|seconds?)'/gi,
    (match, num, unit) => {
      const u = unit.toLowerCase()[0]; // d, h, m, s
      return `datetime('now', '+${num} ${u}')`;
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

  // 5b. jsonb_set → json_set (SQLite uses json_set, PG uses jsonb_set)
  out = out.replace(/\bjsonb_set\s*\(/gi, 'json_set(');

  // 5c. to_jsonb(X) → json_quote(X) (wraps value as JSON string in SQLite)
  out = out.replace(/\bto_jsonb\s*\(/gi, 'json_quote(');

  // 5d. to_char(X, fmt) → X (SQLite has no to_char; drop the format arg.
  //     datetime('now') already produces a readable timestamp string.)
  out = out.replace(/\bto_char\s*\(([^,)]+),\s*[^)]+\)/gi, '$1');

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
 * Expand the params array to match duplicate $N references in the original SQL.
 *
 * PostgreSQL allows the same $N placeholder to appear multiple times in a
 * query — the driver binds the same value to each occurrence. SQLite uses
 * positional ? placeholders (one value per ?), so we must duplicate the
 * param value for each occurrence of $N.
 *
 * Example:
 *   SQL:    WHERE (mac = $1 AND $1 IS NOT NULL) OR (uuid = $2 AND $2 IS NOT NULL)
 *   params: [mac, uuid]
 *   → expanded: [mac, mac, uuid, uuid]
 *
 * @param {string} originalSql — PG SQL with $N placeholders
 * @param {Array} params — bind parameters (PG convention: one per unique $N)
 * @returns {Array} expanded params (one per ? in translated SQL)
 */
function expandParams(originalSql, params) {
  if (!params || params.length === 0) return [];
  const matches = [...originalSql.matchAll(/\$(\d+)/g)];
  if (matches.length === 0) return params;
  return matches.map((m) => params[parseInt(m[1], 10) - 1]);
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
async function openDb(dbPath) {
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
  if (_closing) {
    throw new Error('Cannot use a pool after calling end on the pool');
  }
  trackStart();
  try {
    return await _query(sql, params);
  } finally {
    trackEnd();
  }
}

async function _query(sql, params) {
  const db = await getDb();
  const translated = translateSql(sql);
  let cleanParams = expandParams(sql, params || []);

  // SQLite doesn't auto-serialize JS objects like pg does for JSONB columns.
  // Without this, objects are stored as "[object Object]" (the bug that
  // caused audit_log detail to be unreadable). Stringify any object param
  // so it's stored as valid JSON text in the column.
  cleanParams = cleanParams.map((p) =>
    p != null && typeof p === 'object' && !(p instanceof Date) && !Buffer.isBuffer(p)
      ? JSON.stringify(p)
      : p
  );

  // Some translations strip placeholders (e.g. pg_try_advisory_lock($1) →
  // SELECT 1). If the translated SQL has fewer ? placeholders than we have
  // params, trim to match — otherwise sqlite3 throws SQLITE_RANGE.
  const placeholderCount = (translated.match(/\?/g) || []).length;
  if (cleanParams.length > placeholderCount) {
    cleanParams = cleanParams.slice(0, placeholderCount);
  }

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
        trackStart();
        try {
          await db.exec('BEGIN');
          inTransaction = true;
          return { rows: [], rowCount: 0, command: 'BEGIN' };
        } finally {
          trackEnd();
        }
      }
      if (upper === 'COMMIT') {
        trackStart();
        try {
          await db.exec('COMMIT');
          inTransaction = false;
          return { rows: [], rowCount: 0, command: 'COMMIT' };
        } finally {
          trackEnd();
        }
      }
      if (upper === 'ROLLBACK') {
        trackStart();
        try {
          await db.exec('ROLLBACK');
          inTransaction = false;
          return { rows: [], rowCount: 0, command: 'ROLLBACK' };
        } finally {
          trackEnd();
        }
      }

      // Regular query within transaction
      return query(sql, params);
    },
    release: () => {
      // If user forgot to COMMIT/ROLLBACK, rollback to avoid stale state.
      // Tracked like any other statement: this rollback runs on a captured
      // handle, so an untracked one would race `end()` exactly like a query.
      if (inTransaction) {
        trackStart();
        Promise.resolve(db.exec('ROLLBACK')).catch(() => {}).then(trackEnd, trackEnd);
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
 *
 * Waits for in-flight queries first: closing underneath one is what produces
 * the uncatchable "Database handle is closed" throw (see _inflight above).
 */
async function end() {
  if (_db) {
    _closing = true;
    try {
      await awaitDrain();
      await _db.close();
    } finally {
      _db = null;
      _ready = null;
      _mutexPromise = Promise.resolve();
      _closing = false;
    }
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
  _expandParams: expandParams,
  _hasReturning: hasReturning,
  _returnsRows: returnsRows,
  // Identifies this as the SQLite pool — used by code that needs to
  // adjust parameter formatting (e.g. JSON objects must be stringified
  // for SQLite, but passed as-is for pg/PGlite which handle it natively).
  _isSqlite: true,
  // Driver identity — logged at startup so the selected database is
  // observable rather than inferred from whichever env var happens to be set
  // (S140: the log said "DATABASE_URL (cloud)" while SQLite was serving).
  driver: 'sqlite',
};

module.exports = sqlitePool;
