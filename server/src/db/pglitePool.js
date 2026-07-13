/**
 * PGlite-based pool wrapper — provides the same interface as pg.Pool
 * but runs PostgreSQL in-process via WASM. Used for local development
 * and testing when a real PostgreSQL server isn't available.
 */

const { PGlite } = require('@electric-sql/pglite');

let _db = null;
let _ready = null;

async function getDb() {
  if (!_db) {
    _db = new PGlite('./.pglite-data');
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
    // Return a fake client with the same interface
    return {
      query: async (text, params) => {
        const result = await db.query(text, params || []);
        return {
          rows: result.rows || [],
          rowCount: result.rowCount || 0,
        };
      },
      release: () => {},
    };
  },

  async end() {
    if (_db) {
      await _db.close();
      _db = null;
      _ready = null;
    }
  },
};

module.exports = pglitePool;
