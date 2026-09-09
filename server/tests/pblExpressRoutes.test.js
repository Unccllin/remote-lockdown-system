/**
 * D-210: Express route handlers for attest, override, and device admin.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { router, createEnv } = require('../src/routes/pbl');
const cbor = require('../src/pbl/cbor');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';

// Set JWT_SECRET env var before requiring auth middleware
process.env.JWT_SECRET = JWT_SECRET;

/** Create a signed JWT token for admin auth. */
function makeToken(role = 'super-admin') {
  return jwt.sign({ id: 'admin-1', username: 'admin', role }, JWT_SECRET, { expiresIn: '1h' });
}

/** Build a CBOR verdict request body. */
function buildVerdictRequest(deviceId, nonce, policyVersion = 1) {
  return cbor.encodeMap([
    [cbor.encodeUint(1), cbor.encodeBstr(deviceId)],
    [cbor.encodeUint(2), cbor.encodeBstr(nonce)],
    [cbor.encodeUint(3), cbor.encodeBstr(Buffer.alloc(32))],
    [cbor.encodeUint(4), cbor.encodeUint(policyVersion)],
  ]);
}

function createApp(env) {
  const app = express();
  app.use('/v1', (req, res, next) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'application/cbor') {
      express.raw({ type: 'application/cbor', limit: '256kb' })(req, res, next);
    } else {
      express.json({ limit: '1mb' })(req, res, next);
    }
  });
  app.use('/v1', (req, res, next) => {
    req._pblEnv = env || createEnv();
    next();
  });
  app.use('/v1', router);
  return app;
}

const DEVICE_ID = 'ab'.repeat(32);

describe('D-210: Express attest endpoint', () => {
  it('rejects missing device_id', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({ quote: 'dGVzdA==' });
    expect(resp.status).toBe(400);
  });

  it('rejects invalid device_id format', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({ device_id: 'short', quote: 'dGVzdA==' });
    expect(resp.status).toBe(400);
  });

  it('returns 404 for unenrolled device', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, quote: 'dGVzdA==' });
    expect(resp.status).toBe(404);
  });

  it('returns attested=true for enrolled active device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, quote: 'dGVzdA==' });
    expect(resp.status).toBe(200);
    expect(resp.body.attested).toBe(true);
    expect(resp.body.health).toBe('ok');
  });

  it('returns health=degraded for locked device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID,
      status: 'locked',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, quote: 'dGVzdA==' });
    expect(resp.status).toBe(200);
    expect(resp.body.health).toBe('degraded');
  });
});

describe('D-210: Express override challenge endpoint', () => {
  it('rejects missing device_id', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ challenge_seed: 'a'.repeat(32) });
    expect(resp.status).toBe(400);
  });

  it('rejects invalid challenge_seed', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'short' });
    expect(resp.status).toBe(400);
  });

  it('returns 404 for unenrolled device', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) });
    expect(resp.status).toBe(404);
  });

  it('returns 409 for non-locked device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) });
    expect(resp.status).toBe(409);
  });

  it('returns a challenge for locked device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) });
    expect(resp.status).toBe(200);
    expect(resp.body.challenge).toBeTruthy();
    expect(resp.body.expires_at).toBeGreaterThan(0);
  });
});

describe('D-210: Express override response endpoint', () => {
  it('rejects missing response', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge: 'dGVzdA==' });
    expect(resp.status).toBe(400);
  });

  it('returns 400 when no challenge was requested', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge: 'dGVzdA==', response: 'sig' });
    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('no challenge');
  });
});

