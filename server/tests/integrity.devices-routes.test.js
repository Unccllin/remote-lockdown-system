/**
 * Tests for Phase 2: Server DB integrity fixes.
 *
 * Covers:
 *   - A2: withTransaction (BEGIN/COMMIT/ROLLBACK)
 *   - CC16: Dual-mode read (encrypted vs plaintext fallback)
 *   - A6: Device delete guard (unreleased keys)
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool, JWT_SECRET } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const { withTransaction } = require('../src/db/withTransaction');
const { encryptField, decryptField, readDualMode } = require('../src/db/fieldCrypto');
const { clearKeyCache } = require('../src/db/crypto');

const agentRoutes = require('../src/routes/agent');
const devicesRoutes = require('../src/routes/devices');

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';

function makeToken(adminId = 'admin-1', username = 'admin') {
  return jwt.sign({ id: adminId, username, role: 'super-admin' }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  mockPool.query.reset();
  clearKeyCache();
});

afterAll(() => {
  clearKeyCache();
});

// ---------------------------------------------------------------------------
// A2: flag-stolen + recover in transactions
// ---------------------------------------------------------------------------

describe('POST /api/devices/:id/flag-stolen — transaction (A2)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRoutes);

  test('wraps flag-stolen in transaction', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active' };
    const cmd = { id: 'cmd-1', device_id: 'dev-1', command_type: 'lockdown', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(200);

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });
});

describe('POST /api/devices/:id/recover — transaction + dual-mode (A2, CC16)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRoutes);

  test('wraps recover in transaction', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const key = { id: 'key-1', key_material: 'fernet-key==', released_at: null };
    const cmd = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.key_material).toBe('fernet-key=='); // plaintext fallback (CC16)

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  test('decrypts key_material when encrypted columns are populated (CC16)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    // Encrypted-only row (no plaintext)
    const enc = encryptField('decrypted-key==');
    const key = {
      id: 'key-1',
      key_material: null,
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
      released_at: null,
    };
    const cmd = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.key_material).toBe('decrypted-key==');
  });
});

// ---------------------------------------------------------------------------
// A6: Device delete guard
// ---------------------------------------------------------------------------

describe('DELETE /api/devices/:id — guard (A6, CC14)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRoutes);

  test('returns 409 when device has unreleased encryption keys', async () => {
    // Simulate the guard trigger raising P0001
    const guardError = new Error('Cannot delete device dev-1: unreleased encryption keys exist');
    guardError.code = 'P0001';
    mockPool.setError('DELETE FROM devices', guardError);

    const res = await request(app)
      .delete('/api/devices/dev-1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('unreleased encryption keys');
    expect(res.body.hint).toBeDefined();
  });

  test('force=true releases keys and deletes', async () => {
    mockPool.query.setResult('DELETE FROM devices WHERE id = $1 RETURNING id', { rows: [{ id: 'dev-1' }] });

    const res = await request(app)
      .delete('/api/devices/dev-1?force=true')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('dev-1');
    expect(res.body.forced).toBe(true);

    // Verify keys were released before delete
    const releaseCall = mockPool.query.mock.calls.find(
      c => c[0].includes('UPDATE encryption_keys SET released_at')
    );
    expect(releaseCall).toBeDefined();
  });

  test('returns 404 when device not found (no force)', async () => {
    mockPool.query.setResult('DELETE FROM devices WHERE id = $1 RETURNING id', { rows: [] });

    const res = await request(app)
      .delete('/api/devices/nonexistent')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});
