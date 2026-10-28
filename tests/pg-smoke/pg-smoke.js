/**
 * Phase 11 (real): PostgreSQL smoke test — runs the full lockdown → recover
 * flow against a real PostgreSQL instance (not SQLite, not a mock pool).
 *
 * This catches SQL dialect bugs that the SQLite-based Jest suite cannot:
 *   - JSONB vs JSON, gen_random_uuid(), TIMESTAMPTZ, INTERVAL arithmetic
 *   - ON CONFLICT partial-index predicates
 *   - pgcrypto extension availability
 *   - Trigger function syntax (plpgsql)
 *
 * Unlike tests/e2e/setup.js, this does NOT mock the pool to SQLite and does
 * NOT skip HMAC signing — it exercises the real pg.Pool via DATABASE_URL.
 *
 * Usage:
 *   export DATABASE_URL="postgres://user:pass@localhost:5433/lockdown_db"
 *   export DB_SSL=false USE_SQLITE=false
 *   node tests/pg-smoke/pg-smoke.js
 *
 * Exits 0 on success, 1 on any failure. Each step prints [PASS]/[FAIL].
 */

// --- Module resolution ---
// This file lives in tests/pg-smoke/, which has no node_modules and no parent
// node_modules (the repo root one is not installed). Without this, running the
// documented command fails immediately with "Cannot find module 'express'",
// which is why this harness was effectively never executed (S140).
module.paths.unshift(require('path').join(__dirname, '../../server/node_modules'));

// --- Env setup — MUST run before any module that touches the DB pool ---
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ALLOW_NON_PROD = process.env.ALLOW_NON_PROD || '1';
// CRITICAL: do NOT use SQLite — force the real pg.Pool path.
process.env.USE_SQLITE = 'false';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'pg-smoke-secret-key-that-is-long-enough-32';
process.env.AGENT_SHARED_KEY =
  process.env.AGENT_SHARED_KEY || 'pg-smoke-agent-shared-key-long-24';
process.env.AGENT_KEY_PEPPER =
  process.env.AGENT_KEY_PEPPER || 'pg-smoke-pepper-key-long-enough-32';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = process.env.LOCATION_RETENTION_DAYS || '90';
process.env.COMMAND_EXPIRY_DAYS = process.env.COMMAND_EXPIRY_DAYS || '30';
// HMAC is optional in transition, but we exercise it here to validate the
// full signing path against real PG (including the nonce_cache table path).
process.env.REQUIRE_HMAC = 'false';
process.env.USE_DB_NONCE_CACHE = 'true';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// Require AFTER env is set so pool.js picks up DATABASE_URL + USE_SQLITE=false.
const pool = require('../../server/src/db/pool');
const { runMigrations } = require('../../server/src/db/migrationRunner');

const authRoutes = require('../../server/src/routes/auth');
const setupRoutes = require('../../server/src/routes/setup');
const devicesRoutes = require('../../server/src/routes/devices');
const agentRoutes = require('../../server/src/routes/agent');
const auditRoutes = require('../../server/src/routes/audit');

const ADMIN_USERNAME = 'pg-smoke-admin';
const ADMIN_PASSWORD = 'pg-smoke-admin-password-123';

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, label, detail) {
  if (condition) {
    passCount++;
    console.log(`  [PASS] ${label}`);
  } else {
    failCount++;
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(`  [FAIL] ${msg}`);
  }
}

/**
 * Sign a request body with HMAC-SHA256 using the device key.
 * Returns the headers to set on the request.
 *
 * @param {string} deviceKey - the per-device API key (plaintext)
 * @param {object} bodyObj - the request body object (will be JSON.stringify'd
 *   by both this function and supertest's .send(), producing identical bytes)
 */
