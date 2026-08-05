/**
 * Tests for the SQLite pool — SQL translation, migrations, and query interface.
 *
 * These tests use an in-memory SQLite database (SQLITE_PATH=:memory:)
 * and verify that the pg-compatible interface works correctly with
 * SQLite as the backend.
 */

// Set env vars BEFORE requiring any modules
process.env.NODE_ENV = 'test';
process.env.ALLOW_NON_PROD = '1';
process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.AGENT_SHARED_KEY = 'test-agent-key-that-is-long-enough-24';
process.env.AGENT_KEY_PEPPER = 'test-pepper-key-that-is-long-enough-32';
process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = 'b'.repeat(64);
process.env.SQLITE_PATH = ':memory:';

const crypto = require('crypto');

// Helper to generate UUIDs (SQLite doesn't have gen_random_uuid at runtime)
function uuid() {
  return crypto.randomUUID();
}

// Mock the pool module to use SQLite. jest.mock is hoisted by Babel,
// so the factory can't reference outer variables — but it CAN call require().
// This ensures withTransaction.js gets the SQLite pool instead of pg.Pool.
jest.mock('../src/db/pool', () => require('../src/db/sqlitePool'));

const sqlitePool = require('../src/db/sqlitePool');
const { runMigrations } = require('../src/db/migrationRunner');

// Run migrations once before all tests
beforeAll(async () => {
  await runMigrations(sqlitePool, { dialect: 'sqlite' });
});

afterAll(async () => {
  await sqlitePool.end();
});

// Clean all tables between tests (preserve schema_migrations)
beforeEach(async () => {
  const tables = ['nonce_cache', 'location_reports', 'audit_log', 'bios_passwords', 'encryption_keys', 'commands', 'devices', 'admins'];
  // Delete in dependency order (children first)
  for (const t of tables) {
    await sqlitePool.query(`DELETE FROM ${t}`);
  }
});

describe('sqlitePool SQL translation', () => {
  test('translates $N params to ?', () => {
    const result = sqlitePool._translateSql('SELECT * FROM users WHERE id = $1 AND name = $2');
    expect(result).toBe('SELECT * FROM users WHERE id = ? AND name = ?');
  });

  test('translates NOW() to datetime(\'now\')', () => {
    const result = sqlitePool._translateSql('UPDATE t SET updated_at = NOW() WHERE id = $1');
    expect(result).toContain("datetime('now')");
    expect(result).not.toContain('NOW()');
  });

  test('translates CURRENT_TIMESTAMP to datetime(\'now\')', () => {
    const result = sqlitePool._translateSql('INSERT INTO t (ts) VALUES (CURRENT_TIMESTAMP)');
    expect(result).toContain("datetime('now')");
  });

  test('translates INTERVAL \'N days\' to datetime modifier', () => {
    const result = sqlitePool._translateSql("datetime('now') - INTERVAL '90 days'");
    expect(result).toContain("datetime('now', '-90 d')");
  });

  test('translates ::interval cast with concatenation', () => {
    const result = sqlitePool._translateSql("datetime('now') + (?||' milliseconds')::interval");
    expect(result).toContain("datetime('now', '+' || ?||' milliseconds')");
    expect(result).not.toContain('::interval');
  });

  test('strips other ::type casts', () => {
    const result = sqlitePool._translateSql("SELECT '123'::int AS val");
    expect(result).toBe("SELECT '123' AS val");
  });

  test('translates pg_try_advisory_lock to 1', () => {
    const result = sqlitePool._translateSql('SELECT pg_try_advisory_lock($1)');
    expect(result).toBe('SELECT 1');
  });

  test('translates pg_advisory_unlock to 1', () => {
    const result = sqlitePool._translateSql('SELECT pg_advisory_unlock($1)');
    expect(result).toBe('SELECT 1');
  });

  test('query() with pg_try_advisory_lock resolves without SQLITE_RANGE (real SQLite)', async () => {
    // The advisory-lock translation strips the $1 placeholder (the whole
    // function call becomes literal `1`), but the caller still passes a
    // param. Without the targeted param-clearing in query(), sqlite3 would
    // throw SQLITE_RANGE (more params than placeholders). This exercises the
    // real query() path against a live SQLite connection — not just
    // _translateSql — to confirm the bind succeeds.
    const result = await sqlitePool.query(
      'SELECT pg_try_advisory_lock($1)',
      ['test-lock-key']
    );
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
    expect(result.command).toBe('SELECT');
  });

  test('query() with pg_advisory_unlock resolves without SQLITE_RANGE (real SQLite)', async () => {
    const result = await sqlitePool.query(
      'SELECT pg_advisory_unlock($1)',
      ['test-lock-key']
    );
    expect(result).toBeDefined();
    expect(result.rows).toHaveLength(1);
    expect(result.command).toBe('SELECT');
  });

  test('translates gen_random_uuid()', () => {
    const result = sqlitePool._translateSql('SELECT gen_random_uuid() AS id');
    expect(result).toContain('lower(hex(randomblob(16)))');
  });

  test('handles $10, $25 (multi-digit params)', () => {
    const result = sqlitePool._translateSql('INSERT INTO t VALUES ($1, $2, $10, $25)');
    expect(result).toBe('INSERT INTO t VALUES (?, ?, ?, ?)');
  });

  test('expandParams duplicates values for repeated $N', () => {
    const expanded = sqlitePool._expandParams(
      'WHERE (mac = $1 AND $1 IS NOT NULL) OR (uuid = $2 AND $2 IS NOT NULL)',
      ['mac-val', 'uuid-val']
    );
    expect(expanded).toEqual(['mac-val', 'mac-val', 'uuid-val', 'uuid-val']);
  });

  test('expandParams preserves order for non-repeated $N', () => {
    const expanded = sqlitePool._expandParams(
      'INSERT INTO t VALUES ($1, $2, $3)',
      ['a', 'b', 'c']
    );
    expect(expanded).toEqual(['a', 'b', 'c']);
  });

  test('expandParams handles out-of-order $N', () => {
    const expanded = sqlitePool._expandParams(
      'SELECT $2, $1, $2',
      ['first', 'second']
    );
    expect(expanded).toEqual(['second', 'first', 'second']);
  });

  test('expandParams returns empty for empty params', () => {
    const expanded = sqlitePool._expandParams('SELECT $1', []);
    expect(expanded).toEqual([]);
  });

  test('expandParams passes through when no $N in SQL', () => {
    const expanded = sqlitePool._expandParams('SELECT 1', ['unused']);
    expect(expanded).toEqual(['unused']);
  });
});

