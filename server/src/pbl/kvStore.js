/**
 * D-206: Shared KV store for bidirectional PBL ↔ agent status sync.
 *
 * The PBL routes use an in-memory Map (via createEnv in pbl.js) for KV
 * storage. The agent routes (devices.js) need to access the same KV store
 * to sync agent device status changes to PBL device records.
 *
 * This module provides a shared KV store singleton that both pbl.js and
 * devices.js can use. When a database pool is available (production), the
 * KV store is backed by the `pbl_kv_store` table (migration 012). In tests,
 * the in-memory Map is used via setSharedKvStore().
 *
 * The DB-backed implementation mirrors the Cloudflare KV interface:
 *   get(key, type)  → string | null  (type='text' forces string)
 *   put(key, value) → void
 *   delete(key)     → void
 *   list({prefix})  → { keys: [{name}] }
 */

/** Shared in-memory KV store (singleton, used for tests and fallback). */
let sharedStore = new Map();

/** Get the shared KV store instance. */
function getSharedKvStore() {
  return sharedStore;
}

/** Replace the shared KV store (for testing). */
function setSharedKvStore(store) {
  sharedStore = store;
}

/** Try to load the database pool. Returns null if unavailable (tests, no DB).
 *  Also returns null when PBL_KV_IN_MEMORY=1 (tests force in-memory mode). */
function tryGetDbPool() {
  if (process.env.PBL_KV_IN_MEMORY === '1') return null;
  try {
    return require('../db/pool');
  } catch {
    return null;
  }
}

/** Check if a pool object is a usable database pool (not an in-memory Map shim). */
function isDbPool(pool) {
  return pool && typeof pool.query === 'function';
}

/** Create a DB-backed KV interface using the pbl_kv_store table. */
function createDbKv(pool) {
  return {
    async get(key, type) {
      const result = await pool.query(
        'SELECT value FROM pbl_kv_store WHERE key = $1',
        [key],
      );
      if (result.rows.length === 0) return null;
      const val = result.rows[0].value;
      if (type === 'text') return String(val);
      return val;
    },
    async put(key, value) {
      const val = typeof value === 'string' ? value : String(value);
      await pool.query(
        `INSERT INTO pbl_kv_store (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, val],
      );
    },
    async delete(key) {
      await pool.query('DELETE FROM pbl_kv_store WHERE key = $1', [key]);
    },
    async list({ prefix } = {}) {
      let result;
      if (prefix) {
        result = await pool.query(
          'SELECT key FROM pbl_kv_store WHERE key LIKE $1 ORDER BY key',
          [prefix + '%'],
        );
      } else {
        result = await pool.query('SELECT key FROM pbl_kv_store ORDER BY key');
      }
      return { keys: result.rows.map((r) => ({ name: r.key })) };
    },
  };
}

/** Create an Env-like object backed by the shared KV store.
 *  Uses the database pool if available (production), otherwise in-memory Map. */
function createSharedEnv() {
  const pool = tryGetDbPool();
  const useDb = isDbPool(pool);

  const kv = useDb ? createDbKv(pool) : {
    async get(key, type) {
      const val = sharedStore.get(key);
      if (val === undefined || val === null) return null;
      if (type === 'text') return String(val);
      return val;
    },
    async put(key, value) {
      sharedStore.set(key, value);
    },
    async delete(key) {
      sharedStore.delete(key);
    },
    async list({ prefix } = {}) {
      const keys = [];
      for (const key of sharedStore.keys()) {
        if (!prefix || key.startsWith(prefix)) {
          keys.push({ name: key });
        }
      }
      return { keys };
    },
  };

  const env = { LOCKDOWN_KV: kv };
  // Use a getter so _store always reflects the current sharedStore (for in-memory mode)
  Object.defineProperty(env, '_store', {
    get() { return sharedStore; },
  });
  return env;
}

module.exports = {
  getSharedKvStore,
  setSharedKvStore,
  createSharedEnv,
  createDbKv,
};
