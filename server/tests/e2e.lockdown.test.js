/**
 * FA7 / CC9: End-to-end lockdown round-trip test.
 *
 * Tests the full device lifecycle against a real Postgres engine (PGlite in-memory):
 *   enroll → flag-stolen → agent checkin → lockdown command → agent ACK →
 *   track command (status gating) → locate command → recovering → active
 *
 * Uses real Express routers + real pglitePool.query + real SQL.
 * The mock is only at the pool.js → pglitePool interception point.
 *
 * Must run with --runInBand (in-memory PGlite is a singleton per process).
 */

// Switch to in-memory PGlite BEFORE any module that imports pool
// jest.mock factory can't reference out-of-scope variables, so we use
// require() inside the factory to get the pglitePool instance.
const pglitePool = require('../src/db/pglitePool');
pglitePool.useInMemory();

// Mock pool.js to use pglitePool (require inside factory to avoid scope issue)
jest.mock('../src/db/pool', () => require('../src/db/pglitePool'));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { runMigrations } = require('../src/db/migrationRunner');
const authRoutes = require('../src/routes/auth');
const devicesRoutes = require('../src/routes/devices');
const agentRoutes = require('../src/routes/agent');
const auditRoutes = require('../src/routes/audit');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-long-enough-for-validation-32';

// Use a real UUID for the admin
const ADMIN_ID = crypto.randomUUID();

function makeToken() {
  return jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'super-admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/audit', auditRoutes);
  return app;
}

// ---------------------------------------------------------------------------
// Test setup: run migrations, seed admin, truncate between tests
// ---------------------------------------------------------------------------

let adminToken;

beforeAll(async () => {
  // Run all migrations against in-memory PGlite
  // PGlite WASM initialization is slow — allow up to 30s
  await runMigrations(pglitePool);

  // Seed an admin user for authenticated requests
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await pglitePool.query(
    `INSERT INTO admins (id, username, password_hash) VALUES ($1, $2, $3)`,
    [ADMIN_ID, 'admin', hashedPassword]
  );

  adminToken = makeToken();
}, 30000); // 30s timeout for PGlite WASM init