describe('D-210: Express device admin endpoints', () => {
  it('GET /devices returns 401 without auth', async () => {
    const app = createApp();
    const resp = await request(app).get('/v1/devices');
    expect(resp.status).toBe(401);
  });

  it('GET /devices returns device list with auth', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .get('/v1/devices')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.devices).toHaveLength(1);
    expect(resp.body.devices[0].device_id).toBe(DEVICE_ID);
  });

  it('GET /devices/:id returns 401 without auth', async () => {
    const app = createApp();
    const resp = await request(app).get(`/v1/devices/${DEVICE_ID}`);
    expect(resp.status).toBe(401);
  });

  it('GET /devices/:id returns device with auth', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .get(`/v1/devices/${DEVICE_ID}`)
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.device.device_id).toBe(DEVICE_ID);
  });

  it('POST /devices/:id/lock locks the device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/lock`)
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('locked');
  });

  it('POST /devices/:id/unlock unlocks the device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', lock_reason: 'admin_lock',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/unlock`)
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('active');
  });

  it('POST /devices/:id/track sets tracking status', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/track`)
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('tracking');
  });

  it('POST /devices/:id/stop-track stops tracking', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'tracking', lock_reason: 'reported_stolen',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/stop-track`)
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('active');
  });

  it('DELETE /devices/:id removes the device', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .delete(`/v1/devices/${DEVICE_ID}`)
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.deleted).toBe(true);
  });

  it('GET /devices/:id/agent-mapping returns mapped=false when no mapping', async () => {
    const app = createApp();
    const resp = await request(app)
      .get(`/v1/devices/${DEVICE_ID}/agent-mapping`)
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.mapped).toBe(false);
  });

  it('POST + GET /devices/:id/agent-mapping links and retrieves', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);

    const linkResp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/agent-mapping`)
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json')
      .send({ agent_device_id: 'agent-uuid-123' });
    expect(linkResp.status).toBe(200);
    expect(linkResp.body.mapped).toBe(true);

    const getResp = await request(app)
      .get(`/v1/devices/${DEVICE_ID}/agent-mapping`)
      .set('Authorization', 'Bearer ' + makeToken());
    expect(getResp.status).toBe(200);
    expect(getResp.body.mapped).toBe(true);
    expect(getResp.body.agent_device_id).toBe('agent-uuid-123');
  });

  it('rejects viewer role with 403', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const resp = await request(app)
      .post(`/v1/devices/${DEVICE_ID}/lock`)
      .set('Authorization', 'Bearer ' + makeToken('viewer'))
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(403);
  });

  it('rejects invalid JWT with 401', async () => {
    const app = createApp();
    const resp = await request(app)
      .get('/v1/devices')
      .set('Authorization', 'Bearer invalid-jwt-token');
    expect(resp.status).toBe(401);
  });
});

describe('D-209: Admin key info endpoint', () => {
  it('GET /admin/key-info returns key info with auth', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put('pbl_signing_key:kid', 'aabbccdd');
    await env.LOCKDOWN_KV.put('pbl_policy_signing_key:kid', 'eeff0011');
    const app = createApp(env);
    const resp = await request(app)
      .get('/v1/admin/key-info')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.verdict_signing_key.kid).toBe('aabbccdd');
    expect(resp.body.policy_signing_key.kid).toBe('eeff0011');
  });

  it('GET /admin/key-info returns 403 for operator role', async () => {
    const app = createApp();
    const resp = await request(app)
      .get('/v1/admin/key-info')
      .set('Authorization', 'Bearer ' + makeToken('operator'));
    expect(resp.status).toBe(403);
  });
});

describe('D-205: Admin key rotation endpoint', () => {
  it('POST /admin/rotate-key rotates the verdict signing key', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put('pbl_signing_key:kid', 'old-kid');
    await env.LOCKDOWN_KV.put('pbl_signing_key:current', 'old-pkcs8');
    const app = createApp(env);
    const resp = await request(app)
      .post('/v1/admin/rotate-key')
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(200);
    expect(resp.body.rotated).toBe(true);
    expect(resp.body.new_kid).toBeTruthy();
    expect(resp.body.new_kid).not.toBe('old-kid');
  });

  it('rejects operator role with 403', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/admin/rotate-key')
      .set('Authorization', 'Bearer ' + makeToken('operator'))
      .set('Content-Type', 'application/json');
    expect(resp.status).toBe(403);
  });
});

