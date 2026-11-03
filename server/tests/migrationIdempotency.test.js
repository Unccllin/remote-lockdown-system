/**
 * S140 regression: SQLite migration idempotency.
 *
 * Before this suite existed, the only migration test (sqlitePool.test.js) ran
 * the migrations ONCE against a FRESH in-memory database. That cannot detect
 * the failure that took the API down in practice:
 *
 *   server/lockdown.db had schema_migrations up to 008, but migration 009's
 *   columns were already present on `commands` (applied out-of-band). Re-running
 *   the sweep threw `SQLITE_ERROR: duplicate column name: boot_lock_status`,
 *   which aborted the whole loop — so 010, 011, 012 and 013 were never applied
 *   and every PBL / hw-test-artifact / firmware-audit route answered 500.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so the runner now detects
 * already-applied DDL and skips it. These tests fail without that logic.
 */

process.env.NODE_ENV = 'test';
process.env.SQLITE_PATH = ':memory:';

const sqlitePool = require('../src/db/sqlitePool');
const { runMigrations } = require('../src/db/migrationRunner');

const EXPECTED_VERSIONS = [
  '001_base',
  '002_integrity',
  '003_auth',
  '004_privacy',
  '005_hmac_auth',
  '006_phase5_commands',
  '007_rbac',
  '008_pba_credentials',
  '009_boot_lock_detail',
  '010_hw_test_artifacts',
  '011_pbl_device_mapping',
  '012_pbl_kv_store',
  '013_firmware_audit',
  '014_update_verification',
];

async function appliedVersions() {
  const result = await sqlitePool.query('SELECT version FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => row.version);
}

async function tableNames() {
  const result = await sqlitePool.query("SELECT name FROM sqlite_master WHERE type = 'table'");
  return result.rows.map((row) => row.name);
}

async function deviceColumns() {
  const result = await sqlitePool.query('PRAGMA table_info(devices)');
  return result.rows.map((row) => row.name);
}

afterAll(async () => {
  await sqlitePool.end();
});

describe('SQLite migration idempotency (S140)', () => {
  test('a fresh database applies every migration', async () => {
    await runMigrations(sqlitePool, { dialect: 'sqlite' });

    expect(await appliedVersions()).toEqual(EXPECTED_VERSIONS);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(['hw_test_artifacts', 'pbl_kv_store'])
    );
  });

  test('re-running an already-migrated database is a no-op', async () => {
    await runMigrations(sqlitePool, { dialect: 'sqlite' });

    expect(await appliedVersions()).toEqual(EXPECTED_VERSIONS);
  });

  test('schema drift is healed instead of aborting the sweep', async () => {
    // Recreate the observed state: 009+ DDL already present in the database,
    // but their versions missing from schema_migrations.
    await sqlitePool.query("DELETE FROM schema_migrations WHERE version >= '009'");
    const columnsBefore = await sqlitePool.query('PRAGMA table_info(commands)');
    expect(columnsBefore.rows.some((c) => c.name === 'boot_lock_status')).toBe(true);

    // Before the fix this rejected with "duplicate column name".
    await expect(runMigrations(sqlitePool, { dialect: 'sqlite' })).resolves.toBeUndefined();

    expect(await appliedVersions()).toEqual(EXPECTED_VERSIONS);

    // The skipped ADD COLUMN must not have duplicated anything.
    const columnsAfter = await sqlitePool.query('PRAGMA table_info(commands)');
    const bootLockColumns = columnsAfter.rows.filter((c) => c.name === 'boot_lock_status');
    expect(bootLockColumns).toHaveLength(1);

    // The migrations that used to be skipped must now have run.
    expect(await tableNames()).toEqual(
      expect.arrayContaining(['hw_test_artifacts', 'pbl_kv_store'])
    );
  });

  test('the SQLite schema can store how a device verifies updates (B-006)', async () => {
    await runMigrations(sqlitePool, { dialect: 'sqlite' });

    // The check-in UPDATE writes this column on every check-in, unconditionally.
    // Without migrations-sqlite/014 every check-in on a SQLite deployment fails
    // with "no such column: update_verification" — a failure no mocked-pool test
    // can see. Exercise the real column, not the version list: a migration name
    // in schema_migrations proves nothing about the DDL it contains.
    expect(await deviceColumns()).toContain('update_verification');

    await sqlitePool.query(
      `INSERT INTO devices (id, hostname, owner_name, status)
       VALUES ('dev-b006', 'DEV-B006', 'Owner', 'active')`
    );
    // Same shape as routes/agent.js: COALESCE keeps the stored value on a null.
    await sqlitePool.query(
      `UPDATE devices SET last_checkin = '2026-01-01T00:00:00Z',
              update_verification = COALESCE($1, update_verification)
         WHERE id = $2`,
      ['sha256-only', 'dev-b006']
    );
    await sqlitePool.query(
      `UPDATE devices SET update_verification = COALESCE($1, update_verification)
         WHERE id = $2`,
      [null, 'dev-b006']
    );

    const row = await sqlitePool.query(
      'SELECT update_verification FROM devices WHERE id = $1',
      ['dev-b006']
    );
    expect(row.rows[0].update_verification).toBe('sha256-only');

    await sqlitePool.query('DELETE FROM devices WHERE id = $1', ['dev-b006']);
  });
});
