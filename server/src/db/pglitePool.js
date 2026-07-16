/**
 * PGlite-based pool wrapper — provides the same interface as pg.Pool
 * but runs PostgreSQL in-process via WASM. Used for local development
 * and testing when a real PostgreSQL server isn't available.
 *
 * IMPORTANT: PGlite is single-connection. The async mutex in connect()
 * serializes "clients" so that transactions (BEGIN/COMMIT/ROLLBACK)
 * don't interleave on the shared connection. Without this, concurrent
 * withTransaction() calls would corrupt each other's transaction state.
 */

const { PGlite } = require('@electric-sql/pglite');

let _db = null;
let _ready = null;

// --- Async mutex: ensures only one "client" uses the shared _db at a time ---
let _mutexPromise = Promise.resolve();

// FA7: Support in-memory mode for E2E tests (avoids on-disk cleanup issues)
let _inMemory = false;

/**
 * Switch to in-memory mode (no on-disk data dir).
 * Must be called before any query is executed.
 * Used by E2E tests to avoid postmaster.pid conflicts between parallel workers.
 */
function useInMemory() {
  _inMemory = true;
  _db = null;
  _ready = null;
}

async function getDb() {
  if (!_db) {
    if (_inMemory) {
      _db = new PGlite(); // in-memory — no path
    } else {
      _db = new PGlite('./.pglite-data');
    }
    _ready = _db.waitReady;
  }
  await _ready;
  return _db;
}

// Wrapper that mimics pg's pool.query(sql, params)
const pglitePool = {
  async query(text, params) {
    const db = await getDb();
    const result = await db.query(text, params || []);
    // pg returns { rows, rowCount, command }, PGlite returns similar
    return {
      rows: result.rows || [],
      rowCount: result.rowCount || (result.rows ? result.rows.length : 0),
      command: result.command,
    };
  },

  async connect() {
    const db = await getDb();

    // Acquire the mutex — wait until any previous "client" releases.
    const prev = _mutexPromise;
    let releaseMutex;
    _mutexPromise = new Promise((resolve) => {
      releaseMutex = resolve;
    });
    await prev;

    // Return a client whose query delegates to the shared _db.
    // Because the mutex is held, no other connect() caller can interleave.
    return {
      query: async (text, params) => {
        const result = await db.query(text, params || []);
        return {
          rows: result.rows || [],
          rowCount: result.rowCount || 0,
        };
      },
      release: () => {
        if (releaseMutex) {
          releaseMutex();
          releaseMutex = null;
        }
      },
    };
  },

  async end() {
    if (_db) {
      await _db.close();
      _db = null;
      _ready = null;
      _mutexPromise = Promise.resolve();
    }
  },
};

module.exports = pglitePool;
module.exports.useInMemory = useInMemory;
