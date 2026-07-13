const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

// We need to require the router AFTER the mock is set up
const agentRoutes = require('../src/routes/agent');

const AGENT_KEY = 'test-agent-key';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// /api/agent/checkin
// ---------------------------------------------------------------------------

describe('POST /api/agent/checkin', () => {
  const app = createApp();

  test('rejects without x-agent-key header', async () => {
    const res = await request(app)
      .post('/api/agent/checkin')
      .send({ hostname: 'DEV-001' });
    expect(res.status).toBe(401);
  });

  test('rejects with wrong x-agent-key', async () => {
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', 'wrong-key')
      .send({ hostname: 'DEV-001' });
    expect(res.status).toBe(401);
  });

  test('returns 400 if hostname missing', async () => {
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 404 if device not registered', async () => {
    // mockPool defaults to { rows: [] }
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'UNKNOWN-DEV' });
    expect(res.status).toBe(404);
  });

  test('matches by MAC address first, then hostname', async () => {
    const device = {
      id: 'dev-1', hostname: 'DEV-001', status: 'active',
      mac_address: 'AA:BB:CC:DD:EE:FF', hardware_uuid: 'hw-uuid-1',
    };
    // findDevice SELECTs by mac/uuid first, then hostname
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        mac_address: 'AA:BB:CC:DD:EE:FF',
        hardware_uuid: 'hw-uuid-1',
      });

    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe('dev-1');
    expect(res.body.status).toBe('active');
    expect(res.body.command).toBeNull();
  });

  test('returns pending command for device', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const command = { id: 'cmd-1', command_type: 'lockdown', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command).toEqual({ id: 'cmd-1', type: 'lockdown', key_material: null, bios_password: null });
  });

  test('attaches key_material for unlock commands', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key-base64==' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.type).toBe('unlock');
    expect(res.body.command.key_material).toBe('fernet-key-base64==');
  });

  test('attaches bios_password for unlock commands', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-3', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key-base64==' };
    const biosPw = { id: 'pw-1', password: 'BiosP@ss123' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [biosPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.type).toBe('unlock');
    expect(res.body.command.bios_password).toBe('BiosP@ss123');
  });

  test('falls back to hostname when MAC/UUID not found', async () => {
    const deviceByMac = { rows: [] }; // no match by MAC
    const deviceByHost = { rows: [{ id: 'dev-2', hostname: 'DEV-002', status: 'active' }] };

    let callCount = 0;
    mockPool.query.mockImplementation(async (sql) => {
      callCount++;
      if (sql.includes('SELECT * FROM devices') && callCount === 1) {
        return deviceByMac; // first SELECT (by MAC) returns empty
      }
      if (sql.includes('SELECT * FROM devices')) {
        return deviceByHost; // second SELECT (by hostname) finds device
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-002', mac_address: 'XX:XX:XX:XX:XX:XX' });

    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe('dev-2');
  });
});

// ---------------------------------------------------------------------------
// /api/agent/command-ack
// ---------------------------------------------------------------------------

describe('POST /api/agent/command-ack', () => {
  const app = createApp();

  test('rejects without agent key', async () => {
    const res = await request(app)
      .post('/api/agent/command-ack')
      .send({ hostname: 'DEV-001', command_id: 'cmd-1', result_status: 'executed' });
    expect(res.status).toBe(401);
  });

  test('returns 400 if required fields missing', async () => {
    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });
    expect(res.status).toBe(400);
  });

  test('returns 404 if device not registered', async () => {
    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', command_id: 'cmd-1', result_status: 'executed' });
    expect(res.status).toBe(404);
  });

  test('stores key_material on lockdown ACK and sets status to locked', async () => {
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
    expect(res.body.ok).toBe(true);

    // Verify key was stored
    const insertKeyCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO encryption_keys')
    );
    expect(insertKeyCall).toBeDefined();
    expect(insertKeyCall[1]).toContain('fernet-key-base64==');

    // Verify status was set to locked
    const statusUpdateCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = 'locked'")
    );
    expect(statusUpdateCall).toBeDefined();
  });

  test('stores bios_password on lockdown ACK', async () => {
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
        bios_password: 'GeneratedBiosPw456',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify bios_password was stored
    const insertBiosPwCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO bios_passwords')
    );
    expect(insertBiosPwCall).toBeDefined();
    expect(insertBiosPwCall[1]).toContain('GeneratedBiosPw456');
  });

  test('sets status to active on unlock ACK (completing recovery)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const cmd = { id: 'cmd-2', command_type: 'unlock' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-2',
        result_status: 'executed',
      });

    expect(res.status).toBe(200);

    // Verify status was set to active
    const statusUpdateCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = 'active'")
    );
    expect(statusUpdateCall).toBeDefined();
  });

  test('does not change status on failed ACK', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        command_id: 'cmd-1',
        result_status: 'failed',
      });

    expect(res.status).toBe(200);

    // Should NOT have any status update
    const statusUpdateCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = 'locked'") ||
           c[0].includes("UPDATE devices SET status = 'active'")
    );
    expect(statusUpdateCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /api/agent/deadman-report
// ---------------------------------------------------------------------------

describe('POST /api/agent/deadman-report', () => {
  const app = createApp();

  test('rejects without agent key', async () => {
    const res = await request(app)
      .post('/api/agent/deadman-report')
      .send({ hostname: 'DEV-001', key_material: 'key==' });
    expect(res.status).toBe(401);
  });

  test('returns 400 if hostname or key_material missing', async () => {
    const res1 = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({ key_material: 'key==' });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });
    expect(res2.status).toBe(400);
  });

  test('returns 404 if device not registered', async () => {
    const res = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', key_material: 'key==' });
    expect(res.status).toBe(404);
  });

  test('stores key, sets status to locked, writes audit log', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        mac_address: 'AA:BB:CC:DD:EE:FF',
        hardware_uuid: 'hw-uuid-1',
        key_material: 'deadman-fernet-key==',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify key was stored
    const insertKeyCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO encryption_keys')
    );
    expect(insertKeyCall).toBeDefined();
    expect(insertKeyCall[1]).toContain('deadman-fernet-key==');

    // Verify status was set to locked
    const statusUpdateCall = mockPool.query.mock.calls.find(
      c => c[0].includes("UPDATE devices SET status = 'locked'")
    );
    expect(statusUpdateCall).toBeDefined();

    // Verify audit log entry
    const auditCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO audit_log') &&
           c[1].includes('agent_deadman_lockdown_confirmed')
    );
    expect(auditCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/location
// ---------------------------------------------------------------------------
describe('POST /api/agent/location', () => {
  const app = createApp();

  test('rejects without agent key', async () => {
    const res = await request(app)
      .post('/api/agent/location')
      .send({ hostname: 'DEV-001', location: { latitude: 1, longitude: 2 } });
    expect(res.status).toBe(401);
  });

  test('returns 400 if hostname or location missing', async () => {
    const res1 = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({ location: { latitude: 1 } });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });
    expect(res2.status).toBe(400);
  });

  test('returns 404 if device not registered', async () => {
    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', location: { latitude: 1, longitude: 2 } });
    expect(res.status).toBe(404);
  });

  test('stores location report', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        mac_address: 'AA:BB:CC:DD:EE:FF',
        hardware_uuid: 'hw-uuid-1',
        location: {
          latitude: 37.7749,
          longitude: -122.4194,
          source: 'wifi',
          accuracy_meters: 25,
          city: 'San Francisco',
          region: 'CA',
          country: 'US',
          wifi_count: 8,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify location was stored
    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO location_reports')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain(37.7749);
    expect(insertCall[1]).toContain(-122.4194);
    expect(insertCall[1]).toContain('wifi');
  });

  test('stores IP-based location with city info', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({
        hostname: 'DEV-001',
        location: {
          latitude: 40.7128,
          longitude: -74.0060,
          source: 'ip',
          city: 'New York',
          region: 'NY',
          country: 'US',
          ip: '1.2.3.4',
          accuracy: 'city',
        },
      });

    expect(res.status).toBe(200);

    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO location_reports')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('New York');
    expect(insertCall[1]).toContain('1.2.3.4');
  });
});
