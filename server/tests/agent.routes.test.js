const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

// We need to require the router AFTER the mock is set up
const agentRoutes = require('../src/routes/agent');
const { generateApiKey, hashApiKey } = require('../src/db/apiKey');

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return app;
}

/**
 * FA3: Provision a device with a per-device API key for testing.
 * Returns { device, apiKey }.
 * Sets up the mock to return the device when queried by api_key_hash.
 */
function provisionDevice(overrides = {}) {
  const apiKey = overrides.api_key || generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const device = {
    id: overrides.id || 'dev-1',
    hostname: overrides.hostname || 'DEV-001',
    owner_name: overrides.owner_name || 'Test Owner',
    status: overrides.status || 'active',
    mac_address: overrides.mac_address || null,
    hardware_uuid: overrides.hardware_uuid || null,
    api_key_hash: apiKeyHash,
    ...overrides,
  };
  // Remove api_key from device object (not stored in DB)
  delete device.api_key;

  // Set up mock: hash lookup returns the device
  mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [device] });

  return { device, apiKey };
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
    // FA3: Auth succeeds via per-device key, then route validates body
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', apiKey)
      .send({});
    expect(res.status).toBe(400);
  });

  test('returns 401 if device not registered (auth identifies device)', async () => {
    // FA3: With per-device keys, auth and device identification are coupled.
    // If the key doesn't match any device's hash AND the legacy fallback
    // can't find the device, auth fails with 401 (not 404).
    // mockPool defaults to { rows: [] }
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'UNKNOWN-DEV' });
    expect(res.status).toBe(401);
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

  test('returns server_time for deadman anchoring (B-005)', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(typeof res.body.server_time).toBe('number');
    expect(Math.abs(Date.now() / 1000 - res.body.server_time)).toBeLessThan(10);
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
    expect(res.body.command).toEqual({ id: 'cmd-1', type: 'lockdown', key_material: null, bios_password: null, command_uuid: null, power_on_password: null, enable_pba: false, bitlocker_pin: null, bitlocker_recovery_password: null });
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

  test('falls back to hostname when MAC/UUID not found (legacy auth)', async () => {
    // FA3: Legacy shared-key auth path. The hash lookup returns empty,
    // then the legacy fallback finds the device by hostname.
    const device = { id: 'dev-2', hostname: 'DEV-002', status: 'active', api_key_hash: null };

    // Hash lookup returns empty, hostname lookup returns device
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    mockPool.query.setResult('SELECT * FROM devices WHERE hostname', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM devices WHERE (mac_address', { rows: [] });

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
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', apiKey)
      .send({ hostname: 'DEV-001' });
    expect(res.status).toBe(400);
  });

  test('returns 401 if device not registered (auth identifies device)', async () => {
    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', command_id: 'cmd-1', result_status: 'executed' });
    expect(res.status).toBe(401);
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
    const { apiKey } = provisionDevice();
    const res1 = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', apiKey)
      .send({ key_material: 'key==' });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', apiKey)
      .send({ hostname: 'DEV-001' });
    expect(res2.status).toBe(400);
  });

  test('returns 401 if device not registered (auth identifies device)', async () => {
    const res = await request(app)
      .post('/api/agent/deadman-report')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', key_material: 'key==' });
    expect(res.status).toBe(401);
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
    const { apiKey } = provisionDevice();
    const res1 = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', apiKey)
      .send({ location: { latitude: 1 } });
    expect(res1.status).toBe(400);

    const res2 = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', apiKey)
      .send({ hostname: 'DEV-001' });
    expect(res2.status).toBe(400);
  });

  test('returns 401 if device not registered (auth identifies device)', async () => {
    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'NOPE', location: { latitude: 1, longitude: 2 } });
    expect(res.status).toBe(401);
  });

  test('stores location report with encrypted sensitive fields', async () => {
    const { apiKey } = provisionDevice({ hostname: 'DEV-001', status: 'tracking' });

    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', apiKey)
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

    // Verify location was stored with encrypted columns
    const insertCall = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO location_reports')
    );
    expect(insertCall).toBeDefined();
    // FA5: Encrypted columns present in the INSERT
    expect(insertCall[0]).toContain('latitude_enc');
    expect(insertCall[0]).toContain('longitude_enc');
    expect(insertCall[0]).toContain('city_enc');
    // FA5: raw_data NOT in the INSERT
    expect(insertCall[0]).not.toContain('raw_data');
    // Plaintext values still stored in original columns (dual-mode)
    expect(insertCall[1]).toContain(37.7749);
    expect(insertCall[1]).toContain('San Francisco');
  });

  test('stores IP-based location with city info', async () => {
    const { apiKey } = provisionDevice({ hostname: 'DEV-001', status: 'tracking' });

    const res = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', apiKey)
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

// ---------------------------------------------------------------------------
// FA3 / CC5 / CC6: Per-device API key authentication tests
// ---------------------------------------------------------------------------

describe('FA3: Per-device API key authentication', () => {
  const app = createApp();

  test('authenticates with per-device key (hash lookup)', async () => {
    const { device, apiKey } = provisionDevice({ hostname: 'PD-001', status: 'active' });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', apiKey)
      .send({ hostname: 'PD-001' });

    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe(device.id);
  });

  test('rejects with invalid per-device key', async () => {
    const { device } = provisionDevice({ hostname: 'PD-002' });
    // Override: hash lookup checks the hash param — only return device for correct hash
    const correctHash = device.api_key_hash;
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', (sql, params) => {
      if (params[0] === correctHash) return { rows: [device] };
      return { rows: [] };
    });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', 'invalid-key-not-matching')
      .send({ hostname: 'PD-002' });

    expect(res.status).toBe(401);
  });

  test('CC5: legacy shared key works for device without api_key_hash', async () => {
    // Device with api_key_hash = null → legacy fallback succeeds
    const device = { id: 'legacy-1', hostname: 'LEGACY-001', status: 'active', api_key_hash: null };
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    mockPool.query.setResult('SELECT * FROM devices WHERE hostname', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'LEGACY-001' });

    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe('legacy-1');
  });

  test('CC5: shared key rejected for device WITH api_key_hash (per-device fallback)', async () => {
    // Device has api_key_hash → shared key no longer works for it
    const { device } = provisionDevice({ hostname: 'MIGRATED-001' });
    // Override: hash lookup returns empty (wrong key), but device exists
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    mockPool.query.setResult('SELECT * FROM devices WHERE hostname', { rows: [device] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY) // shared key
      .send({ hostname: 'MIGRATED-001' });

    // CC5: shared key rejected because device has api_key_hash
    expect(res.status).toBe(401);
  });

  test('CC6: no x-device-id header required', async () => {
    // CC6: Device is identified by hash lookup, not by x-device-id header
    const { apiKey } = provisionDevice({ hostname: 'NOHEADER-001' });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', apiKey)
      // No x-device-id header
      .send({ hostname: 'NOHEADER-001' });

    expect(res.status).toBe(200);
  });

  test('per-device key works across all agent routes', async () => {
    const { apiKey } = provisionDevice({ hostname: 'ALLROUTES-001', status: 'stolen' });
    const cmd = { id: 'cmd-1', command_type: 'lockdown' };
    mockPool.query.setResult('SELECT command_type FROM commands', { rows: [cmd] });

    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', apiKey)
      .send({
        hostname: 'ALLROUTES-001',
        command_id: 'cmd-1',
        result_status: 'executed',
        key_material: 'fernet-key==',
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FA3: Key rotation tests
// ---------------------------------------------------------------------------

describe('FA3: Key rotation (POST /api/devices/:id/rotate-key)', () => {
  const { mockPool } = require('./helpers');
  const deviceRoutes = require('../src/routes/devices');

  function createAdminApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/devices', deviceRoutes);
    return app;
  }

  const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-long-enough-for-validation-32';
  function adminToken(adminId = 'admin-1') {
    return jwt.sign({ id: adminId, username: 'admin', role: 'super-admin' }, JWT_SECRET);
  }

  beforeEach(() => {
    mockPool.query.reset();
  });

  test('rotates API key and returns new plaintext', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', api_key_hash: 'old-hash' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });

    const app = createAdminApp();
    const res = await request(app)
      .post('/api/devices/dev-1/rotate-key')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.api_key).toBeDefined();
    expect(res.body.api_key).not.toBe('old-hash');
    expect(res.body.device_id).toBe('dev-1');

    // Verify UPDATE was called
    const updateCall = mockPool.query.mock.calls.find(
      c => c[0].includes('UPDATE devices SET api_key_hash')
    );
    expect(updateCall).toBeDefined();
  });

  test('returns 404 for non-existent device', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [] });

    const app = createAdminApp();
    const res = await request(app)
      .post('/api/devices/nonexistent/rotate-key')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
  });

  test('requires admin auth', async () => {
    const app = createAdminApp();
    const res = await request(app)
      .post('/api/devices/dev-1/rotate-key');

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// T7/T8: PBA — Power-On Password and enable_pba flag
// ---------------------------------------------------------------------------

describe('T7/T8: PBA — Power-On Password and enable_pba flag', () => {
  const app = createApp();

  test('checkin returns enable_pba=true for lockdown command with PBA', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const command = { id: 'cmd-1', command_type: 'lockdown', status: 'pending', enable_pba: true };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.enable_pba).toBe(true);
  });

  test('checkin returns enable_pba=false for lockdown command without PBA', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const command = { id: 'cmd-1', command_type: 'lockdown', status: 'pending' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.enable_pba).toBe(false);
  });

  test('checkin returns power_on_password for unlock when PBA was active', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key==' };
    const setupPw = { id: 'pw-1', password: 'SetupPw123', password_type: 'setup' };
    const popPw = { id: 'pw-2', password: 'PopPw456', password_type: 'power_on' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [popPw, setupPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.type).toBe('unlock');
    expect(res.body.command.bios_password).toBe('SetupPw123');
    expect(res.body.command.power_on_password).toBe('PopPw456');
  });

  test('checkin returns null power_on_password when PBA was not active', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-3', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key==' };
    const setupPw = { id: 'pw-1', password: 'SetupPw123', password_type: 'setup' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [setupPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.bios_password).toBe('SetupPw123');
    expect(res.body.command.power_on_password).toBeNull();
  });

  test('command-ack stores power_on_password with password_type=power_on', async () => {
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
        bios_password: 'SetupPw789',
        power_on_password: 'PopPw000',
      });

    expect(res.status).toBe(200);

    // Verify both passwords were stored with correct password_type
    const insertCalls = mockPool.query.mock.calls.filter(
      c => c[0].includes('INSERT INTO bios_passwords')
    );
    expect(insertCalls.length).toBe(2);

    // Find the power_on insert
    const popInsert = insertCalls.find(c => c[1].includes('power_on'));
    expect(popInsert).toBeDefined();
    expect(popInsert[1]).toContain('PopPw000');

    // Find the setup insert
    const setupInsert = insertCalls.find(c => c[1].includes('setup'));
    expect(setupInsert).toBeDefined();
    expect(setupInsert[1]).toContain('SetupPw789');
  });

  test('command-ack stores bios_password with password_type=setup (no power_on_password)', async () => {
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
        bios_password: 'SetupPwOnly',
      });

    expect(res.status).toBe(200);

    // Verify only one bios_password insert (setup only, no power_on)
    const insertCalls = mockPool.query.mock.calls.filter(
      c => c[0].includes('INSERT INTO bios_passwords')
    );
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0][1]).toContain('setup');
    expect(insertCalls[0][1]).toContain('SetupPwOnly');
  });

  test('command-ack without power_on_password does not insert power_on row', async () => {
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
        bios_password: 'JustSetup',
      });

    expect(res.status).toBe(200);

    // Verify no power_on insert
    const popInsert = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO bios_passwords') && c[1].includes('power_on')
    );
    expect(popInsert).toBeUndefined();
  });

  // T9: BitLocker TPM+PIN credential storage

  test('T9: command-ack stores bitlocker_pin with password_type=bitlocker_pin', async () => {
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
        bios_password: 'SetupPw',
        power_on_password: 'PopPw',
        bitlocker_pin: '123456',
        bitlocker_recovery_password: '111111-222222-333333-444444-555555-666666-777777-888888',
      });

    expect(res.status).toBe(200);

    // Verify bitlocker_pin insert
    const pinInsert = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO bios_passwords') && c[1].includes('bitlocker_pin')
    );
    expect(pinInsert).toBeDefined();
    expect(pinInsert[1]).toContain('123456');

    // Verify bitlocker_recovery insert
    const recInsert = mockPool.query.mock.calls.find(
      c => c[0].includes('INSERT INTO bios_passwords') && c[1].includes('bitlocker_recovery')
    );
    expect(recInsert).toBeDefined();
    expect(recInsert[1]).toContain('111111-222222-333333-444444-555555-666666-777777-888888');
  });

  test('T9: checkin returns bitlocker_pin for unlock when PBA was active', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-2', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key==' };
    const setupPw = { id: 'pw-1', password: 'SetupPw', password_type: 'setup' };
    const pinPw = { id: 'pw-2', password: '123456', password_type: 'bitlocker_pin' };
    const recPw = {
      id: 'pw-3',
      password: '111111-222222-333333-444444-555555-666666-777777-888888',
      password_type: 'bitlocker_recovery',
    };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [recPw, pinPw, setupPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.type).toBe('unlock');
    expect(res.body.command.bios_password).toBe('SetupPw');
    expect(res.body.command.bitlocker_pin).toBe('123456');
    expect(res.body.command.bitlocker_recovery_password).toBe(
      '111111-222222-333333-444444-555555-666666-777777-888888'
    );
  });

  test('T9: checkin returns null bitlocker credentials when PBA was not active', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'recovering' };
    const command = { id: 'cmd-3', command_type: 'unlock', status: 'pending' };
    const key = { id: 'key-1', key_material: 'fernet-key==' };
    const setupPw = { id: 'pw-1', password: 'SetupPw', password_type: 'setup' };

    mockPool.query.setResult('SELECT * FROM devices', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [command] });
    mockPool.query.setResult('SELECT * FROM encryption_keys', { rows: [key] });
    mockPool.query.setResult('SELECT * FROM bios_passwords', { rows: [setupPw] });

    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', AGENT_KEY)
      .send({ hostname: 'DEV-001' });

    expect(res.status).toBe(200);
    expect(res.body.command.bitlocker_pin).toBeNull();
    expect(res.body.command.bitlocker_recovery_password).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S0.6 (B-006): /api/agent/update detached-signature signing
