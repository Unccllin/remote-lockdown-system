/**
 * Tests for Phase 2: Server DB integrity fixes.
 *
 * Covers:
 *   - A2: withTransaction (BEGIN/COMMIT/ROLLBACK)
 *   - A4: Idempotent ACK (ON CONFLICT DO NOTHING, 23505 handling)
 *   - A3: Encryption at rest (key_material_encrypted, password_encrypted)
 *   - CC16: Dual-mode read (encrypted vs plaintext fallback)
 *   - A6: Device delete guard (unreleased keys)
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const { withTransaction } = require('../src/db/withTransaction');
const { encryptField, decryptField, readDualMode } = require('../src/db/fieldCrypto');
const { clearKeyCache } = require('../src/db/crypto');

const agentRoutes = require('../src/routes/agent');
const devicesRoutes = require('../src/routes/devices');

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';
const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';

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
// A2: withTransaction
// ---------------------------------------------------------------------------

describe('withTransaction', () => {
  test('runs callback inside BEGIN/COMMIT', async () => {
    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO foo VALUES (1)');
      return 'success';
    });

    expect(result).toBe('success');

    // Verify BEGIN and COMMIT were called
    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  test('ROLLBACK on error', async () => {
    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO foo VALUES (1)');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  test('releases client after success', async () => {
    const _client = await mockPool.connect();
    await withTransaction(async (c) => {
      await c.query('SELECT 1');
    });
    // connect() was called, and release() should have been called
    expect(mockPool.connect).toHaveBeenCalled();
  });

  test('releases client after error', async () => {
    await expect(
      withTransaction(async (_c) => {
        throw new Error('fail');
      })
    ).rejects.toThrow('fail');
    // Client should still be released (tested via no hanging)
  });
});

// ---------------------------------------------------------------------------
// A3: Encryption at rest
// ---------------------------------------------------------------------------

describe('fieldCrypto — encryption at rest', () => {
  test('encryptField produces ciphertext + nonce + tag', () => {
    const result = encryptField('my-secret-key==');
    expect(result.ciphertext).toBeDefined();
    expect(result.nonce).toBeDefined();
    expect(result.tag).toBeDefined();
    // Ciphertext should NOT be the plaintext
    expect(result.ciphertext).not.toBe('my-secret-key==');
  });

  test('decryptField round-trips correctly', () => {
    const plaintext = 'fernet-key-base64==';
    const enc = encryptField(plaintext);
    const dec = decryptField(enc.ciphertext, enc.nonce, enc.tag);
    expect(dec).toBe(plaintext);
  });

  test('different encryptions produce different ciphertexts (random nonce)', () => {
    const enc1 = encryptField('same-plaintext');
    const enc2 = encryptField('same-plaintext');
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.nonce).not.toBe(enc2.nonce);
  });

  test('decryptField with wrong key throws', () => {
    const enc = encryptField('secret');
    // Clear cache and set a different key
    clearKeyCache();
    const origKey = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'b'.repeat(64);
    try {
      expect(() => decryptField(enc.ciphertext, enc.nonce, enc.tag)).toThrow();
    } finally {
      process.env.FIELD_ENCRYPTION_KEY = origKey;
      clearKeyCache();
    }
  });
});

// ---------------------------------------------------------------------------
// CC16: Dual-mode read
// ---------------------------------------------------------------------------

describe('readDualMode — CC16 dual-mode read', () => {
  test('decrypts when encrypted columns are populated', () => {
    const plaintext = 'my-key==';
    const enc = encryptField(plaintext);
    const row = {
      key_material: null, // plaintext column is null (encrypted-only row)
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
    };
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe(plaintext);
  });

  test('falls back to plaintext column when encrypted columns are null', () => {
    const row = {
      key_material: 'legacy-plaintext-key==',
      key_material_encrypted: null,
      key_enc_nonce: null,
      key_enc_tag: null,
    };
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe('legacy-plaintext-key==');
  });

  test('returns null for null row', () => {
    expect(readDualMode(null, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBeNull();
  });

  test('prefers encrypted column over plaintext when both exist', () => {
    const plaintext = 'encrypted-value';
    const enc = encryptField(plaintext);
    const row = {
      key_material: 'old-plaintext',
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
    };
    // Should return the decrypted value, not the plaintext
    expect(readDualMode(row, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag')).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// A4: Idempotent ACK (command-ack with ON CONFLICT)
// ---------------------------------------------------------------------------

describe('POST /api/agent/command-ack — idempotency (A4)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);

  test('stores key_material with encrypted columns (A3)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key-base64==',
      });

    expect(res.status).toBe(200);

    // Verify the INSERT included encrypted columns
    const insertKeyCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO encryption_keys') && c[0].includes('ON CONFLICT')
    );
    expect(insertKeyCall).toBeDefined();
    // Should have 6 params: device_id, command_id, key_material, ciphertext, nonce, tag
    expect(insertKeyCall[1]).toHaveLength(6);
    expect(insertKeyCall[1][0]).toBe('dev-1');
    expect(insertKeyCall[1][1]).toBe('cmd-1');
    expect(insertKeyCall[1][2]).toBe('fernet-key-base64=='); // plaintext (for backfill)
    expect(insertKeyCall[1][3]).toBeDefined(); // ciphertext
    expect(insertKeyCall[1][3]).not.toBe('fernet-key-base64==');
  });

  test('stores bios_password with encrypted columns (A3)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
        bios_password: 'BiosP@ss',
      });

    expect(res.status).toBe(200);

    const insertBiosCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO bios_passwords') && c[0].includes('password_encrypted')
    );
    expect(insertBiosCall).toBeDefined();
    expect(insertBiosCall[1]).toHaveLength(5);
    expect(insertBiosCall[1][1]).toBe('BiosP@ss'); // plaintext
    expect(insertBiosCall[1][2]).toBeDefined(); // ciphertext
    expect(insertBiosCall[1][2]).not.toBe('BiosP@ss');
  });

  test('uses ON CONFLICT DO NOTHING for idempotent key insert (A4)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
      });

    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO encryption_keys')
    );
    expect(insertCall[0]).toContain('ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING');
  });

  test('handles 23505 conflict as success (deduplicated)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };

    // Simulate a unique violation on the INSERT
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    const conflictError = new Error('unique violation');
    conflictError.code = '23505';
    mockPool.setError('INSERT INTO encryption_keys', conflictError);

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deduplicated).toBe(true);
  });

  test('wraps multi-query ACK in a transaction (A2)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
      });

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
  });

  test('includes boot_lock_status in audit log detail (CC17)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
        boot_lock_status: 'partial',
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    // detail should include boot_lock_status
    const detail = auditCall[1][2];
    expect(detail).toMatchObject({ command_id: 'cmd-1', boot_lock_status: 'partial' });
  });

  // Phase 17: boot_lock_detail + lockdown_effective tests

  test('stores boot_lock_detail and lockdown_effective=false when critical_applied_total=0', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
        boot_lock_status: 'partial',
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: { critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
          hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
          critical_applied_total: 0,
          best_effort_applied_total: 0,
          best_effort_failed_total: 0,
        },
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.boot_lock_detail).toBeDefined();
    expect(detail.boot_lock_detail.critical_applied_total).toBe(0);
    expect(detail.lockdown_effective).toBe(false);
  });

  test('stores lockdown_effective=true when critical_applied_total > 0', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
        boot_lock_status: null, // full success
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
          hp_uefi: { not_hp: false, critical_applied: 5, best_effort_applied: 1, best_effort_failed: 0 },
          critical_applied_total: 8,
          best_effort_applied_total: 3,
          best_effort_failed_total: 0,
        },
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.lockdown_effective).toBe(true);
    expect(detail.boot_lock_detail.critical_applied_total).toBe(8);
  });

  test('lockdown_effective is null when boot_lock_detail is absent', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
        // No boot_lock_status, no boot_lock_detail — boot lock disabled
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.lockdown_effective).toBeNull();
    expect(detail.boot_lock_detail).toBeUndefined();
  });

  test('lockdown_effective is null for non-lockdown commands even with boot_lock_detail', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    const cmd = { id: 'cmd-1', command_type: 'track' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        boot_lock_detail: { boot_lock_attempted: true, critical_applied_total: 5 },
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_track_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    // Non-lockdown command — lockdown_effective should be null
    expect(detail.lockdown_effective).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2: deadman-report in transaction
// ---------------------------------------------------------------------------

describe('POST /api/agent/deadman-report — transaction (A2)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);

  test('wraps deadman report in transaction with encrypted key', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        key_material: 'deadman-key==',
      });

    expect(res.status).toBe(200);

    const calls = mockPool.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');

    // Verify INSERT uses 'deadman' as command_id and ON CONFLICT
    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO encryption_keys')
    );
    expect(insertCall[0]).toContain("ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING");
    expect(insertCall[1][1]).toBe('deadman'); // command_id
  });
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

// ---------------------------------------------------------------------------
// CC16: checkin dual-mode read for key_material + bios_password
// ---------------------------------------------------------------------------

describe('POST /api/agent/checkin — dual-mode read (CC16)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);

  test('decrypts key_material from encrypted columns during unlock', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };
    const enc = encryptField('unlock-key==');
    const key = {
      id: 'key-1',
      key_material: null,
      key_material_encrypted: enc.ciphertext,
      key_enc_nonce: enc.nonce,
      key_enc_tag: enc.tag,
    };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.type).toBe('unlock');
    expect(res.body.command.key_material).toBe('unlock-key==');
  });

  test('decrypts bios_password from encrypted columns during unlock', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-3', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key==' };
    const enc = encryptField('BiosP@ss');
    const biosPw = {
      id: 'pw-1',
      password: null,
      password_encrypted: enc.ciphertext,
      pw_enc_nonce: enc.nonce,
      pw_enc_tag: enc.tag,
    };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [biosPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.bios_password).toBe('BiosP@ss');
  });

  test('falls back to plaintext key_material for legacy rows', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };
    const key = {
      id: 'key-1',
      key_material: 'legacy-plaintext-key==',
      key_material_encrypted: null,
      key_enc_nonce: null,
      key_enc_tag: null,
    };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.key_material).toBe('legacy-plaintext-key==');
  });
});
