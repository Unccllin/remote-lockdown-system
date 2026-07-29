/**
 * Phase 3: Security-focused test suite.
 *
 * Verifies edge cases that are not covered by the route-level functional tests:
 *   - JWT algorithm confusion (alg: none) is rejected
 *   - JWT expired token is rejected
 *   - HMAC replayed nonce is rejected
 *   - HMAC stale timestamp is rejected
 *   - SQL injection payloads on device hostname/owner_name are rejected or parameterized
 *   - Field encryption: encrypt → decrypt roundtrip
 *   - Field encryption: wrong key produces an error (auth tag failure), not garbage
 *   - API key pepper is applied before hashing (different pepper → different hash)
 *
 * These tests are self-contained and do not require a running server.
 * They use the mockPool pattern from ./mockPool for DB-interacting tests.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const { requireAuth } = require('../src/middleware/auth');
const { verifyHmac, checkAndRecordNonce } = require('../src/middleware/hmacAuth');
const { generateApiKey, hashApiKey } = require('../src/db/apiKey');
const { encryptField, decryptField } = require('../src/db/fieldCrypto');
const { clearKeyCache } = require('../src/db/crypto');
const devicesRoutes = require('../src/routes/devices');
const agentRoutes = require('../src/routes/agent');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-long-enough-for-validation-32';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthApp() {
  const app = express();
  app.use(express.json());
  app.use('/protected', requireAuth, (req, res) => {
    res.json({ ok: true, admin: req.admin });
  });
  return app;
}

function signRequest(key, bodyStr) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const payload = `${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return {
    'x-agent-key': key,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    'x-sig-version': '1',
  };
}

beforeEach(() => {
  mockPool.query.reset();
  clearKeyCache();
});

// ---------------------------------------------------------------------------
// JWT security
// ---------------------------------------------------------------------------

describe('JWT security', () => {
  const app = makeAuthApp();

  test('JWT with alg: none is rejected', async () => {
    // Forge a token with alg: none and no signature segment.
    // Header: {"alg":"none","typ":"JWT"}, payload: valid admin claim
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 'admin-1', username: 'admin' })).toString('base64url');
    const forgedToken = `${header}.${payload}.`;

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${forgedToken}`);

    expect(res.status).toBe(401);
  });

  test('JWT with expired token is rejected', async () => {
    // Sign a token that expired 1 hour ago.
    const expiredToken = jwt.sign(
      { id: 'admin-1', username: 'admin' },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '-1h' }
    );

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  test('JWT with valid token is accepted', async () => {
    const token = jwt.sign(
      { id: 'admin-1', username: 'admin' },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.admin.username).toBe('admin');
  });

  test('JWT signed with wrong secret is rejected', async () => {
    const token = jwt.sign(
      { id: 'admin-1', username: 'admin' },
      'a-completely-different-secret-key-32chars!',
      { algorithm: 'HS256', expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// HMAC replay protection
// ---------------------------------------------------------------------------

describe('HMAC replay protection', () => {
  const DEVICE_KEY = generateApiKey();

  test('replayed nonce is rejected', async () => {
    const body = 'test-body-replay';
    const headers = signRequest(DEVICE_KEY, body);

    // First call: fresh nonce → ok
    const fresh = await checkAndRecordNonce(headers['x-nonce'], 60000, null);
    expect(fresh).toBe(true);

    // Second call: same nonce → replay
    const replay = await checkAndRecordNonce(headers['x-nonce'], 60000, null);
    expect(replay).toBe(false);
  });

  test('stale timestamp is rejected by verifyHmac', () => {
    const body = 'test-body-stale';
    const oldTs = String(Math.floor(Date.now() / 1000) - 600); // 10 min ago
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const payload = `${oldTs}:${nonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', DEVICE_KEY).update(payload).digest('hex');

    const result = verifyHmac(DEVICE_KEY, {
      'x-timestamp': oldTs,
      'x-nonce': nonce,
      'x-signature': signature,
    }, body);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timestamp/);
  });

  test('future timestamp is rejected by verifyHmac', () => {
    const body = 'test-body-future';
    const futureTs = String(Math.floor(Date.now() / 1000) + 600); // 10 min ahead
    const nonce = crypto.randomBytes(16).toString('hex');
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const payload = `${futureTs}:${nonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', DEVICE_KEY).update(payload).digest('hex');

    const result = verifyHmac(DEVICE_KEY, {
      'x-timestamp': futureTs,
      'x-nonce': nonce,
      'x-signature': signature,
    }, body);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timestamp/);
  });

  test('valid signature within window is accepted', () => {
    const body = 'test-body-valid';
    const headers = signRequest(DEVICE_KEY, body);
    const result = verifyHmac(DEVICE_KEY, headers, body);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQL injection on device params
// ---------------------------------------------------------------------------

describe('SQL injection resistance', () => {
  const SQLI_PAYLOADS = [
    "'; DROP TABLE devices; --",
    "' OR '1'='1",
    "' UNION SELECT * FROM admins; --",
    "1; DELETE FROM devices WHERE '1'='1",
  ];

  function makeDevicesApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/devices', devicesRoutes);
    return app;
  }

  function makeAgentApp() {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
    }));
    app.use('/api/agent', agentRoutes);
    return app;
  }

  test('device enrollment: SQLi in hostname is rejected by input validation', async () => {
    const app = makeDevicesApp();
    const token = jwt.sign({ id: 'admin-1', username: 'admin', role: 'super-admin' }, JWT_SECRET, { expiresIn: '1h' });

    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('INSERT INTO devices', {
        rows: [{ id: 'dev-1', hostname: payload, owner_name: 'owner' }],
      });

      const res = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ hostname: payload, owner_name: 'owner' });

      // Hostname charset validation rejects SQLi payloads (400)
      expect(res.status).toBe(400);
    }
  });

  test('device enrollment: SQLi in owner_name is parameterized (not in SQL string)', async () => {
    const app = makeDevicesApp();
    const token = jwt.sign({ id: 'admin-1', username: 'admin', role: 'super-admin' }, JWT_SECRET, { expiresIn: '1h' });

    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('INSERT INTO devices', {
        rows: [{ id: 'dev-1', hostname: 'safe-name', owner_name: payload }],
      });

      const res = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${token}`)
        .send({ hostname: 'safe-name', owner_name: payload });

      expect(res.status).toBe(201);

      // Verify the SQLi payload was passed as a parameter, NOT interpolated into SQL
      const insertCall = mockPool.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO devices')
      );
      expect(insertCall).toBeDefined();
      const [sql, params] = insertCall;
      // The SQL string must not contain the raw payload
      expect(sql).not.toContain(payload);
      // The payload must be in the params array
      expect(params).toContain(payload);
    }
  });

  test('agent checkin: SQLi in hostname is parameterized', async () => {
    const app = makeAgentApp();
    const deviceKey = generateApiKey();
    const device = {
      id: 'dev-sqli-1', hostname: 'SAFE-HOST', status: 'active',
      api_key_hash: hashApiKey(deviceKey),
    };
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [device] });
    mockPool.query.setResult('UPDATE devices', { rows: [] });
    mockPool.query.setResult('SELECT * FROM commands', { rows: [] });

    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [device] });
      mockPool.query.setResult('UPDATE devices', { rows: [] });
      mockPool.query.setResult('SELECT * FROM commands', { rows: [] });

      const bodyStr = JSON.stringify({ hostname: payload });
      const headers = signRequest(deviceKey, bodyStr);

      const res = await request(app)
        .post('/api/agent/checkin')
        .set('Content-Type', 'application/json')
        .set(headers)
        .send(bodyStr);

      // The request should succeed (parameterized) — not 500
      expect(res.status).toBe(200);

      // Verify the UPDATE query parameterized the hostname
      const updateCall = mockPool.query.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('UPDATE devices') && c[0].includes('last_checkin')
      );
      expect(updateCall).toBeDefined();
      const [sql, params] = updateCall;
      expect(sql).not.toContain(payload);
      expect(params).toContain(payload);
    }
  });
});

// ---------------------------------------------------------------------------
// Field encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

describe('Field encryption', () => {
  test('encrypt → decrypt roundtrip recovers original plaintext', () => {
    const plaintext = 'sensitive-key-material-12345';
    const enc = encryptField(plaintext);
    expect(enc.ciphertext).toBeDefined();
    expect(enc.nonce).toBeDefined();
    expect(enc.tag).toBeDefined();
    // Ciphertext must differ from plaintext
    expect(enc.ciphertext).not.toBe(plaintext);

    const decrypted = decryptField(enc.ciphertext, enc.nonce, enc.tag);
    expect(decrypted).toBe(plaintext);
  });

  test('wrong key produces an error, not garbage', () => {
    const plaintext = 'sensitive-key-material-12345';
    const enc = encryptField(plaintext);

    // Decrypt with a different key (set a different FIELD_ENCRYPTION_KEY)
    const originalKey = process.env.FIELD_ENCRYPTION_KEY;
    process.env.FIELD_ENCRYPTION_KEY = 'c'.repeat(64);
    clearKeyCache();

    expect(() => {
      decryptField(enc.ciphertext, enc.nonce, enc.tag);
    }).toThrow();

    // Restore original key
    process.env.FIELD_ENCRYPTION_KEY = originalKey;
    clearKeyCache();
  });

  test('tampered ciphertext produces an error (auth tag verification)', () => {
    const plaintext = 'sensitive-key-material-12345';
    const enc = encryptField(plaintext);

    // Flip a bit in the ciphertext
    const buf = Buffer.from(enc.ciphertext, 'base64');
    buf[0] ^= 0x01;
    const tampered = buf.toString('base64');

    expect(() => {
      decryptField(tampered, enc.nonce, enc.tag);
    }).toThrow();
  });

  test('each encryption produces a unique nonce (random IV)', () => {
    const plaintext = 'same-plaintext';
    const enc1 = encryptField(plaintext);
    const enc2 = encryptField(plaintext);
    // Nonces must differ (random IV per encryption)
    expect(enc1.nonce).not.toBe(enc2.nonce);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });
});

// ---------------------------------------------------------------------------
// API key pepper
// ---------------------------------------------------------------------------

describe('API key pepper', () => {
  test('pepper is applied before hashing (different pepper → different hash)', () => {
    const apiKey = generateApiKey();
    const originalPepper = process.env.AGENT_KEY_PEPPER;

    // Hash with the original pepper
    const hash1 = hashApiKey(apiKey);

    // Change the pepper and hash again
    process.env.AGENT_KEY_PEPPER = 'a-different-pepper-for-testing-32chars!';
    const hash2 = hashApiKey(apiKey);

    // Restore
    process.env.AGENT_KEY_PEPPER = originalPepper;

    // Same key + different pepper → different hash
    expect(hash1).not.toBe(hash2);
    // Hashes should be hex strings of the correct length (SHA-256 = 64 hex chars)
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    expect(hash2).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashApiKey is deterministic for the same key + pepper', () => {
    const apiKey = generateApiKey();
    const hash1 = hashApiKey(apiKey);
    const hash2 = hashApiKey(apiKey);
    expect(hash1).toBe(hash2);
  });

  test('hashApiKey without pepper throws an error', () => {
    const apiKey = generateApiKey();
    const originalPepper = process.env.AGENT_KEY_PEPPER;
    const originalShared = process.env.AGENT_SHARED_KEY;
    delete process.env.AGENT_KEY_PEPPER;
    delete process.env.AGENT_SHARED_KEY;

    expect(() => hashApiKey(apiKey)).toThrow(/PEPPER|SHARED_KEY/i);

    process.env.AGENT_KEY_PEPPER = originalPepper;
    process.env.AGENT_SHARED_KEY = originalShared;
  });
});