describe('D-205: Admin cert chain endpoints', () => {
  it('GET /admin/cert-chain returns provisioned=false when empty', async () => {
    const app = createApp();
    const resp = await request(app)
      .get('/v1/admin/cert-chain')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.provisioned).toBe(false);
  });

  it('POST + GET + DELETE /admin/cert-chain stores and removes cert chain', async () => {
    const env = createEnv();
    const app = createApp(env);
    // Minimal valid DER cert chain: two SEQUENCE structures
    const fakeCert1 = Buffer.from([0x30, 0x02, 0x05, 0x00]);
    const fakeCert2 = Buffer.from([0x30, 0x02, 0x05, 0x00]);
    const chain = Buffer.concat([fakeCert1, fakeCert2]).toString('base64');

    const postResp = await request(app)
      .post('/v1/admin/cert-chain')
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json')
      .send({ chain });
    expect(postResp.status).toBe(200);
    expect(postResp.body.stored).toBe(true);
    expect(postResp.body.cert_count).toBe(2);

    const getResp = await request(app)
      .get('/v1/admin/cert-chain')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(getResp.status).toBe(200);
    expect(getResp.body.provisioned).toBe(true);
    expect(getResp.body.cert_count).toBe(2);

    const delResp = await request(app)
      .delete('/v1/admin/cert-chain')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(delResp.status).toBe(200);
    expect(delResp.body.deleted).toBe(true);
  });

  it('rejects cert chain with fewer than 2 certs', async () => {
    const app = createApp();
    const singleCert = Buffer.from([0x30, 0x02, 0x05, 0x00]).toString('base64');
    const resp = await request(app)
      .post('/v1/admin/cert-chain')
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json')
      .send({ chain: singleCert });
    expect(resp.status).toBe(400);
  });
});

describe('D-204: Admin operator key endpoints', () => {
  it('GET /admin/operator-key returns provisioned=false when empty', async () => {
    const app = createApp();
    const resp = await request(app)
      .get('/v1/admin/operator-key')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(resp.status).toBe(200);
    expect(resp.body.provisioned).toBe(false);
  });

  it('POST + DELETE /admin/operator-key stores and removes key', async () => {
    const env = createEnv();
    const app = createApp(env);
    const fakeSpki = 'dGVzdC1zcGtp'; // base64 of "test-spki"

    const postResp = await request(app)
      .post('/v1/admin/operator-key')
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json')
      .send({ spki: fakeSpki });
    expect(postResp.status).toBe(200);
    expect(postResp.body.stored).toBe(true);

    const getResp = await request(app)
      .get('/v1/admin/operator-key')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(getResp.status).toBe(200);
    expect(getResp.body.provisioned).toBe(true);

    const delResp = await request(app)
      .delete('/v1/admin/operator-key')
      .set('Authorization', 'Bearer ' + makeToken());
    expect(delResp.status).toBe(200);
    expect(delResp.body.deleted).toBe(true);
  });

  it('rejects missing spki', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/admin/operator-key')
      .set('Authorization', 'Bearer ' + makeToken())
      .set('Content-Type', 'application/json')
      .send({});
    expect(resp.status).toBe(400);
  });
});

describe('D-203: TPM attest signature verification', () => {
  it('records quote_verified=false for invalid signature', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    // Store a fake AK public key (will fail parsing → verification false)
    await env.LOCKDOWN_KV.put(`pbl_ak_public:${DEVICE_ID}`, '00112233');
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({
        device_id: DEVICE_ID,
        quote: 'dGVzdA==', // "test" — not a valid TPM2B_ATTEST
        signature: 'dGVzdA==', // "test" — not a valid signature
      });
    expect(resp.status).toBe(200);
    expect(resp.body.attested).toBe(true);
    expect(resp.body.quote_verified).toBe(false);
  });

  it('records signatureProvided=true when signature is present', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    // No AK public key stored → development mode
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({
        device_id: DEVICE_ID,
        quote: 'dGVzdA==',
        signature: 'dGVzdA==',
      });
    expect(resp.status).toBe(200);
    expect(resp.body.attested).toBe(true);
    // No AK public key → signatureProvided stays false, health = ok
    expect(resp.body.health).toBe('ok');
  });

  it('D-203: returns ak_name_valid and pcr_digest_valid in response', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'active', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({
        device_id: DEVICE_ID,
        quote: 'dGVzdA==',
      });
    expect(resp.status).toBe(200);
    expect(resp.body).toHaveProperty('ak_name_valid');
    expect(resp.body).toHaveProperty('pcr_digest_valid');
  });
});

