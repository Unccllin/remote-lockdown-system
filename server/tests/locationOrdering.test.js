/**
 * Location ordering: a fix taken earlier must not outrank one taken later just because it
 * arrived in a different timestamp shape (S272).
 *
 * The defect this pins, found by running the real routes against a real SQLite database rather
 * than by any assertion on the SQL text:
 *
 *   reported_at   SQLite writes `datetime('now')` → `2026-11-17 11:45:52`       (space)
 *   observed_at   the agent sends ISO-8601        → `2026-11-17T06:45:52.030Z`  (T, Z)
 *
 * Both columns are TEXT, so a bare `ORDER BY COALESCE(observed_at, reported_at) DESC` compares
 * them CHARACTER BY CHARACTER. `'T'` (0x54) sorts after `' '` (0x20), so a 06:45 fix ordered
 * above an 11:45 one — the trail read backwards, and `/location/latest` returned the older fix.
 *
 * These tests use a real in-memory SQLite database and the real migration files, so the
 * shapes are the ones the product writes, not fixtures chosen to agree with each other.
 */

process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = ':memory:';

const sqlitePool = require('../src/db/sqlitePool');
const { runMigrations } = require('../src/db/migrationRunner');
const { coalescedTimeOrderSql } = require('../src/db/timestamps');

const EARLIER_OBSERVED = '2026-11-17T06:45:52.030Z';
const MIDDLE_OBSERVED = '2026-11-17T09:00:00.000Z';
const RECEIPT = '2026-11-17 11:45:52'; // SQLite's datetime('now') shape
const LATE_RECEIPT = '2026-11-17 11:50:00';

beforeAll(async () => {
  await runMigrations(sqlitePool, { dialect: 'sqlite' });
  await sqlitePool.query(
    `INSERT INTO devices (id, hostname, owner_name, status) VALUES ('dev-ord','ORD-1','O','tracking')`
  );
  // Three rows in the shapes the two write paths actually produce.
  await sqlitePool.query(
    `INSERT INTO location_reports (device_id, city, observed_at, reported_at)
     VALUES ('dev-ord', 'Earlier', $1, $2)`,
    [EARLIER_OBSERVED, RECEIPT]
  );
  await sqlitePool.query(
    `INSERT INTO location_reports (device_id, city, observed_at, reported_at)
     VALUES ('dev-ord', 'Newer', NULL, $1)`,
    [RECEIPT]
  );
  await sqlitePool.query(
    `INSERT INTO location_reports (device_id, city, observed_at, reported_at)
     VALUES ('dev-ord', 'Middle', $1, $2)`,
    [MIDDLE_OBSERVED, LATE_RECEIPT]
  );
});

afterAll(async () => {
  await sqlitePool.end();
});

async function citiesInOrder(orderBy) {
  const result = await sqlitePool.query(
    `SELECT city FROM location_reports WHERE device_id = 'dev-ord' ORDER BY ${orderBy}`
  );
  return result.rows.map((row) => row.city);
}

describe('location ordering on SQLite (S272)', () => {
  test('the raw COALESCE orders by character, not by time — the defect', async () => {
    // Kept as a test on purpose: it is the evidence that the fix is doing something. If SQLite
    // ever normalises these comparisons this fails, and the helper can be simplified.
    const wrong = await citiesInOrder('COALESCE(observed_at, reported_at) DESC');
    expect(wrong).not.toEqual(['Newer', 'Middle', 'Earlier']);
    expect(wrong).toEqual(['Middle', 'Earlier', 'Newer']);
  });

  test('the helper orders the same rows chronologically', async () => {
    // process.env.USE_SQLITE is set by sqlitePool, and the helper reads it to choose its branch.
    const order = await citiesInOrder(coalescedTimeOrderSql('observed_at', 'reported_at', 'sqlite'));
    expect(order).toEqual(['Newer', 'Middle', 'Earlier']);
  });

  test('the newest fix is the one /location/latest returns', async () => {
    const result = await sqlitePool.query(
      `SELECT city FROM location_reports WHERE device_id = 'dev-ord'
       ORDER BY ${coalescedTimeOrderSql('observed_at', 'reported_at', 'sqlite')} LIMIT 1`
    );
    expect(result.rows[0].city).toBe('Newer');
  });

  test('a row with no observation time still sorts on its receipt time', async () => {
    // Every online report and every pre-019 row has observed_at NULL; it must not be dropped.
    const order = await citiesInOrder(coalescedTimeOrderSql('observed_at', 'reported_at', 'sqlite'));
    expect(order).toContain('Newer');
  });
});

describe('coalescedTimeOrderSql', () => {
  test('emits the PostgreSQL form for every non-SQLite driver', () => {
    // PGlite is PostgreSQL, so it takes the same branch; only `driver === 'sqlite'` differs.
    for (const driver of ['pg', 'pglite', undefined]) {
      expect(coalescedTimeOrderSql('observed_at', 'reported_at', driver)).toBe(
        'COALESCE(observed_at, reported_at) DESC'
      );
    }
  });

  test('the pool really reports itself as sqlite', () => {
    // The routes pass `pool.driver`, so this value is the signal the ordering depends on.
    expect(sqlitePool.driver).toBe('sqlite');
  });

  test('refuses anything that is not a column name', () => {
    expect(() =>
      coalescedTimeOrderSql('observed_at; DROP TABLE devices --', 'reported_at', 'sqlite')
    ).toThrow(TypeError);
    expect(() => coalescedTimeOrderSql('reported_at', '../../etc/passwd', 'sqlite')).toThrow(
      TypeError
    );
  });
});