// ---------------------------------------------------------------------------

describe('S0.6: GET /api/agent/update — detached Ed25519 signature', () => {
  const app = createApp();
  const crypto = require('crypto');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const savedKey = process.env.UPDATE_SIGNING_KEY;

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env.UPDATE_SIGNING_KEY;
    } else {
      process.env.UPDATE_SIGNING_KEY = savedKey;
    }
  });

  function agentUpdate(apiKey) {
    return request(app)
      .get('/api/agent/update')
      .set('x-agent-key', apiKey)
      .set('x-agent-version', '0.9.0');
  }

  test('signs update metadata when UPDATE_SIGNING_KEY is set (inline PEM)', async () => {
    const { apiKey } = provisionDevice();
    process.env.UPDATE_SIGNING_KEY = privPem;

    const res = await agentUpdate(apiKey);
    expect(res.status).toBe(200);
    expect(res.body.update_available).toBe(true);
    expect(res.body.signature_alg).toBe('ed25519');
    expect(typeof res.body.signature).toBe('string');

    // Signature must verify over exactly "v1:{version}:{sha256}"
    const payload = `v1:${res.body.latest_version}:${res.body.sha256}`;
    const ok = crypto.verify(
      null,
      Buffer.from(payload),
      pubPem,
      Buffer.from(res.body.signature, 'base64')
    );
    expect(ok).toBe(true);
  });

  test('sha256 in response binds the actual binary file', async () => {
    const { apiKey } = provisionDevice();
    process.env.UPDATE_SIGNING_KEY = privPem;

    const res = await agentUpdate(apiKey);
    expect(res.status).toBe(200);

    const binPath = path.join(
      __dirname, '..', '..', 'agent', 'dist', 'lockdown-agent'
    );
    const actual = crypto
      .createHash('sha256')
      .update(fs.readFileSync(binPath))
      .digest('hex');
    expect(res.body.sha256).toBe(actual);
  });

  test('accepts UPDATE_SIGNING_KEY as a filesystem path', async () => {
    const { apiKey } = provisionDevice();
    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'updkey-')), 'key.pem');
    fs.writeFileSync(keyFile, privPem);
    process.env.UPDATE_SIGNING_KEY = keyFile;

    const res = await agentUpdate(apiKey);
    expect(res.status).toBe(200);
    expect(res.body.signature_alg).toBe('ed25519');

    const payload = `v1:${res.body.latest_version}:${res.body.sha256}`;
    expect(
      crypto.verify(null, Buffer.from(payload), pubPem,
        Buffer.from(res.body.signature, 'base64'))
    ).toBe(true);
  });

  test('fails closed (500) when configured signing key is broken', async () => {
    const { apiKey } = provisionDevice();
    process.env.UPDATE_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\nbroken\n-----END PRIVATE KEY-----\n';

    const res = await agentUpdate(apiKey);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('update signing failed');
    // Must NOT serve an unsigned update
    expect(res.body.sha256).toBeUndefined();
  });

  test('no signing key → signature null (degraded compatibility mode)', async () => {
    const { apiKey } = provisionDevice();
    delete process.env.UPDATE_SIGNING_KEY;

    const res = await agentUpdate(apiKey);
    expect(res.status).toBe(200);
    expect(res.body.signature).toBeNull();
    expect(res.body.signature_alg).toBeNull();
  });
});
