/**
 * withTransaction — runs an async callback inside a DB transaction.
 *
 * A2 fix: The original routes issued multiple independent queries (UPDATE
 * commands, INSERT encryption_keys, INSERT audit_log, UPDATE devices) with
 * no transaction. A crash or error mid-sequence would leave the DB in an
 * inconsistent state (e.g. command marked executed but key not stored).
 *
 * This helper:
 *   1. Acquires a client from the pool (serialized via mutex in PGlite).
 *   2. BEGINs a transaction.
 *   3. Runs the callback, passing a `client` with a `.query(sql, params)` method.
 *   4. On success: COMMIT.
 *   5. On error: ROLLBACK, then re-throw.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('INSERT INTO ...');
 *     const r = await client.query('SELECT ...');
 *     return r.rows[0];
 *   });
 */

const pool = require('./pool');
const logger = require('../logger');

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Log rollback failure but throw the original error
      logger.error({ err: rollbackErr }, 'ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