describe('sqlitePool duplicate $N query (real SQLite)', () => {
  test('query with repeated $N binds correctly', async () => {
    // This is the exact pattern from agentAuth/findDevice that exposed the bug:
    //   WHERE (mac_address = $1 AND $1 IS NOT NULL)
    //   OR (hardware_uuid = $2 AND $2 IS NOT NULL)
    const id = uuid();
    const mac = '02:00:00:00:00:AA';
    const hwuuid = '00000000-0000-4000-8000-00000000AA01';
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, mac_address, hardware_uuid, owner_name, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, 'DUP-PARAM-LAPTOP', mac, hwuuid, 'Owner', 'active']
    );

    // Query using duplicate $N — must find the device by mac_address
    const result = await sqlitePool.query(
      `SELECT * FROM devices
       WHERE (mac_address = $1 AND $1 IS NOT NULL)
          OR (hardware_uuid = $2 AND $2 IS NOT NULL)
       LIMIT 1`,
      [mac, hwuuid]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(id);
    expect(result.rows[0].mac_address).toBe(mac);
  });

  test('query with repeated $N finds by hardware_uuid when mac is null', async () => {
    const id = uuid();
    const hwuuid = '00000000-0000-4000-8000-00000000BB02';
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, hardware_uuid, owner_name, status) VALUES ($1, $2, $3, $4, $5)',
      [id, 'DUP-PARAM-LAPTOP-2', hwuuid, 'Owner', 'active']
    );

    // mac is null — must find by hardware_uuid via the second clause
    const result = await sqlitePool.query(
      `SELECT * FROM devices
       WHERE (mac_address = $1 AND $1 IS NOT NULL)
          OR (hardware_uuid = $2 AND $2 IS NOT NULL)
       LIMIT 1`,
      [null, hwuuid]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(id);
  });
});

describe('sqlitePool query interface', () => {
  test('INSERT with RETURNING returns rows', async () => {
    const id = uuid();
    const result = await sqlitePool.query(
      'INSERT INTO admins (id, username, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
      [id, 'admin1', 'hash123']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].username).toBe('admin1');
    expect(result.rows[0].id).toBe(id);
    expect(result.rowCount).toBe(1);
  });

  test('SELECT returns rows', async () => {
    const id = uuid();
    await sqlitePool.query(
      'INSERT INTO admins (id, username, password_hash) VALUES ($1, $2, $3)',
      [id, 'admin2', 'hash456']
    );
    const result = await sqlitePool.query('SELECT * FROM admins WHERE username = $1', ['admin2']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].id).toBe(id);
  });

  test('UPDATE returns rowCount (changes)', async () => {
    const id = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [id, 'LAPTOP-1', 'Owner', 'active']
    );
    const result = await sqlitePool.query(
      'UPDATE devices SET status = $1 WHERE id = $2',
      ['locked', id]
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows).toHaveLength(0);
  });

  test('DELETE returns rowCount', async () => {
    const id = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [id, 'LAPTOP-2', 'Owner', 'active']
    );
    const result = await sqlitePool.query('DELETE FROM devices WHERE id = $1', [id]);
    expect(result.rowCount).toBe(1);
  });

  test('NOW() works in INSERT', async () => {
    const id = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status, last_checkin) VALUES ($1, $2, $3, $4, NOW())',
      [id, 'LAPTOP-3', 'Owner', 'active']
    );
    const result = await sqlitePool.query('SELECT last_checkin FROM devices WHERE id = $1', [id]);
    expect(result.rows[0].last_checkin).toBeTruthy();
    // SQLite datetime format: 'YYYY-MM-DD HH:MM:SS'
    expect(result.rows[0].last_checkin).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe('sqlitePool transactions', () => {
  test('withTransaction commits on success', async () => {
    const { withTransaction } = require('../src/db/withTransaction');

    const id = uuid();
    await withTransaction(async (client) => {
      await client.query(
        'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
        [id, 'TX-LAPTOP', 'Owner', 'active']
      );
    });

    const result = await sqlitePool.query('SELECT * FROM devices WHERE hostname = $1', ['TX-LAPTOP']);
    expect(result.rows).toHaveLength(1);
  });

  test('withTransaction rolls back on error', async () => {
    const { withTransaction } = require('../src/db/withTransaction');

    const id = uuid();
    await expect(
      withTransaction(async (client) => {
        await client.query(
          'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
          [id, 'TX-FAIL', 'Owner', 'active']
        );
        throw new Error('intentional failure');
      })
    ).rejects.toThrow('intentional failure');

    const result = await sqlitePool.query('SELECT * FROM devices WHERE hostname = $1', ['TX-FAIL']);
    expect(result.rows).toHaveLength(0);
  });
});

