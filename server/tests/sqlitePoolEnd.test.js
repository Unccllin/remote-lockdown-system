/**
 * Tests for sqlitePool.end() — the shutdown contract.
 *
 * Why this file exists (S267): `make test-e2e` died twice out of ~10 full
 * sweeps with
 *
 *   Error: SQLITE_MISUSE: Database handle is closed
 *       at formatError (sqlite/build/utils/format-error.js:9)
 *
 * an exception thrown from the sqlite3 driver's *native* error callback. It is
 * not a rejected promise — it is uncaught, so it kills the jest process with
 * exit 2 and leaves no test-level trace. The trigger is a query that took the
 * handle, was still mid-flight, and had the connection closed underneath it by
 * pool.end() during test teardown.
 *
 * These tests pin the contract that makes that impossible:
 *   1. end() waits for in-flight queries instead of closing underneath them.
 *   2. A query issued *while* end() is closing is refused with a normal,
 *      catchable Error (pg.Pool's "Cannot use a pool after calling end").
 *   3. end() is idempotent and safe on a pool that was never opened.
 *
 * Separate file on purpose: this suite ends the pool, and an ended :memory:
 * database reopens empty, so sharing sqlitePool.test.js's migrated DB would
 * make every test after these silently query a schema-less database.
 */

process.env.NODE_ENV = 'test';
process.env.ALLOW_NON_PROD = '1';
process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.AGENT_SHARED_KEY = 'test-agent-key-that-is-long-enough-24';
process.env.AGENT_KEY_PEPPER = 'test-pepper-key-that-is-long-enough-32';
process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = 'b'.repeat(64);
process.env.SQLITE_PATH = ':memory:';

jest.mock('../src/db/pool', () => require('../src/db/sqlitePool'));

const sqlitePool = require('../src/db/sqlitePool');

/**
 * A query that provably outlives the caller's `end()`.
 *
 * A recursive CTE counting 200k rows takes tens of milliseconds in SQLite —
 * orders of magnitude longer than the microtask turn that calls end() — so the
 * close is guaranteed to land while this statement is executing. It touches no
 * table, so it also works after the pool has been ended and lazily reopened.
 */
const SLOW_QUERY = `WITH RECURSIVE c(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000
) SELECT count(*) AS n FROM c`;

describe('sqlitePool.end() shutdown contract', () => {
  test('end() lets an in-flight query run to completion instead of closing underneath it', async () => {
    // Start the statement, then close in the same turn — the close lands while
    // the CTE is still executing. Without the drain, `_db.close()` runs under
    // it and the driver throws SQLITE_MISUSE from its native callback: either
    // this promise rejects, or the process dies and no assertion runs at all.
    const inFlight = sqlitePool.query(SLOW_QUERY);
    const closing = sqlitePool.end();

    const [res] = await Promise.all([inFlight, closing]);

    // The statement ran to completion (a close mid-statement truncates the
    // result set or rejects; it cannot return this count).
    expect(res.rows[0].n).toBe(200000);
  });

  test('a query issued while end() is closing is refused with a catchable Error', async () => {
    // Force the pool to be open again (lazy reopen; SLOW_QUERY needs no schema).
    const inFlight = sqlitePool.query(SLOW_QUERY);
    const closing = sqlitePool.end();

    // _closing is set synchronously at the top of end(), so this query hits the
    // guard rather than a half-closed handle.
    await expect(sqlitePool.query('SELECT 1 AS one')).rejects.toThrow(
      /after calling end on the pool/
    );

    await inFlight;
    await closing;
  });

  test('end() is idempotent and safe when the pool was never opened', async () => {
    await expect(sqlitePool.end()).resolves.toBeUndefined();
    await expect(sqlitePool.end()).resolves.toBeUndefined();
  });
});
