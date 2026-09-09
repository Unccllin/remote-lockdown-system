/**
 * D-206: DB-backed KV store integration test with PGlite.
 *
 * Tests the createDbKv() function against a real PostgreSQL engine (PGlite
 * in-memory) to verify the persistent KV store works correctly with real SQL.
 *
 * Must run with --runInBand (in-memory PGlite is a singleton per process).
 */

// Switch to in-memory PGlite BEFORE any module that imports pool
const pglitePool = require('../src/db/pglitePool');
pglitePool.useInMemory();

// Mock pool.js to use pglitePool
jest.mock('../src/db/pool', () => require('../src/db/pglitePool'));

const { runMigrations } = require('../src/db/migrationRunner');
const { createDbKv } = require('../src/pbl/kvStore');

let kv;

beforeAll(async () => {
  // Run all migrations (including 012_pbl_kv_store) against in-memory PGlite
  await runMigrations(pglitePool);
  kv = createDbKv(pglitePool);
}, 30000); // 30s timeout for PGlite WASM init

beforeEach(async () => {
  // Clear KV store between tests
  await pglitePool.query('DELETE FROM pbl_kv_store');
});

afterAll(async () => {
  await pglitePool.end();
}, 10000);

describe('D-206: DB-backed KV store (PGlite integration)', () => {
  it('puts and gets a value', async () => {
    await kv.put('test:key1', 'value1');
    const val = await kv.get('test:key1');
    expect(val).toBe('value1');
  });

  it('returns null for missing key', async () => {
    const val = await kv.get('nonexistent:key');
    expect(val).toBeNull();
  });

  it('returns string when type=text', async () => {
    await kv.put('test:key2', 12345);
    const val = await kv.get('test:key2', 'text');
    expect(val).toBe('12345');
    expect(typeof val).toBe('string');
  });

  it('upserts on conflict (put replaces existing value)', async () => {
    await kv.put('test:key3', 'first');
    await kv.put('test:key3', 'second');
    const val = await kv.get('test:key3');
    expect(val).toBe('second');
  });

  it('deletes a value', async () => {
    await kv.put('test:key4', 'todelete');
    await kv.delete('test:key4');
    const val = await kv.get('test:key4');
    expect(val).toBeNull();
  });

  it('delete is idempotent (no error on missing key)', async () => {
    await expect(kv.delete('nonexistent:key')).resolves.toBeUndefined();
  });

  it('lists all keys without prefix', async () => {
    await kv.put('pbl_devices:aaa', '{}');
    await kv.put('pbl_devices:bbb', '{}');
    await kv.put('pbl_policy:1', 'blob');

    const result = await kv.list();
    expect(result.keys).toHaveLength(3);
    const names = result.keys.map((k) => k.name).sort();
    expect(names).toEqual(['pbl_devices:aaa', 'pbl_devices:bbb', 'pbl_policy:1']);
  });

  it('lists keys with prefix filter', async () => {
    await kv.put('pbl_devices:aaa', '{}');
    await kv.put('pbl_devices:bbb', '{}');
    await kv.put('pbl_policy:1', 'blob');

    const result = await kv.list({ prefix: 'pbl_devices:' });
    expect(result.keys).toHaveLength(2);
    const names = result.keys.map((k) => k.name).sort();
    expect(names).toEqual(['pbl_devices:aaa', 'pbl_devices:bbb']);
  });

  it('returns empty list when no keys match prefix', async () => {
    await kv.put('pbl_devices:aaa', '{}');
    const result = await kv.list({ prefix: 'nonexistent:' });
    expect(result.keys).toHaveLength(0);
  });

  it('stores and retrieves JSON values (PBL device records)', async () => {
    const device = {
      device_id: 'ab'.repeat(32),
      status: 'locked',
      lock_reason: 'admin_lock',
      enrolled_at: '2026-01-01T00:00:00Z',
    };
    await kv.put(`pbl_devices:${device.device_id}`, JSON.stringify(device));
    const data = await kv.get(`pbl_devices:${device.device_id}`, 'text');
    const retrieved = JSON.parse(data);
    expect(retrieved.device_id).toBe(device.device_id);
    expect(retrieved.status).toBe('locked');
    expect(retrieved.lock_reason).toBe('admin_lock');
  });

  it('stores and retrieves base64 values (policy blobs)', async () => {
    const policyBlob = Buffer.from([0xd1, 0x82, 0x01, 0x02, 0x03]);
    const b64 = policyBlob.toString('base64');
    await kv.put('pbl_policy:42', b64);
    const data = await kv.get('pbl_policy:42', 'text');
    expect(data).toBe(b64);
    const retrieved = Buffer.from(data, 'base64');
    expect(retrieved).toEqual(policyBlob);
  });

  it('persists across KV instances (same DB)', async () => {
    await kv.put('test:persist', 'survives');
    // Create a new KV instance pointing at the same pool
    const kv2 = createDbKv(pglitePool);
    const val = await kv2.get('test:persist');
    expect(val).toBe('survives');
  });
});