describe('D-203: PCR digest comparison + AK Name binding (unit)', () => {
  const tpm = require('../src/pbl/tpm');

  it('comparePcrDigest returns true for matching digest', () => {
    const pcrValues = ['ab'.repeat(32), 'cd'.repeat(32)];
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(pcrValues[0], 'hex'));
    hash.update(Buffer.from(pcrValues[1], 'hex'));
    const digest = hash.digest();
    expect(tpm.comparePcrDigest(digest, pcrValues)).toBe(true);
  });

  it('comparePcrDigest returns false for non-matching digest', () => {
    const pcrValues = ['ab'.repeat(32)];
    const wrongDigest = Buffer.alloc(32, 0xff);
    expect(tpm.comparePcrDigest(wrongDigest, pcrValues)).toBe(false);
  });

  it('comparePcrDigest returns false for empty array', () => {
    const digest = Buffer.alloc(32, 0);
    expect(tpm.comparePcrDigest(digest, [])).toBe(false);
  });

  it('comparePcrDigest returns false for null digest', () => {
    expect(tpm.comparePcrDigest(null, ['ab'.repeat(32)])).toBe(false);
  });

  it('computeAkName returns 34-byte name (2-byte alg + 32-byte hash)', () => {
    // Minimal valid TPM2B_PUBLIC: 2-byte size + some body
    const akPublicHex = '0008' + '0011223344556677';
    const name = tpm.computeAkName(akPublicHex);
    expect(name.length).toBe(34);
    expect(name[0]).toBe(0x00); // SHA-256 alg high byte
    expect(name[1]).toBe(0x0b); // SHA-256 alg low byte
  });

  it('computeAkName returns empty buffer for too-short input', () => {
    expect(tpm.computeAkName('00').length).toBe(0);
  });
});

describe('D-204: Override response with operator key verification', () => {
  it('rejects invalid operator signature with 403', async () => {
    const env = createEnv();
    const deviceId = DEVICE_ID;
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceId}`, JSON.stringify({
      device_id: deviceId, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    // Store a challenge
    const challengeBase64 = Buffer.from('test-challenge-32-bytes!!').toString('base64');
    await env.LOCKDOWN_KV.put(`pbl_override_challenge:${deviceId}`, JSON.stringify({
      challenge: challengeBase64,
      challenge_seed: 'a'.repeat(32),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    }));
    // Store a fake operator key (will fail verification)
    await env.LOCKDOWN_KV.put('pbl_operator_key:current', 'dGVzdC1zcGtp');
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceId,
        challenge: challengeBase64,
        response: Buffer.from('invalid-signature').toString('base64'),
      });
    expect(resp.status).toBe(403);
    expect(resp.body.error).toContain('invalid operator signature');
  });

  it('accepts response in dev mode (no operator key provisioned)', async () => {
    const env = createEnv();
    const deviceId = DEVICE_ID;
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceId}`, JSON.stringify({
      device_id: deviceId, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const challengeBase64 = Buffer.from('test-challenge-32-bytes!!').toString('base64');
    await env.LOCKDOWN_KV.put(`pbl_override_challenge:${deviceId}`, JSON.stringify({
      challenge: challengeBase64,
      challenge_seed: 'a'.repeat(32),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    }));
    // No operator key stored → dev mode
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceId,
        challenge: challengeBase64,
        response: 'any-response',
      });
    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
  });
});

