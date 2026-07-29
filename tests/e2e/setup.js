/**
 * Phase 7: E2E test setup/teardown helpers.
 *
 * Boots a real Express app backed by an isolated SQLite temp-file database,
 * runs migrations, creates the initial admin account, and logs in to obtain
 * a JWT. Exposes supertest-based helpers that drive the full lockdown /
 * recovery flow against the real route handlers (no DB mocking).
 *
 * Usage (from a test file):
 *
 *   // Each test file must mock the pool BEFORE requiring this module so the
 *   // route handlers resolve `../db/pool` to the SQLite pool.
 *   jest.mock('../../server/src/db/pool', () => require('../../server/src/db/sqlitePool'));
 *   const { bootstrap, shutdown } = require('./setup');
 *
 *   let ctx;
 *   beforeAll(async () => { ctx = await bootstrap(); }, 30000);
 *   afterAll(async () => { await shutdown(ctx); }, 15000);
 *
 * The returned `ctx` object contains: { app, token, pool, dbPath, admin,
 *   apiRequest, createDevice, agentCheckin, flagStolen, recover,
 *   ackCommand, getDevice, getAuditLog }.
 */

// ---------------------------------------------------------------------------
// Env setup — MUST run before any module that touches the DB pool.
// These mirror server/tests/setup.js but are set here so the E2E suite is
// self-contained when run via scripts/run-e2e.sh (which does not load the
// server's jest setupFiles).
// ---------------------------------------------------------------------------
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ALLOW_NON_PROD = '1';
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'e2e-test-secret-key-that-is-long-enough-32';
process.env.AGENT_SHARED_KEY =
  process.env.AGENT_SHARED_KEY || 'e2e-test-agent-shared-key-long-enough-24';
process.env.AGENT_KEY_PEPPER =
  process.env.AGENT_KEY_PEPPER || 'e2e-test-pepper-key-long-enough-32';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
// FA2/FA5: encryption keys for at-rest encryption (32-byte hex = 64 chars)
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = process.env.LOCATION_RETENTION_DAYS || '90';
// HMAC is optional in transition — leave unsigned agent requests allowed so
// the E2E helpers don't have to sign every checkin/ack.
process.env.REQUIRE_HMAC = process.env.REQUIRE_HMAC || 'false';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const sqlitePool = require('../../server/src/db/sqlitePool');
const { runMigrations } = require('../../server/src/db/migrationRunner');

const authRoutes = require('../../server/src/routes/auth');
const setupRoutes = require('../../server/src/routes/setup');
const devicesRoutes = require('../../server/src/routes/devices');
const agentRoutes = require('../../server/src/routes/agent');
const auditRoutes = require('../../server/src/routes/audit');

const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-admin-password-123';

/**
 * Build an Express app that mirrors the production route mounting (minus the
 * rate limiter / scheduler, which are unnecessary for in-process E2E).
 */