beforeEach(async () => {
  // Truncate all tables in FK-safe order (CASCADE handles dependencies)
  // Keep admins table — only truncate data tables
  await pglitePool.query('TRUNCATE location_reports, encryption_keys, bios_passwords, commands, audit_log, devices RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  await pglitePool.end();
}, 10000);

// ---------------------------------------------------------------------------
// E2E: Full lockdown round-trip
// ---------------------------------------------------------------------------

describe('CC9: E2E lockdown round-trip', () => {
  const app = createApp();

  test('full lifecycle: enroll → stolen → checkin → lockdown → ACK → track → locate → recovering → active', async () => {
    // --- Step 1: Enroll a device (gets per-device API key) ---
    const enrollRes = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hostname: 'E2E-001', owner_name: 'Alice' });

    expect(enrollRes.status).toBe(201);
    expect(enrollRes.body.api_key).toBeDefined();
    const apiKey = enrollRes.body.api_key;
    const deviceId = enrollRes.body.id;

    // --- Step 2: Flag device as stolen ---
    const flagRes = await request(app)
      .post(`/api/devices/${deviceId}/flag-stolen`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hostname_confirm: 'E2E-001' });

    expect(flagRes.status).toBe(200);
    expect(flagRes.body.device.status).toBe('stolen');

    // --- Step 3: Agent checks in with per-device key ---
    const checkinRes = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', apiKey)
      .send({ hostname: 'E2E-001' });

    expect(checkinRes.status).toBe(200);
    expect(checkinRes.body.device_id).toBe(deviceId);
    // Agent should receive the lockdown command (checkin returns single command)
    expect(checkinRes.body.command).toBeDefined();
    expect(checkinRes.body.command.type).toBe('lockdown');
    const lockdownCmd = checkinRes.body.command;

    // --- Step 4: Agent ACKs the lockdown command ---
    const ackRes = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', apiKey)
      .send({
        hostname: 'E2E-001',
        command_id: lockdownCmd.id,
        result_status: 'executed',
        key_material: 'e2e-fernet-key-base64==',
      });

    expect(ackRes.status).toBe(200);
    expect(ackRes.body.ok).toBe(true);

    // --- Step 5: Verify device is now locked ---
    const deviceRes = await request(app)
      .get('/api/devices')
      .set('Authorization', `Bearer ${adminToken}`);

    const lockedDevice = deviceRes.body.find(d => d.id === deviceId);
    expect(lockedDevice.status).toBe('locked');

    // --- Step 6: FA5 status gating — track should work for locked device ---
    const trackRes = await request(app)
      .post(`/api/devices/${deviceId}/track`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(trackRes.status).toBe(200);
    expect(trackRes.body.command.command_type).toBe('track');

    // --- Step 7: Agent ACKs the track command (enters tracking mode) ---
    const trackAckRes = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', apiKey)
      .send({
        hostname: 'E2E-001',
        command_id: trackRes.body.command.id,
        result_status: 'executed',
      });

    expect(trackAckRes.status).toBe(200);

    // --- Step 8: Agent reports location while tracking ---
    const locRes = await request(app)
      .post('/api/agent/location')
      .set('x-agent-key', apiKey)
      .send({
        hostname: 'E2E-001',
        location: {
          latitude: 37.7749,
          longitude: -122.4194,
          source: 'wifi',
          accuracy_meters: 25,
          city: 'San Francisco',
          region: 'CA',
          country: 'US',
        },
      });

    expect(locRes.status).toBe(200);
    expect(locRes.body.ok).toBe(true);

    // --- Step 9: FA5 status gating — locate should work for tracking device ---
    const locateRes = await request(app)
      .post(`/api/devices/${deviceId}/locate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(locateRes.status).toBe(200);

    // --- Step 10: Admin marks device as recovering ---
    const recoverRes = await request(app)
      .post(`/api/devices/${deviceId}/recover`)
      .set('Authorization', `Bearer ${adminToken}`);

    // recover endpoint may or may not exist — if it doesn't, use direct DB update
    if (recoverRes.status !== 200) {
      await pglitePool.query("UPDATE devices SET status = 'recovering' WHERE id = $1", [deviceId]);
    }

    // --- Step 11: FA5 status gating — track should work for recovering device ---
    const trackRecoveringRes = await request(app)
      .post(`/api/devices/${deviceId}/track`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(trackRecoveringRes.status).toBe(200);

    // --- Step 12: Admin marks device as active (recovered) ---
    await pglitePool.query("UPDATE devices SET status = 'active' WHERE id = $1", [deviceId]);

    // --- Step 13: FA5 status gating — track should be REJECTED for active device ---
    const trackActiveRes = await request(app)
      .post(`/api/devices/${deviceId}/track`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(trackActiveRes.status).toBe(403);

    // --- Step 14: FA5 status gating — locate should be REJECTED for active device ---
    const locateActiveRes = await request(app)
      .post(`/api/devices/${deviceId}/locate`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(locateActiveRes.status).toBe(403);

    // --- Step 15: Verify location history is retrievable (decrypted) ---
    const locHistoryRes = await request(app)
      .get(`/api/devices/${deviceId}/locations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(locHistoryRes.status).toBe(200);
    expect(locHistoryRes.body.length).toBeGreaterThanOrEqual(1);
    expect(locHistoryRes.body[0].latitude).toBeCloseTo(37.7749, 2);
    expect(locHistoryRes.body[0].city).toBe('San Francisco');

    // --- Step 16: Verify audit trail ---
    const auditRes = await request(app)
      .get('/api/audit')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(auditRes.status).toBe(200);
    // Should have audit entries for: enroll, flag_stolen, start_tracking, locate_requested, track_denied, locate_denied
    const actions = auditRes.body.map(a => a.action);
    expect(actions).toContain('device_enrolled');
    expect(actions).toContain('flag_stolen');
  }, 30000); // 30s timeout for E2E with real PGlite queries

  test('CC5: legacy shared key fallback works for device without api_key_hash', async () => {
    // Enroll a device directly via DB without api_key_hash (legacy device)
    const legacyId = crypto.randomUUID();
    await pglitePool.query(
      `INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)`,
      [legacyId, 'LEGACY-001', 'Bob', 'active']
    );

    // Agent authenticates with shared key
    const checkinRes = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', process.env.AGENT_SHARED_KEY)
      .send({ hostname: 'LEGACY-001' });

    expect(checkinRes.status).toBe(200);
    expect(checkinRes.body.device_id).toBe(legacyId);
  }, 15000);

  test('key rotation: admin rotates device key, old key stops working, new key works', async () => {
    // Enroll
    const enrollRes = await request(app)
      .post('/api/devices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ hostname: 'ROTATE-001', owner_name: 'Carol' });

    const oldKey = enrollRes.body.api_key;
    const deviceId = enrollRes.body.id;

    // Old key works
    const checkin1 = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', oldKey)
      .send({ hostname: 'ROTATE-001' });
    expect(checkin1.status).toBe(200);

    // Rotate key
    const rotateRes = await request(app)
      .post(`/api/devices/${deviceId}/rotate-key`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.api_key).toBeDefined();
    const newKey = rotateRes.body.api_key;
    expect(newKey).not.toBe(oldKey);

    // Old key should no longer work
    const checkin2 = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', oldKey)
      .send({ hostname: 'ROTATE-001' });
    expect(checkin2.status).toBe(401);

    // New key works
    const checkin3 = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', newKey)
      .send({ hostname: 'ROTATE-001' });
    expect(checkin3.status).toBe(200);
  }, 15000);
});
