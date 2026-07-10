const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const devicesRoutes = require('../src/routes/devices');

const JWT_SECRET = 'test-secret-key';

function makeToken(adminId = 'admin-1', username = 'admin') {
  return jwt.sign({ id: adminId, username }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// GET /api/devices
// ---------------------------------------------------------------------------

describe('GET /api/devices', () => {
  const app = createApp();

  test('rejects without auth token', async () => {
    const res = await request(app).get('/api/devices');
    expect(res.status).toBe(401);
  });

  test('returns list of devices', async () => {
    const devices = [
      { id: 'dev-1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active' },
      { id: 'dev-2', hostname: 'DEV-002', owner_name: 'Bob', status: 'locked' },
    ];
    mockPool.query.setResult('SELECT * FROM devices ORDER BY', { rows: devices });

    const res = await request(app)
      .get('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].hostname).toBe('DEV-001');
  });
});

// ---------------------------------------------------------------------------
// POST /api/devices (enroll)
// ---------------------------------------------------------------------------

describe('POST /api/devices (enroll)', () => {
  const app = createApp();

  test('creates a new device and audit log entry', async () => {
    const newDevice = { id: 'dev-new', hostname: 'DEV-NEW', owner_name: 'Charlie', status: 'active' };
    mockPool.query.setResult('INSERT INTO devices', { rows: [newDevice] });

    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'DEV-NEW', owner_name: 'Charlie' });

    expect(res.status).toBe(201);
    expect(res.body.hostname).toBe('DEV-NEW');

    // Verify audit log was written
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') && c[1].includes('device_enrolled')
    );
    expect(auditCall).toBeDefined();
  });

  test('returns 400 if hostname or owner_name missing', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'DEV-NEW' });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/devices/:id/flag-stolen
// ---------------------------------------------------------------------------

describe('POST /api/devices/:id/flag-stolen', () => {
  const app = createApp();

  test('flags device as stolen and queues lockdown command', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', owner_name: 'Alice', status: 'active' };
    const cmd = { id: 'cmd-1', device_id: 'dev-1', command_type: 'lockdown', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.device.status).toBe('stolen');
    expect(res.body.command.command_type).toBe('lockdown');

    // Verify status was updated to stolen
    const statusCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = $1") && c[1][0] === 'stolen'
    );
    expect(statusCall).toBeDefined();
  });

  test('rejects if hostname_confirm does not match', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'WRONG-HOSTNAME' });

    expect(res.status).toBe(400);
  });

  test('rejects if device already stolen', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/flag-stolen')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /api/devices/:id/recover
// ---------------------------------------------------------------------------

describe('POST /api/devices/:id/recover', () => {
  const app = createApp();

  test('sets status to recovering (not active) and queues unlock', async () => {
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
    // KEY FIX: status should be 'recovering', NOT 'active'
    expect(res.body.device.status).toBe('recovering');
    expect(res.body.command.command_type).toBe('unlock');
    expect(res.body.key_released).toBe(true);
    expect(res.body.key_material).toBe('fernet-key==');

    // Verify status was set to recovering
    const statusCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = $1") && c[1][0] === 'recovering'
    );
    expect(statusCall).toBeDefined();
  });

  test('allows recovery from locked status (not just stolen)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'locked' };
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
    expect(res.body.device.status).toBe('recovering');
  });

  test('rejects if device is already active', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(409);
  });

  test('rejects if device is already recovering', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    expect(res.status).toBe(409);
  });

  test('rejects if hostname_confirm does not match', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'WRONG' });

    expect(res.status).toBe(400);
  });

  test('marks encryption key as released', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const key = { id: 'key-1', key_material: 'fernet-key==', released_at: null };
    const cmd = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    await request(app)
      .post('/api/devices/dev-1/recover')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname_confirm: 'DEV-001' });

    const releaseCall = mockPool.query.mock.calls.find(
      c => c[0].includes('UPDATE encryption_keys SET released_at')
    );
    expect(releaseCall).toBeDefined();
  });
});
