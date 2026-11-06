/**
 * Tests for the uninstall-authorization routes:
 *   POST /api/agent/uninstall-auth         — issue a short-lived token
 *   POST /api/agent/uninstall-auth/verify  — verify one
 *
 * Three things are pinned here.
 *
 * 1. **The header contract** (S252). `agent/tamper_protection.py` sends the device key in
 *    `X-API-Key`, while this router originally read only `x-agent-key` and compared a bearer
 *    token against ADMIN_TOKEN — so on a self-hosted server both routes answered 401 to the
 *    agent that owns them and no uninstall could ever obtain a token.
 *
 * 2. **The token is never echoed** (S252). The agent logs a failed token request's response
 *    body verbatim, so no error path may repeat what was sent.
 *
 * 3. **The D-221 scheme** (S254): the token is bound to ONE device, derived exactly as
 *    `docs/adr/D-221-token-vectors.json` says, refused when no secret is configured, compared
 *    in constant time, and the previous deployment-wide scheme still verifies for one release
 *    (ruling Q2-A) while it is logged.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const agentRoutes = require('../src/routes/agent');
const { generateApiKey, hashApiKey } = require('../src/db/apiKey');

const VECTORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'adr', 'D-221-token-vectors.json'), 'utf8')
);

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

/** The window the route will use right now (or one window back). */
function currentWindow(offsetWindows = 0) {
  const seconds = Math.floor(Date.now() / 1000) - offsetWindows * 300;
  return Math.floor(seconds / 300) * 300;
}

/** The canonical D-221 derivation, computed independently of the route under test. */
function boundToken(secret, deviceId, window) {
  return crypto.createHmac('sha256', secret).update(`${deviceId}:${window}`).digest('hex');
}

