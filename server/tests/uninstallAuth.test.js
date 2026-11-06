/**
 * Tests for the uninstall-authorization routes:
 *   POST /api/agent/uninstall-auth         — issue a short-lived token
 *   POST /api/agent/uninstall-auth/verify  — verify one
 *
 * Two things are pinned here, and both were broken or unproven before S252:
 *
 * 1. **The header contract.** `agent/tamper_protection.py` sends the device key in
 *    `X-API-Key` (plus a bearer token), while the Worker reads `X-API-Key` and this
 *    Express router read only `x-agent-key` — and its bearer fallback compares
 *    against ADMIN_TOKEN, which a device key is not. Against a self-hosted server
 *    both routes therefore answered 401 to the agent that owns them, so an uninstall
 *    could never obtain a token. Nothing failed, because no server test covered
 *    either route and the cross-surface contract test compares route paths only.
 *
 * 2. **The token is never echoed.** The agent logs the response body of a failed
 *    token request (`tamper_protection.py`, `except HTTPError`), so any error path
 *    that repeats what was sent writes the credential into the agent's log. These
 *    tests assert that no response body contains the presented key or token.
 */

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const agentRoutes = require('../src/routes/agent');
const { generateApiKey, hashApiKey } = require('../src/db/apiKey');

const ADMIN_TOKEN = 'test-admin-token-for-uninstall-auth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return app;
}

/** Provision a device whose per-device key resolves through the hash lookup. */
function provisionDevice(overrides = {}) {
  const apiKey = overrides.api_key || generateApiKey();
  const device = {
    id: overrides.id || 'dev-uninstall-1',
    hostname: overrides.hostname || 'DEV-UNINSTALL-1',
    status: 'active',
    api_key_hash: hashApiKey(apiKey),
    ...overrides,
  };
  delete device.api_key;
  mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [device] });
  return { device, apiKey };
}

/** The token the server derives for the current window (the scheme itself). */
function expectedToken() {
  const window = Math.floor(Math.floor(Date.now() / 1000) / 300) * 300;
  return crypto.createHmac('sha256', ADMIN_TOKEN).update(String(window)).digest('hex');
}

const app = createApp();
let savedAdminToken;

beforeEach(() => {
  mockPool.query.reset();
  savedAdminToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});

afterEach(() => {
  if (savedAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = savedAdminToken;
});

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

describe('POST /api/agent/uninstall-auth — issuing', () => {
  test('401 without any credential', async () => {
    const res = await request(app).post('/api/agent/uninstall-auth');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication required/);
    // The failure must not hand out a token by accident.
    expect(res.body.uninstall_token).toBeUndefined();
  });

  test('the bearer fallback does not accept a device key', async () => {
    // Documented intent: without x-agent-key, only ADMIN_TOKEN authorises. A device
    // key in a bearer header is not the admin token, so this must stay 401 — that is
    // exactly why the agent's X-API-Key header has to be understood explicitly.
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/uninstall-auth')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
  });

  test('issues a token for a per-device key in x-agent-key (the documented contract)', async () => {
    const { apiKey } = provisionDevice();
    const res = await request(app).post('/api/agent/uninstall-auth').set('x-agent-key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.uninstall_token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.expires_in).toBe(300);
  });

  test('issues a token for the header the agent actually sends (X-API-Key)', async () => {
    // This is the regression: agent/tamper_protection.py has always sent X-API-Key,
    // so every self-hosted uninstall answered 401 and the token flow was dead.
    const { apiKey } = provisionDevice();
    const res = await request(app).post('/api/agent/uninstall-auth').set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.uninstall_token).toMatch(/^[a-f0-9]{64}$/);
  });

  test('an unknown key gets 401 and the body never echoes it', async () => {
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    const stranger = 'not-a-real-device-key-0123456789';

    const res = await request(app).post('/api/agent/uninstall-auth').set('X-API-Key', stranger);

    expect(res.status).toBe(401);
    expect(res.text).not.toContain(stranger);
    expect(res.text).not.toContain(hashApiKey(stranger));
  });
});

// ---------------------------------------------------------------------------
// Verifying
// ---------------------------------------------------------------------------

describe('POST /api/agent/uninstall-auth/verify — verifying', () => {
  test('accepts the current window token', async () => {
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: expectedToken(), device_id: 'dev-uninstall-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true, verified: true });
  });

  test('rejects a wrong token without echoing it', async () => {
    const { apiKey } = provisionDevice();
    const wrong = 'f'.repeat(64);
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: wrong });

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    // The decisive assertion: a rejection must not repeat the candidate token back.
    expect(res.text).not.toContain(wrong);
  });

  test('a 400 for a missing token does not echo the rest of the body', async () => {
    const { apiKey } = provisionDevice();
    const candidate = 'still-a-secret-candidate';
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token_candidate: candidate });

    expect(res.status).toBe(400);
    expect(res.text).not.toContain(candidate);
  });

  test('an unauthenticated request carrying a token never echoes it', async () => {
    // The agent verifies with a token in the body; if authentication fails, the 401
    // body must not repeat the token — that body is logged verbatim by the agent.
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    const token = expectedToken();

    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', 'wrong-key-entirely-0123456789')
      .send({ uninstall_token: token });

    expect(res.status).toBe(401);
    expect(res.text).not.toContain(token);
  });
});