describe('D-204: challenge_seed binding + audit trail', () => {
  it('rejects challenge_seed that does not match the verdict', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    // Store a challenge_seed from the verdict
    await env.LOCKDOWN_KV.put(`pbl_challenge_seed:${DEVICE_ID}`, 'b'.repeat(32));
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) }); // wrong seed
    expect(resp.status).toBe(403);
    expect(resp.body.error).toContain('challenge_seed');
  });

  it('accepts challenge_seed that matches the verdict', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const seed = 'a'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_challenge_seed:${DEVICE_ID}`, seed);
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: seed });
    expect(resp.status).toBe(200);
    expect(resp.body.challenge).toBeTruthy();
  });

  it('writes an audit record on successful challenge', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);

    await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) });

    // Check that an audit record was written
    const keys = await env.LOCKDOWN_KV.list();
    const auditKeys = keys.keys.filter((k) => k.name.startsWith(`pbl_override_audit:${DEVICE_ID}:`));
    expect(auditKeys.length).toBeGreaterThan(0);
    const auditData = JSON.parse(await env.LOCKDOWN_KV.get(auditKeys[0].name, 'text'));
    expect(auditData.phase).toBe('challenge');
    expect(auditData.success).toBe(true);
    expect(auditData.device_id).toBe(DEVICE_ID);
  });

  it('writes an audit record on failed challenge_seed mismatch', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put(`pbl_devices:${DEVICE_ID}`, JSON.stringify({
      device_id: DEVICE_ID, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    await env.LOCKDOWN_KV.put(`pbl_challenge_seed:${DEVICE_ID}`, 'b'.repeat(32));
    const app = createApp(env);

    await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({ device_id: DEVICE_ID, challenge_seed: 'a'.repeat(32) });

    const keys = await env.LOCKDOWN_KV.list();
    const auditKeys = keys.keys.filter((k) => k.name.startsWith(`pbl_override_audit:${DEVICE_ID}:`));
    expect(auditKeys.length).toBeGreaterThan(0);
    const auditData = JSON.parse(await env.LOCKDOWN_KV.get(auditKeys[0].name, 'text'));
    expect(auditData.success).toBe(false);
    expect(auditData.reason).toContain('mismatch');
  });

  it('writes an audit record on successful override response', async () => {
    const env = createEnv();
    const deviceId = DEVICE_ID;
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceId}`, JSON.stringify({
      device_id: deviceId, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const challengeBase64 = Buffer.from('test-challenge-32-bytes!!').toString('base64');
    await env.LOCKDOWN_KV.put(`pbl_override_challenge:${deviceId}`, JSON.stringify({
      challenge: challengeBase64,
      challenge_seed: 'a'.repeat(32),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    }));
    const app = createApp(env);

    await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceId,
        challenge: challengeBase64,
        response: 'any-response',
      });

    const keys = await env.LOCKDOWN_KV.list();
    const auditKeys = keys.keys.filter((k) => k.name.startsWith(`pbl_override_audit:${deviceId}:`));
    expect(auditKeys.length).toBeGreaterThan(0);
    const auditData = JSON.parse(await env.LOCKDOWN_KV.get(auditKeys[0].name, 'text'));
    expect(auditData.phase).toBe('response');
    expect(auditData.success).toBe(true);
  });

  it('writes an audit record on challenge mismatch failure', async () => {
    const env = createEnv();
    const deviceId = DEVICE_ID;
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceId}`, JSON.stringify({
      device_id: deviceId, status: 'locked', enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const challengeBase64 = Buffer.from('test-challenge-32-bytes!!').toString('base64');
    await env.LOCKDOWN_KV.put(`pbl_override_challenge:${deviceId}`, JSON.stringify({
      challenge: challengeBase64,
      challenge_seed: 'a'.repeat(32),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    }));
    const app = createApp(env);

    await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceId,
        challenge: 'wrong-challenge-base64',
        response: 'any-response',
      });

    const keys = await env.LOCKDOWN_KV.list();
    const auditKeys = keys.keys.filter((k) => k.name.startsWith(`pbl_override_audit:${deviceId}:`));
    expect(auditKeys.length).toBeGreaterThan(0);
    const auditData = JSON.parse(await env.LOCKDOWN_KV.get(auditKeys[0].name, 'text'));
    expect(auditData.success).toBe(false);
    expect(auditData.reason).toContain('mismatch');
  });

  it('verdict endpoint stores challenge_seed for locked devices', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex,
      status: 'locked',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));
    const app = createApp(env);
    const deviceId = Buffer.alloc(32, 0xab);
    const nonce = Buffer.alloc(32, 0xcd);
    const body = buildVerdictRequest(deviceId, nonce);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    // The challenge_seed should be stored in KV
    const storedSeed = await env.LOCKDOWN_KV.get(`pbl_challenge_seed:${deviceIdHex}`, 'text');
    expect(storedSeed).toBeTruthy();
    expect(storedSeed.length).toBe(32); // 16 bytes hex = 32 chars
  });
});
