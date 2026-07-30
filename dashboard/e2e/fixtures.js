/**
 * Playwright test fixtures — boot a real backend server (Express + SQLite
 * test DB) on port 3001, seed an admin account + test devices, and provide
 * an authenticated browser context (localStorage token pre-set).
 *
 * The Vite dev server (started by playwright.config.js `webServer`) proxies
 * `/api` requests to http://localhost:3001, so the dashboard UI talks to this
 * backend exactly as it would in production.
 *
 * Cleanup (afterAll): close the HTTP server, close the SQLite pool, and delete
 * the temp DB file (+ sidecar -wal/-shm files).
 */
import { test as base, expect } from '@playwright/test';
import { createRequire } from 'module';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

// Require anchored to this file — used for relative server module imports.
const require = createRequire(import.meta.url);
// Require anchored to the server's source tree so bare specifiers (e.g.
// 'express', 'bcryptjs') resolve from server/node_modules rather than
// dashboard/node_modules (which doesn't contain server-only deps).
const serverRequire = createRequire(
  path.join(path.dirname(new URL(import.meta.url).pathname), '../../server/src/index.js')
);

// ---------------------------------------------------------------------------
// Env setup — MUST run before any server module that touches the DB pool.
// Mirrors tests/e2e/setup.js so the route handlers resolve the SQLite pool.
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
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = process.env.LOCATION_RETENTION_DAYS || '90';
process.env.REQUIRE_HMAC = process.env.REQUIRE_HMAC || 'false';

const sqlitePool = require('../../server/src/db/sqlitePool');
const { runMigrations } = require('../../server/src/db/migrationRunner');
const authRoutes = require('../../server/src/routes/auth');
const setupRoutes = require('../../server/src/routes/setup');
const devicesRoutes = require('../../server/src/routes/devices');
const agentRoutes = require('../../server/src/routes/agent');
const auditRoutes = require('../../server/src/routes/audit');
const healthRoutes = require('../../server/src/routes/health');

const BACKEND_PORT = 3001;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
const ADMIN_USERNAME = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-admin-password-123';

const TEST_DEVICES = [
  { hostname: 'laptop-alpha', owner_name: 'Alice Lee' },
  { hostname: 'laptop-bravo', owner_name: 'Bob Nguyen' },
  { hostname: 'workstation-charlie', owner_name: 'Carol Diaz' },
];

/**
 * Build an Express app mirroring the production route mounting (minus the
 * rate limiter / scheduler, which are unnecessary for E2E).
 */
function createApp() {
  const express = serverRequire('express');
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/health', healthRoutes);
  app.use((err, _req, res, _next) => {
    console.error('[e2e] route error:', err && err.message);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

/**
 * Boot the backend: fresh temp SQLite DB → migrations → listen on port 3001
 * → create admin → login → seed devices.
 *
 * @returns {Promise<object>} ctx with { server, dbPath, token, admin, devices }
 */
async function bootBackend() {
  const dbPath = path.join(
    os.tmpdir(),
    `lockdown-dash-e2e-${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`
  );
  process.env.SQLITE_PATH = dbPath;

  await runMigrations(sqlitePool, { dialect: 'sqlite' });

  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(BACKEND_PORT, (err) => {
      if (err) reject(err);
      else resolve(srv);
    });
    srv.on('error', reject);
  });

  const http = axios.create({ baseURL: BACKEND_URL });

  // Create the initial admin account via the setup endpoint.
  const createRes = await http.post('/api/setup/create-admin', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  if (createRes.status !== 201) {
    throw new Error(
      `E2E bootstrap: create-admin failed: ${createRes.status} ${JSON.stringify(createRes.data)}`
    );
  }

  // Login to obtain a JWT.
  const loginRes = await http.post('/api/auth/login', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `E2E bootstrap: login failed: ${loginRes.status} ${JSON.stringify(loginRes.data)}`
    );
  }
  const token = loginRes.data.token;

  // Seed test devices via the authenticated API.
  const devices = [];
  for (const d of TEST_DEVICES) {
    const res = await http.post(
      '/api/devices',
      { hostname: d.hostname, owner_name: d.owner_name },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status !== 201) {
      throw new Error(
        `E2E bootstrap: create device ${d.hostname} failed: ${res.status} ${JSON.stringify(res.data)}`
      );
    }
    devices.push(res.data);
  }

  return { server, dbPath, token, admin: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD }, devices };
}

/**
 * Tear down: close the HTTP server, close the SQLite pool, delete the temp DB.
 */
async function shutdownBackend(ctx) {
  if (!ctx) return;
  if (ctx.server) {
    await new Promise((resolve) => ctx.server.close(resolve));
  }
  try {
    await sqlitePool.end();
  } catch (err) {
    console.error('[e2e] pool.end error:', err && err.message);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = ctx.dbPath + suffix;
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_err) {
      // best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Playwright fixtures
// ---------------------------------------------------------------------------
let _ctx = null;

/**
 * Authenticated browser context: a fresh context with the JWT pre-seeded into
 * localStorage for the dashboard origin, so protected routes render without
 * going through the login UI.
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  authContext: async ({ browser }, use) => {
    const context = await browser.newContext();
    await context.addInitScript((token) => {
      window.localStorage.setItem('token', token);
    }, _ctx.token);
    await use(context);
    await context.close();
  },
});

export { expect };

/**
 * Suite-scoped setup/teardown. Boots the backend once before all tests in a
 * file and tears it down after. Each spec file imports `test`/`expect` from
 * here and calls `test.beforeAll(startBackend)` / `test.afterAll(stopBackend)`.
 */
export async function startBackend() {
  if (_ctx) return _ctx;
  _ctx = await bootBackend();
  return _ctx;
}

export async function stopBackend() {
  await shutdownBackend(_ctx);
  _ctx = null;
}

/**
 * Convenience accessor for the seeded context (available after startBackend).
 */
export function getCtx() {
  if (!_ctx) {
    throw new Error('Backend not started — call startBackend() in beforeAll first.');
  }
  return _ctx;
}