function hmacHeaders(deviceKey, bodyObj) {
  const bodyString = JSON.stringify(bodyObj);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(bodyString).digest('hex');
  const payload = `${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', deviceKey).update(payload).digest('hex');
  return {
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    'x-sig-version': '1',
  };
}

/**
 * Send an HMAC-signed agent request. Pass the body as an OBJECT — both this
 * function and supertest use JSON.stringify(obj), so the rawBody captured by
 * express.json()'s verify hook matches the bytes we hashed.
 */
function signedAgentRequest(app, method, path, apiKey, bodyObj) {
  const headers = hmacHeaders(apiKey, bodyObj);
  let req = request(app)[method](path).set('x-agent-key', apiKey);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(bodyObj);
}

function createApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/audit', auditRoutes);
  app.use((err, _req, res, _next) => {
    console.error('[pg-smoke] route error:', err && err.message);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

async function run() {
  console.log('PostgreSQL smoke test — full lockdown → recover flow');
  console.log(`DATABASE_URL=${maskUrl(process.env.DATABASE_URL)}`);
  console.log('');

  // --- 0. Verify we're actually connected to Postgres (not SQLite) ---
  console.log('Step 0: Verify real PostgreSQL connection');
  const versionRes = await pool.query('SELECT version()');
  const versionStr = versionRes.rows[0].version;
  assert(
    /PostgreSQL/.test(versionStr),
    'connected to PostgreSQL',
    `got: ${versionStr}`
  );
  console.log(`  version: ${versionStr}`);

  // --- 1. Run migrations against real PG ---
  console.log('Step 1: Run PG migrations');
  const client = await pool.connect();
  try {
    await runMigrations(client, { dialect: 'postgres' });
  } finally {
    client.release();
  }
  // Verify key tables exist (catches silent migration skips)
  const tablesRes = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const tables = tablesRes.rows.map((r) => r.tablename);
  const expectedTables = [
    'admins', 'devices', 'commands', 'encryption_keys', 'bios_passwords',
    'audit_log', 'location_reports', 'schema_migrations', 'nonce_cache',
  ];
  for (const t of expectedTables) {
    assert(tables.includes(t), `table '${t}' exists`);
  }

  // Clean slate — wipe any leftover data from a previous run
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM location_reports');
  await pool.query('DELETE FROM encryption_keys');
  await pool.query('DELETE FROM bios_passwords');
  await pool.query('DELETE FROM commands');
  await pool.query('DELETE FROM devices');
  await pool.query('DELETE FROM admins');
  await pool.query('DELETE FROM nonce_cache');

  const app = createApp();

  // --- 2. Setup admin ---
  console.log('Step 2: Create initial admin via /api/setup/create-admin');
  const createRes = await request(app)
    .post('/api/setup/create-admin')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  assert(createRes.status === 201, 'create-admin returns 201', JSON.stringify(createRes.body));

  // Verify setup is now disabled (403 on second attempt)
  const secondCreate = await request(app)
    .post('/api/setup/create-admin')
    .send({ username: 'evil', password: 'evilpass123' });
  assert(secondCreate.status === 403, 'second create-admin blocked (403)');

  // --- 3. Login ---
  console.log('Step 3: Login');
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  assert(loginRes.status === 200, 'login returns 200', JSON.stringify(loginRes.body));
  assert(!!loginRes.body.token, 'JWT token present');
  assert(
    loginRes.body.admin.role === 'super-admin',
    'first admin is super-admin',
    `got role: ${loginRes.body.admin.role}`
  );
  const token = loginRes.body.token;

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);

  // --- 4. Enroll device ---
  console.log('Step 4: Enroll device');
  const enrollRes = await auth(
    request(app).post('/api/devices').send({ hostname: 'test-laptop-01', owner_name: 'Test Owner' })
  );
  assert(enrollRes.status === 201, 'enroll returns 201', JSON.stringify(enrollRes.body));
  assert(!!enrollRes.body.api_key, 'per-device api_key returned (plaintext once)');
  // 2a984ed stopped returning api_key_hash to clients (publicDevice() strips it,
  // so an attacker cannot brute-force the key offline). This smoke test kept
  // asserting the old shape, so the pg-smoke job failed from that commit onward.
  // Assert the contract that actually matters: absent from the response, present
  // in the database.
  assert(
    !enrollRes.body.api_key_hash,
    'api_key_hash is NOT returned to clients',
    JSON.stringify(enrollRes.body).slice(0, 120)
  );
  const hashRow = await pool.query('SELECT api_key_hash FROM devices WHERE id = $1', [
    enrollRes.body.id,
  ]);
  assert(
    !!(hashRow.rows[0] && hashRow.rows[0].api_key_hash),
    'api_key_hash stored in the DB row',
    JSON.stringify(hashRow.rows[0] || null)
  );
  const deviceId = enrollRes.body.id;
  const apiKey = enrollRes.body.api_key;
  const hostname = enrollRes.body.hostname;

  // --- 5. Agent checkin (HMAC-signed) — no command pending ---
  console.log('Step 5: Agent checkin (HMAC-signed, no pending command)');
  const checkinBody = { hostname, mac_address: 'AA:BB:CC:DD:EE:FF', hardware_uuid: 'test-uuid-1234' };
  const checkinRes = await signedAgentRequest(app, 'post', '/api/agent/checkin', apiKey, checkinBody);
  assert(checkinRes.status === 200, 'checkin returns 200', JSON.stringify(checkinRes.body));
  assert(checkinRes.body.command === null, 'no pending command on first checkin');
  assert(
    checkinRes.body.poll_interval === 300,
    'adaptive poll_interval=300 for active device',
    `got: ${checkinRes.body.poll_interval}`
  );

  // Verify last_checkin was updated (TIMESTAMPTZ write)
  const devAfterCheckin = await pool.query('SELECT last_checkin FROM devices WHERE id = $1', [deviceId]);
  assert(!!devAfterCheckin.rows[0].last_checkin, 'last_checkin populated (TIMESTAMPTZ)');

  // --- 6. Flag stolen → queues lockdown command ---
  console.log('Step 6: Flag device stolen');
  const flagRes = await auth(
    request(app).post(`/api/devices/${deviceId}/flag-stolen`).send({ hostname_confirm: hostname })
  );
  assert(flagRes.status === 200, 'flag-stolen returns 200', JSON.stringify(flagRes.body));
  assert(flagRes.body.device.status === 'stolen', 'device status=stolen');
  assert(!!flagRes.body.command, 'lockdown command queued');
  const lockdownCmdId = flagRes.body.command.id;

  // Verify expires_at was set (INTERVAL arithmetic — PG-specific)
  const cmdRow = await pool.query('SELECT expires_at FROM commands WHERE id = $1', [lockdownCmdId]);
  assert(!!cmdRow.rows[0].expires_at, 'command expires_at set (NOW() + INTERVAL)');

  // --- 7. Agent checkin → receives lockdown command ---
  console.log('Step 7: Agent checkin receives lockdown command');
  const checkin2Body = { hostname };
  const checkin2Res = await signedAgentRequest(app, 'post', '/api/agent/checkin', apiKey, checkin2Body);
  assert(checkin2Res.status === 200, 'checkin returns 200');
  assert(!!checkin2Res.body.command, 'command present');
  assert(
    checkin2Res.body.command.type === 'lockdown',
    'command type=lockdown',
    `got: ${checkin2Res.body.command.type}`
  );
  assert(
    checkin2Res.body.poll_interval === 30,
    'adaptive poll_interval=30 for stolen device',
    `got: ${checkin2Res.body.poll_interval}`
  );

  // --- 8. Agent ACKs lockdown (executed) with key_material + bios_password ---
  console.log('Step 8: Agent ACKs lockdown (encryption key + bios password stored)');
  const fakeKey = 'fernet-key-AAAAAAAAAAAAAAAAAAAAAA==';
  const fakeBiosPw = 'bios-password-12345';
  const ackBody = {
    hostname,
    command_id: lockdownCmdId,
    result_status: 'executed',
    key_material: fakeKey,
    bios_password: fakeBiosPw,
    command_uuid: crypto.randomUUID(),
  };
  const ackRes = await signedAgentRequest(app, 'post', '/api/agent/command-ack', apiKey, ackBody);
  assert(ackRes.status === 200, 'command-ack returns 200', JSON.stringify(ackRes.body));

  // Verify device status flipped to 'locked'
  const devLocked = await pool.query('SELECT status FROM devices WHERE id = $1', [deviceId]);
  assert(devLocked.rows[0].status === 'locked', 'device status=locked after lockdown ACK');

  // Verify encryption key stored (encrypted at rest — dual-mode columns)
  const keyRow = await pool.query(
    'SELECT key_material, key_material_encrypted, key_enc_nonce, key_enc_tag FROM encryption_keys WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1',
    [deviceId]
  );
  assert(!!keyRow.rows[0], 'encryption_keys row inserted');
  assert(
    !!keyRow.rows[0].key_material_encrypted,
    'key_material encrypted at rest (AES-256-GCM)',
    'key_material_encrypted is null'
  );

  // Verify bios password stored encrypted
  const biosRow = await pool.query(
    'SELECT password, password_encrypted, pw_enc_nonce, pw_enc_tag FROM bios_passwords WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1',
    [deviceId]
  );
  assert(!!biosRow.rows[0], 'bios_passwords row inserted');
  assert(
    !!biosRow.rows[0].password_encrypted,
    'bios_password encrypted at rest',
    'password_encrypted is null'
  );

  // --- 9. Recover device → queues unlock command, releases key ---
  console.log('Step 9: Recover device');
  const recoverRes = await auth(
    request(app).post(`/api/devices/${deviceId}/recover`).send({ hostname_confirm: hostname })
  );
  assert(recoverRes.status === 200, 'recover returns 200', JSON.stringify(recoverRes.body));
  assert(recoverRes.body.device.status === 'recovering', 'device status=recovering');
  assert(!!recoverRes.body.command, 'unlock command queued');
  assert(recoverRes.body.key_released === true, 'key released');
  assert(
    recoverRes.body.key_material === fakeKey,
    'key_material returned (decrypted from rest) matches agent-supplied key',
    `got: ${recoverRes.body.key_material}`
  );
  const unlockCmdId = recoverRes.body.command.id;

  // --- 10. Agent checkin → receives unlock command + key_material ---
  console.log('Step 10: Agent checkin receives unlock command + released key');
  const checkin3Body = { hostname };
  const checkin3Res = await signedAgentRequest(app, 'post', '/api/agent/checkin', apiKey, checkin3Body);
  assert(checkin3Res.status === 200, 'checkin returns 200');
  assert(
    checkin3Res.body.command.type === 'unlock',
    'command type=unlock',
    `got: ${checkin3Res.body.command.type}`
  );
  assert(
    checkin3Res.body.command.key_material === fakeKey,
    'unlock command carries released key_material (decrypted)',
    `got: ${checkin3Res.body.command.key_material}`
  );
  assert(
    checkin3Res.body.command.bios_password === fakeBiosPw,
    'unlock command carries bios_password (decrypted)',
    `got: ${checkin3Res.body.command.bios_password}`
  );

  // --- 11. Agent ACKs unlock → device back to active ---
  console.log('Step 11: Agent ACKs unlock');
  const ack2Body = {
    hostname,
    command_id: unlockCmdId,
    result_status: 'executed',
    command_uuid: crypto.randomUUID(),
  };
  const ack2Res = await signedAgentRequest(app, 'post', '/api/agent/command-ack', apiKey, ack2Body);
  assert(ack2Res.status === 200, 'unlock ACK returns 200');
  const devActive = await pool.query('SELECT status FROM devices WHERE id = $1', [deviceId]);
  assert(devActive.rows[0].status === 'active', 'device status=active after unlock ACK');

  // --- 12. Audit log integrity (JSONB writes + hash chain if present) ---
  console.log('Step 12: Audit log entries');
  const auditRes = await auth(request(app).get(`/api/audit?device_id=${deviceId}&limit=500`));
  assert(auditRes.status === 200, 'audit log query returns 200');
  const actions = auditRes.body.map((e) => e.action);
  assert(actions.includes('device_enrolled'), 'audit: device_enrolled');
  assert(actions.includes('flag_stolen'), 'audit: flag_stolen');
  assert(actions.includes('agent_lockdown_confirmed'), 'audit: agent_lockdown_confirmed');
  assert(actions.includes('recover_device'), 'audit: recover_device');
  assert(actions.includes('agent_unlock_confirmed'), 'audit: agent_unlock_confirmed');
  // JSONB detail column should be a real object (not a string)
  const flagEntry = auditRes.body.find((e) => e.action === 'flag_stolen');
  assert(
    flagEntry && typeof flagEntry.detail === 'object',
    'audit detail is JSONB object',
    `got: ${typeof flagEntry?.detail}`
  );

  // --- 13. Replay protection — reuse a nonce → rejected ---
  console.log('Step 13: HMAC replay protection (nonce reuse rejected)');
  // Build headers once, then send the SAME body twice with the same nonce.
  // The first call succeeds; the second is rejected as a replay.
  const replayBody = { hostname };
  const replayHeaders = hmacHeaders(apiKey, replayBody);
  const replayRes1 = await request(app)
    .post('/api/agent/checkin')
    .set('x-agent-key', apiKey)
    .set(replayHeaders)
    .send(replayBody);
  // First use of this nonce: should succeed (200)
  assert(replayRes1.status === 200, 'first use of nonce succeeds (200)');
  const replayRes2 = await request(app)
    .post('/api/agent/checkin')
    .set('x-agent-key', apiKey)
    .set(replayHeaders) // same nonce
    .send(replayBody);
  assert(
    replayRes2.status === 401,
    'replay with same nonce rejected (401)',
    `got: ${replayRes2.status} ${JSON.stringify(replayRes2.body)}`
  );

  // --- 14. Tampered signature → rejected ---
  console.log('Step 14: HMAC tamper detection');
  const tamperBody = { hostname };
  const tamperHeaders = hmacHeaders(apiKey, tamperBody);
  tamperHeaders['x-signature'] = '0'.repeat(64); // wrong signature
  const tamperRes = await request(app)
    .post('/api/agent/checkin')
    .set('x-agent-key', apiKey)
    .set(tamperHeaders)
    .send(tamperBody);
  assert(
    tamperRes.status === 401,
    'tampered signature rejected (401)',
    `got: ${tamperRes.status}`
  );

  // --- 15. Location report (encrypted-at-rest fields) ---
  console.log('Step 15: Location report (encrypted location fields)');
  // First flag stolen again so locate is permitted (status gating)
  await auth(request(app).post(`/api/devices/${deviceId}/flag-stolen`).send({ hostname_confirm: hostname }));
  const locBody = {
    hostname,
    location: {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy_meters: 50,
      source: 'ip',
      city: 'San Francisco',
      region: 'CA',
      country: 'US',
      ip: '203.0.113.42',
      wifi_count: 3,
    },
  };
  const locRes = await signedAgentRequest(app, 'post', '/api/agent/location', apiKey, locBody);
  assert(locRes.status === 200, 'location report returns 200', JSON.stringify(locRes.body));

  // Verify encrypted columns populated
  const locRow = await pool.query(
    'SELECT latitude_enc, longitude_enc, city_enc, ip_address_enc FROM location_reports WHERE device_id = $1 ORDER BY reported_at DESC LIMIT 1',
    [deviceId]
  );
  assert(!!locRow.rows[0], 'location_reports row inserted');
  assert(!!locRow.rows[0].latitude_enc, 'latitude encrypted at rest');
  assert(!!locRow.rows[0].longitude_enc, 'longitude encrypted at rest');
  assert(!!locRow.rows[0].city_enc, 'city encrypted at rest');
  assert(!!locRow.rows[0].ip_address_enc, 'ip_address encrypted at rest');

  // Verify dashboard read path decrypts correctly
  const locHistoryRes = await auth(request(app).get(`/api/devices/${deviceId}/locations?limit=5`));
  assert(locHistoryRes.status === 200, 'location history returns 200');
  assert(
    locHistoryRes.body[0].city === 'San Francisco',
    'location city decrypted for dashboard',
    `got: ${locHistoryRes.body[0].city}`
  );

  // --- Summary ---
  console.log('');
  console.log('=== PostgreSQL Smoke Test Summary ===');
  console.log(`  PASS: ${passCount}  FAIL: ${failCount}`);
  if (failures.length > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  await pool.end();
  process.exit(failCount > 0 ? 1 : 0);
}

function maskUrl(url) {
  if (!url) return '(unset)';
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

run().catch((err) => {
  console.error('[pg-smoke] FATAL:', err);
  try { pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