describe('sqlitePool ON CONFLICT', () => {
  test('ON CONFLICT DO NOTHING prevents duplicates', async () => {
    const devId = uuid();
    const cmdId = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [devId, 'DUP-LAPTOP', 'Owner', 'active']
    );

    // First insert succeeds
    const r1 = await sqlitePool.query(
      'INSERT INTO encryption_keys (id, device_id, command_id, key_material) VALUES ($1, $2, $3, $4) ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING',
      [uuid(), devId, cmdId, 'key1']
    );
    expect(r1.rowCount).toBe(1);

    // Duplicate insert is silently ignored
    const r2 = await sqlitePool.query(
      'INSERT INTO encryption_keys (id, device_id, command_id, key_material) VALUES ($1, $2, $3, $4) ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING',
      [uuid(), devId, cmdId, 'key2']
    );
    expect(r2.rowCount).toBe(0);

    // Verify only one row exists
    const keys = await sqlitePool.query('SELECT * FROM encryption_keys WHERE device_id = $1', [devId]);
    expect(keys.rows).toHaveLength(1);
  });
});

describe('sqlitePool guard trigger', () => {
  test('prevents deleting device with unreleased encryption keys', async () => {
    const devId = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [devId, 'GUARD-LAPTOP', 'Owner', 'active']
    );
    await sqlitePool.query(
      'INSERT INTO encryption_keys (id, device_id, key_material) VALUES ($1, $2, $3)',
      [uuid(), devId, 'secret-key']
    );

    await expect(
      sqlitePool.query('DELETE FROM devices WHERE id = $1', [devId])
    ).rejects.toThrow(/unreleased encryption keys/);
  });

  test('allows deleting device after keys are released', async () => {
    const devId = uuid();
    await sqlitePool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [devId, 'GUARD-LAPTOP-2', 'Owner', 'active']
    );
    await sqlitePool.query(
      'INSERT INTO encryption_keys (id, device_id, key_material) VALUES ($1, $2, $3)',
      [uuid(), devId, 'secret-key']
    );
    // Release the key
    await sqlitePool.query(
      'UPDATE encryption_keys SET released_at = NOW() WHERE device_id = $1',
      [devId]
    );
    // Now deletion should work
    const result = await sqlitePool.query('DELETE FROM devices WHERE id = $1', [devId]);
    expect(result.rowCount).toBe(1);
  });
});

describe('sqlitePool HMAC nonce cache', () => {
  test('insert and check nonce with ::interval translation', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const result = await sqlitePool.query(
      "INSERT INTO nonce_cache (nonce, expires_at) VALUES ($1, NOW() + ($2 || ' milliseconds')::interval) ON CONFLICT (nonce) DO NOTHING",
      [nonce, '600000']
    );
    expect(result.rowCount).toBe(1);

    // Check that the nonce exists and hasn't expired
    const check = await sqlitePool.query(
      'SELECT 1 FROM nonce_cache WHERE nonce = $1 AND expires_at > NOW()',
      [nonce]
    );
    expect(check.rows).toHaveLength(1);
  });

  test('duplicate nonce insert is ignored (ON CONFLICT)', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    await sqlitePool.query(
      "INSERT INTO nonce_cache (nonce, expires_at) VALUES ($1, NOW() + ($2 || ' milliseconds')::interval) ON CONFLICT (nonce) DO NOTHING",
      [nonce, '600000']
    );
    const dup = await sqlitePool.query(
      "INSERT INTO nonce_cache (nonce, expires_at) VALUES ($1, NOW() + ($2 || ' milliseconds')::interval) ON CONFLICT (nonce) DO NOTHING",
      [nonce, '600000']
    );
    expect(dup.rowCount).toBe(0);
  });
});
