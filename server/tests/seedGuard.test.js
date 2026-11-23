/**
 * Regression tests for the dev-seed refusal guard.
 *
 * The bug these lock down: an existing-but-adminless database got seeded with
 * a super-admin using the well-known password admin/admin123. seedData() must
 * refuse that path (warn + point at POST /api/setup/create-admin) and only seed
 * on a genuinely fresh database.
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
const { runMigrations } = require('../src/db/migrationRunner');
const { seedData } = require('../src/db/seedDevData');
const bcrypt = require('bcryptjs');

beforeAll(async () => {
  await runMigrations(sqlitePool, { dialect: 'sqlite' });
});

afterAll(async () => {
  await sqlitePool.end();
});

beforeEach(async () => {
  const tables = ['location_reports', 'audit_log', 'devices', 'admins'];
  for (const t of tables) {
    await sqlitePool.query(`DELETE FROM ${t}`);
  }
});

describe('seedData refusal guard', () => {
  it('does NOT seed an existing, adminless database (refuses + warns)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await seedData(sqlitePool, { isFreshDatabase: false });
      const admins = await sqlitePool.query('SELECT COUNT(*) as count FROM admins');
      expect(parseInt(admins.rows[0].count, 10)).toBe(0);
      const devices = await sqlitePool.query('SELECT COUNT(*) as count FROM devices');
      expect(parseInt(devices.rows[0].count, 10)).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      const text = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toMatch(/POST \/api\/setup\/create-admin/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('seeds a fresh database with the admin super-admin and demo devices', async () => {
    await seedData(sqlitePool, { isFreshDatabase: true });
    const admins = await sqlitePool.query("SELECT username, role, password_hash FROM admins WHERE username = 'admin'");
    expect(admins.rows).toHaveLength(1);
    expect(admins.rows[0].role).toBe('super-admin');
    expect(bcrypt.compareSync('admin123', admins.rows[0].password_hash)).toBe(true);
    const devices = await sqlitePool.query('SELECT COUNT(*) as count FROM devices');
    expect(parseInt(devices.rows[0].count, 10)).toBe(5);
  });
});