function createApp() {
  const app = express();
  // Phase 0: capture raw body for HMAC verification (kept for fidelity even
  // though the E2E helpers send unsigned requests).
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/audit', auditRoutes);
  // Match the production error handler so thrown errors become 500s rather
  // than crashing supertest.
  app.use((err, _req, res, _next) => {
    // eslint-disable-next-line no-console
    console.error('[e2e] route error:', err && err.message);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

/**
 * Boot the E2E environment: fresh temp SQLite DB → migrations → admin → login.
 * @returns {Promise<object>} ctx with app, token, pool, dbPath, and helpers
 */
async function bootstrap() {
  // Fresh temp DB file per bootstrap — guarantees test isolation.
  const dbPath = path.join(
    os.tmpdir(),
    `lockdown-e2e-${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`
  );
  process.env.SQLITE_PATH = dbPath;

  // Run migrations against the SQLite pool (sqlite dialect).
  await runMigrations(sqlitePool, { dialect: 'sqlite' });

  const app = createApp();

  // --- Create the initial admin account via the setup endpoint ---
  const createRes = await request(app)
    .post('/api/setup/create-admin')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  if (createRes.status !== 201) {
    throw new Error(`E2E bootstrap: create-admin failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }

  // --- Login to obtain a JWT ---
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  if (loginRes.status !== 200) {
    throw new Error(`E2E bootstrap: login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.token;

  // --- Helpers (close over app + token) ---
  const apiRequest = (method, pathArg, data, tok) => {
    const req = request(app)[method.toLowerCase()](pathArg);
    if (tok !== undefined) req.set('Authorization', `Bearer ${tok}`);
    else if (token) req.set('Authorization', `Bearer ${token}`);
    if (data !== undefined && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
      req.send(data);
    }
    return req;
  };

  const getDevice = async (deviceId, tok) => {
    const res = await apiRequest('get', `/api/devices/${deviceId}`, undefined, tok);
    return res;
  };

  const createDevice = async (ownerName, hostname) => {
    const res = await apiRequest('post', '/api/devices', {
      hostname,
      owner_name: ownerName,
    });
    return res; // res.body = { ...device, api_key }
  };

  const agentCheckin = async (hostname, apiKey, extra = {}) => {
    const res = await request(app)
      .post('/api/agent/checkin')
      .set('x-agent-key', apiKey)
      .send({ hostname, ...extra });
    return res;
  };

  const flagStolen = async (deviceId, tok, hostnameConfirm) => {
    // recover/flag-stolen require hostname_confirm; auto-fetch if not given.
    let confirm = hostnameConfirm;
    if (!confirm) {
      const dev = await getDevice(deviceId, tok);
      confirm = dev.body.hostname;
    }
    const res = await apiRequest(
      'post',
      `/api/devices/${deviceId}/flag-stolen`,
      { hostname_confirm: confirm },
      tok
    );
    return res;
  };

  const recover = async (deviceId, tok, hostnameConfirm) => {
    let confirm = hostnameConfirm;
    if (!confirm) {
      const dev = await getDevice(deviceId, tok);
      confirm = dev.body.hostname;
    }
    const res = await apiRequest(
      'post',
      `/api/devices/${deviceId}/recover`,
      { hostname_confirm: confirm },
      tok
    );
    return res;
  };

  const ackCommand = async (commandId, hostname, apiKey, opts = {}) => {
    const {
      resultStatus = 'executed',
      keyMaterial,
      biosPassword,
      commandUuid,
    } = opts;
    const res = await request(app)
      .post('/api/agent/command-ack')
      .set('x-agent-key', apiKey)
      .send({
        hostname,
        command_id: commandId,
        result_status: resultStatus,
        key_material: keyMaterial,
        bios_password: biosPassword,
        command_uuid: commandUuid,
      });
    return res;
  };

  const getAuditLog = async (tok, deviceId) => {
    const url = deviceId
      ? `/api/audit?device_id=${encodeURIComponent(deviceId)}&limit=500`
      : '/api/audit?limit=500';
    const res = await apiRequest('get', url, undefined, tok);
    return res;
  };

  return {
    app,
    token,
    pool: sqlitePool,
    dbPath,
    admin: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    apiRequest,
    createDevice,
    agentCheckin,
    flagStolen,
    recover,
    ackCommand,
    getDevice,
    getAuditLog,
  };
}

/**
 * Tear down the E2E environment: close the SQLite pool and remove the temp DB
 * file (plus SQLite sidecar files).
 * @param {object} ctx — the context returned by bootstrap()
 */
async function shutdown(ctx) {
  if (!ctx) return;
  try {
    await ctx.pool.end();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[e2e] pool.end error:', err && err.message);
  }
  // Remove the temp DB and SQLite sidecar files (-wal, -shm).
  for (const suffix of ['', '-wal', '-shm']) {
    const file = ctx.dbPath + suffix;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      // ignore — best-effort cleanup
    }
  }
}

module.exports = {
  bootstrap,
  shutdown,
  createApp,
  // Re-exported so test files can import them directly if needed.
  sqlitePool,
};