/** The previous Express derivation, which must keep verifying for one release (Q2-A). */
function legacyToken(secret, window) {
  return crypto.createHmac('sha256', secret).update(String(window)).digest('hex');
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
// The shared vectors (Q4-A)
// ---------------------------------------------------------------------------

describe('D-221 shared vectors', () => {
  test('the canonical derivation reproduces every bound vector', () => {
    // If this suite and the Worker suite both pass, the two surfaces agree; a divergence
    // fails here and in serverless/worker.test.ts instead of being invisible.
    const wrong = VECTORS.bound.filter(
      (v) => boundToken(VECTORS.secret, v.device_id, v.window) !== v.token
    );
    expect(wrong).toEqual([]);
    expect(VECTORS.bound.length).toBeGreaterThan(0);
  });

  test('the legacy Express derivation reproduces its vectors', () => {
    const wrong = VECTORS.legacy_express.filter(
      (v) => legacyToken(VECTORS.secret, v.window) !== v.token
    );
    expect(wrong).toEqual([]);
  });

  test('the legacy Worker derivation differs from the legacy Express one', () => {
    // This is the D-221 defect itself, kept as a fact: the two surfaces derived different
    // tokens, so a token issued by one could never verify on the other.
    const expressLegacy = VECTORS.legacy_express[0].token;
    expect(VECTORS.legacy_worker[0].token).not.toBe(expressLegacy);
  });
});

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

describe('POST /api/agent/uninstall-auth — issuing', () => {
  test('401 without any credential', async () => {
    const res = await request(app).post('/api/agent/uninstall-auth');

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication required/);
    expect(res.body.uninstall_token).toBeUndefined();
  });

  test('the bearer fallback does not accept a device key', async () => {
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/uninstall-auth')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(401);
  });

  test('issues a device-bound token for a per-device key in x-agent-key', async () => {
    const { apiKey } = provisionDevice({ id: 'dev-bound-1' });
    const res = await request(app).post('/api/agent/uninstall-auth').set('x-agent-key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.uninstall_token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.expires_in).toBe(300);
    expect(res.body.device_id).toBe('dev-bound-1');
    // Bound to this device — not the deployment-wide token of the old scheme.
    expect(res.body.uninstall_token).toBe(boundToken(ADMIN_TOKEN, 'dev-bound-1', currentWindow()));
    expect(res.body.uninstall_token).not.toBe(legacyToken(ADMIN_TOKEN, currentWindow()));
  });

  test('issues a token for the header the agent actually sends (X-API-Key)', async () => {
    const { apiKey } = provisionDevice({ id: 'dev-bound-2' });
    const res = await request(app).post('/api/agent/uninstall-auth').set('X-API-Key', apiKey);

    expect(res.status).toBe(200);
    expect(res.body.uninstall_token).toBe(boundToken(ADMIN_TOKEN, 'dev-bound-2', currentWindow()));
  });

  test('a device-key caller cannot obtain a token bound to ANOTHER device', async () => {
    // The binding must come from the authenticated row, never from the request body —
    // otherwise the property would be "does the caller claim an id".
    const { apiKey } = provisionDevice({ id: 'dev-mine' });
    const res = await request(app)
      .post('/api/agent/uninstall-auth')
      .set('X-API-Key', apiKey)
      .send({ device_id: 'dev-someone-else' });

    expect(res.status).toBe(200);
    expect(res.body.device_id).toBe('dev-mine');
    expect(res.body.uninstall_token).toBe(boundToken(ADMIN_TOKEN, 'dev-mine', currentWindow()));
    expect(res.body.uninstall_token).not.toBe(
      boundToken(ADMIN_TOKEN, 'dev-someone-else', currentWindow())
    );
  });

  test('an admin-token caller must name the device', async () => {
    // No device row authenticated, so there is nothing to bind to without the body.
    const res = await request(app)
      .post('/api/agent/uninstall-auth')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/device_id required/);
  });

  test('an admin-token caller gets the token they asked for', async () => {
    const res = await request(app)
      .post('/api/agent/uninstall-auth')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ device_id: 'dev-admin-bound' });

    expect(res.status).toBe(200);
    expect(res.body.uninstall_token).toBe(
      boundToken(ADMIN_TOKEN, 'dev-admin-bound', currentWindow())
    );
  });

  test('503 when ADMIN_TOKEN is unset — no computable fallback token', async () => {
    // Q3-A. Before D-221 this happily issued HMAC('fallback', window), which anyone
    // holding this repository can compute.
    delete process.env.ADMIN_TOKEN;
    const { apiKey } = provisionDevice();

    const res = await request(app).post('/api/agent/uninstall-auth').set('X-API-Key', apiKey);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ADMIN_TOKEN/);
    expect(res.body.uninstall_token).toBeUndefined();
    // And specifically not the old constant-fallback token.
    expect(res.text).not.toContain(legacyToken('fallback', currentWindow()));
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
  test('accepts the bound token for the current window', async () => {
    const { apiKey } = provisionDevice({ id: 'dev-verify-1' });
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: boundToken(ADMIN_TOKEN, 'dev-verify-1', currentWindow()) });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true, verified: true });
  });

  test('accepts the previous window (clock skew)', async () => {
    const { apiKey } = provisionDevice({ id: 'dev-verify-2' });
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: boundToken(ADMIN_TOKEN, 'dev-verify-2', currentWindow(1)) });

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
  });

  test('rejects a token bound to a DIFFERENT device', async () => {
    // The whole point of D-221: a token leaked from another machine is useless here.
    const { apiKey } = provisionDevice({ id: 'dev-victim' });
    const stolen = boundToken(ADMIN_TOKEN, 'dev-other-machine', currentWindow());

    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: stolen });

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.text).not.toContain(stolen);
  });

  test('still accepts the previous deployment-wide token, and says so', async () => {
    // Q2-A: an agent that has not taken the update must still be able to uninstall.
    const { apiKey } = provisionDevice({ id: 'dev-legacy' });
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: legacyToken(ADMIN_TOKEN, currentWindow()) });

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.deprecated_scheme).toBe('legacy-deployment-wide');
  });

  test('the legacy acceptance names its own sunset, and it matches the shared statement', async () => {
    // The deprecation is only as good as its enforcement: the date is echoed here so an operator
    // reading logs (and the agent reading the response) learns when the path disappears, and it is
    // pinned against the file that the contract test enforces.
    const { apiKey } = provisionDevice({ id: 'dev-sunset' });
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: legacyToken(ADMIN_TOKEN, currentWindow()) });

    expect(res.body.deprecated_scheme_sunset).toBe(VECTORS.legacy_sunset);
    expect(agentRoutes.LEGACY_UNINSTALL_TOKEN_SUNSET).toBe(VECTORS.legacy_sunset);
  });

  test('the legacy window has not passed (fails on the sunset date, by design)', () => {
    // Three suites fail on that date rather than one log line going unread. See
    // scripts/test_cross_surface_contract.py for the deletion checklist.
    expect(Date.now()).toBeLessThan(Date.parse(`${VECTORS.legacy_sunset}T00:00:00Z`));
  });

  test('rejects a wrong token without echoing it', async () => {
    const { apiKey } = provisionDevice({ id: 'dev-wrong' });
    const wrong = 'f'.repeat(64);
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: wrong });

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.text).not.toContain(wrong);
  });

  test('503 when ADMIN_TOKEN is unset', async () => {
    delete process.env.ADMIN_TOKEN;
    const { apiKey } = provisionDevice();
    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', apiKey)
      .send({ uninstall_token: legacyToken('fallback', currentWindow()) });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ADMIN_TOKEN/);
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
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
    const token = boundToken(ADMIN_TOKEN, 'dev-anon', currentWindow());

    const res = await request(app)
      .post('/api/agent/uninstall-auth/verify')
      .set('X-API-Key', 'wrong-key-entirely-0123456789')
      .send({ uninstall_token: token });

    expect(res.status).toBe(401);
    expect(res.text).not.toContain(token);
  });
});
