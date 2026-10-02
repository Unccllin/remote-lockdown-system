/**
 * Tests for Phase 2: Server DB integrity fixes.
 *
 * Covers:
 *   - A4: Idempotent ACK (ON CONFLICT DO NOTHING, 23505 handling)
 *   - A3: Encryption at rest (key_material_encrypted, password_encrypted)
 *   - CC16: Dual-mode read (encrypted vs plaintext fallback)
 *   - A2: withTransaction (BEGIN/COMMIT/ROLLBACK)
 */

const request = require('supertest');
const express = require('express');

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const { encryptField } = require('../src/db/fieldCrypto');
const { clearKeyCache } = require('../src/db/crypto');

const agentRoutes = require('../src/routes/agent');

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';

beforeEach(() => {
  mockPool.query.reset();
  clearKeyCache();
});

afterAll(() => {
  clearKeyCache();
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
    expect(insertBiosCall[1]).toHaveLength(6); // T8: 5 params + password_type
    expect(insertBiosCall[1][1]).toBe('BiosP@ss'); // plaintext
    expect(insertBiosCall[1][2]).toBeDefined(); // ciphertext
    expect(insertBiosCall[1][2]).not.toBe('BiosP@ss');
    expect(insertBiosCall[1][5]).toBe('setup'); // T8: password_type
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

  // D-007: lock_session_context stored in audit log
  test('D-007: stores lock_session_context in audit log detail', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    const cmd = { id: 'cmd-d007', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d007',
        result_status: 'executed',
        key_material: 'k=',
        boot_lock_status: null,
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
          hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
          critical_applied_total: 3,
        },
        lock_session_context: {
          is_session_zero: true,
          session_id: 0,
          platform: 'Windows',
        },
      });

    expect(res.status).toBe(200);

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.lock_session_context).toBeDefined();
    expect(detail.lock_session_context.is_session_zero).toBe(true);
    expect(detail.lock_session_context.session_id).toBe(0);
  });

  test('D-007: audit log detail has lock_session_context undefined when not provided', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    const cmd = { id: 'cmd-d007b', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d007b',
        result_status: 'executed',
        key_material: 'k=',
      });

    expect(res.status).toBe(200);

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.lock_session_context).toBeUndefined();
  });

  // D-008: bitlocker_status stored in boot_lock_detail in audit log
  test('D-008: stores bitlocker_status in boot_lock_detail in audit log', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-d008', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d008',
        result_status: 'executed',
        key_material: 'k=',
        boot_lock_status: 'full',
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: {
            critical_applied: 3,
            best_effort_applied: 2,
            best_effort_failed: 0,
            bitlocker_status: {
              enabled: true,
              percentage: 100,
              suspended: true,
              resumed: true,
            },
          },
          hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
          critical_applied_total: 3,
        },
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.boot_lock_detail).toBeDefined();
    expect(detail.boot_lock_detail.bcd.bitlocker_status).toBeDefined();
    expect(detail.boot_lock_detail.bcd.bitlocker_status.enabled).toBe(true);
    expect(detail.boot_lock_detail.bcd.bitlocker_status.percentage).toBe(100);
  });

  // D-010: sure_admin_status stored in boot_lock_detail in audit log
  test('D-010: stores sure_admin_status in boot_lock_detail in audit log', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-d010', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d010',
        result_status: 'executed',
        key_material: 'k=',
        boot_lock_status: 'partial',
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
          hp_uefi: {
            not_hp: false,
            critical_applied: 2,
            best_effort_applied: 1,
            best_effort_failed: 0,
            sure_admin_status: {
              any_sure_feature: true,
              sure_admin_detected: true,
              sure_run_detected: false,
              sure_start_detected: true,
              warning: 'Sure Admin and Sure Start detected. BIOS changes may be reverted.',
            },
          },
          critical_applied_total: 5,
        },
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.boot_lock_detail).toBeDefined();
    expect(detail.boot_lock_detail.hp_uefi.sure_admin_status).toBeDefined();
    expect(detail.boot_lock_detail.hp_uefi.sure_admin_status.any_sure_feature).toBe(true);
    expect(detail.boot_lock_detail.hp_uefi.sure_admin_status.sure_admin_detected).toBe(true);
    expect(detail.boot_lock_detail.hp_uefi.sure_admin_status.sure_start_detected).toBe(true);
  });

  // D-011: encryption_blocked_files stored in audit log
  test('D-011: stores encryption_blocked_files in audit log detail', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-d011', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d011',
        result_status: 'executed',
        key_material: 'k=',
        boot_lock_status: null,
        boot_lock_detail: {
          boot_lock_attempted: true,
          bcd: { critical_applied: 3, best_effort_applied: 2, best_effort_failed: 0 },
          hp_uefi: { not_hp: true, critical_applied: 0, best_effort_applied: 0, best_effort_failed: 0 },
          critical_applied_total: 3,
        },
        encryption_blocked_files: ['Outlook.pst', 'secret.docx'],
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.encryption_blocked_files).toBeDefined();
    expect(Array.isArray(detail.encryption_blocked_files)).toBe(true);
    expect(detail.encryption_blocked_files).toHaveLength(2);
    expect(detail.encryption_blocked_files).toContain('Outlook.pst');
    expect(detail.encryption_blocked_files).toContain('secret.docx');
  });

  test('D-011: audit log detail has encryption_blocked_files undefined when not provided', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-d011b', command_type: 'lockdown' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-d011b',
        result_status: 'executed',
        key_material: 'k=',
      });

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('agent_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
    const detail = auditCall[1][2];
    expect(detail.encryption_blocked_files).toBeUndefined();
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
