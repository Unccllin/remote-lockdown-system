/**
 * Token enrolment — POST /api/enroll/token (admin) + POST /api/enroll/claim (device).
 *
 * The Worker has had this flow all along and both the dashboard's Enroll page and
 * `agent/installer.py --token` are written against it, but the Express server
 * implemented neither endpoint: token enrolment 404'd on self-hosted deployments
 * (S204). These tests pin the contract the two clients already assume.
 */

const request = require('supertest');

const { mockPool, makeToken, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const enrollRoutes = require('../src/routes/enroll');
const { hashApiKey } = require('../src/db/apiKey');

const app = createApp({ enroll: enrollRoutes });

const HASH_64 = /^[0-9a-f]{64}$/;

beforeEach(() => {
  mockPool.query.reset();
});

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

describe('POST /api/enroll/token', () => {
  test('requires auth', async () => {
    const res = await request(app).post('/api/enroll/token');
    expect(res.status).toBe(401);
  });

  test('requires at least operator', async () => {
    const res = await request(app)
      .post('/api/enroll/token')
      .set('Authorization', `Bearer ${makeToken('admin-1', 'viewer', 'viewer')}`);
    expect(res.status).toBe(403);
  });

  test('issues a 15-minute token and stores only its hash', async () => {
    const res = await request(app)
      .post('/api/enroll/token')
      .set('Authorization', `Bearer ${makeToken('admin-1')}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThanOrEqual(40); // 32 random bytes, base64
    expect(res.body.expires_in).toBe(900);

    const ttlMs = new Date(res.body.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(890_000);
    expect(ttlMs).toBeLessThanOrEqual(900_000);

    const insert = mockPool.query.mock.calls.find((c) =>
      /INSERT INTO enrollment_tokens/.test(c[0])
    );
    expect(insert).toBeTruthy();
    const [, params] = insert;
    // params: [id, token_hash, created_by, created_at, expires_at]
    expect(params[1]).toMatch(HASH_64);
    // The stored value must NOT be the token itself — a DB read is not a replay.
    expect(params[1]).not.toBe(res.body.token);
    expect(params[2]).toBe('admin-1'); // provenance for the audit row
  });
});

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

describe('POST /api/enroll/claim', () => {
  const futureIso = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

  function tokenRow(overrides = {}) {
    return {
      id: 'tok-1',
      token_hash: 'x'.repeat(64),
      created_by: 'admin-1',
      created_at: new Date().toISOString(),
      expires_at: futureIso(),
      used_at: null,
      ...overrides,
    };
  }

  test('rejects a request without a token', async () => {
    const res = await request(app).post('/api/enroll/claim').send({ hostname: 'PC-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token required/i);
  });

  test('rejects a request without a hostname', async () => {
    const res = await request(app).post('/api/enroll/claim').send({ token: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hostname required/i);
  });

  test('rejects an unknown token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [] });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'nope', hostname: 'PC-1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or already-used/);
  });

  test('rejects an already-used token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', {
      rows: [tokenRow({ used_at: new Date().toISOString() })],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'used', hostname: 'PC-1' });

    expect(res.status).toBe(401);
  });

  test('rejects an expired token', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', {
      rows: [tokenRow({ expires_at: new Date(Date.now() - 1000).toISOString() })],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'stale', hostname: 'PC-1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('rejects when the single-use update loses the race', async () => {
    // Another claim consumed the token between the SELECT and the UPDATE.
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'race', hostname: 'PC-1' });

    expect(res.status).toBe(401);
  });

  test('creates the device and returns a key whose hash was stored', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 1 });
    mockPool.query.setResult('INSERT INTO devices', {
      rows: [{ id: 'dev-9', hostname: 'PC-9', owner_name: 'Ops', status: 'active' }],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'good', hostname: 'PC-9', owner_name: 'Ops', serial_number: 'SN-9' });

    expect(res.status).toBe(201);
    expect(res.body.device.id).toBe('dev-9');
    expect(typeof res.body.api_key).toBe('string');

    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO devices/.test(c[0]));
    const params = insert[1];
    // The plaintext key is returned, never stored; what lands in the row is its hash.
    expect(params).toContain(hashApiKey(res.body.api_key));
    expect(params).toContain('SN-9');
    expect(params).not.toContain(res.body.api_key);

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('device_enrolled');
    // Provenance: the admin who minted the token authorised this enrolment.
    expect(audit[1][1]).toBe('admin-1');
    expect(audit[1][3].via).toBe('enrollment_token');
  });

  test('re-associates an existing machine instead of duplicating it', async () => {
    mockPool.query.setResult('SELECT * FROM enrollment_tokens', { rows: [tokenRow()] });
    mockPool.query.setResult('UPDATE enrollment_tokens', { rows: [], rowCount: 1 });
    mockPool.query.setResult('SELECT * FROM devices WHERE hardware_uuid', {
      rows: [{ id: 'dev-1', hardware_uuid: 'HW-1' }],
    });
    mockPool.query.setResult('UPDATE devices', {
      rows: [{ id: 'dev-1', hostname: 'PC-1', hardware_uuid: 'HW-1', status: 'active' }],
    });

    const res = await request(app)
      .post('/api/enroll/claim')
      .send({ token: 'good', hostname: 'PC-1', hardware_uuid: 'HW-1' });

    expect(res.status).toBe(200);
    expect(res.body.reassociated).toBe(true);
    expect(res.body.device.id).toBe('dev-1');
    // No second row is created for the same hardware.
    expect(
      mockPool.query.mock.calls.some((c) => /INSERT INTO devices/.test(c[0]))
    ).toBe(false);
  });
});
