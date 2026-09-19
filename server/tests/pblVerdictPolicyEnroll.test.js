/**
 * D-200/D-201/D-202: Server-side PBL route handler tests.
 *
 * Tests the verdict, policy, and enrollment Express endpoints.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { router, createEnv } = require('../src/routes/pbl');
const { setSharedKvStore } = require('../src/pbl/kvStore');
const cbor = require('../src/pbl/cbor');
const cose = require('../src/pbl/cose');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(role = 'super-admin') {
  return jwt.sign({ id: 'admin-1', username: 'admin', role }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp(env) {
  const app = express();
  // Raw body parser for CBOR, JSON for everything else
  app.use('/v1', (req, res, next) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim();
    if (ct === 'application/cbor') {
      express.raw({ type: 'application/cbor', limit: '256kb' })(req, res, next);
    } else {
      express.json({ limit: '1mb' })(req, res, next);
    }
  });
  // Inject env into request
  app.use('/v1', (req, res, next) => {
    req._pblEnv = env || createEnv();
    next();
  });
  app.use('/v1', router);
  return app;
}

/** Build a CBOR verdict request body. */
function buildVerdictRequest(deviceId, nonce, policyVersion = 1, bootId = null, s13 = {}) {
  const entries = [
    [cbor.encodeUint(1), cbor.encodeBstr(deviceId)],
    [cbor.encodeUint(2), cbor.encodeBstr(nonce)],
    [cbor.encodeUint(3), cbor.encodeBstr(Buffer.alloc(32))],
    [cbor.encodeUint(4), cbor.encodeUint(policyVersion)],
  ];
  // S1.1: boot_id (key 5) — TPM reset counter, present only when firmware
  // emitted it. null means older firmware with no key 5.
  if (bootId !== null) {
    entries.push([cbor.encodeUint(5), cbor.encodeUint(bootId)]);
  }
  // S1.3: attestation enrichment keys 6/7/8 (all optional).
  if (s13.fveProtectionMask !== undefined) {
    entries.push([cbor.encodeUint(6), cbor.encodeUint(s13.fveProtectionMask)]);
  }
  if (s13.loadedImageDigest !== undefined) {
    entries.push([cbor.encodeUint(7), cbor.encodeBstr(s13.loadedImageDigest)]);
  }
  if (s13.bootPathFlags !== undefined) {
    entries.push([cbor.encodeUint(8), cbor.encodeUint(s13.bootPathFlags)]);
  }
  return cbor.encodeMap(entries);
}

/** Build a CBOR enrollment request body. */
function buildEnrollRequest(deviceId, ekCert, akPublic) {
  return cbor.encodeMap([
    [cbor.encodeUint(1), cbor.encodeBstr(deviceId)],
    [cbor.encodeUint(2), cbor.encodeBstr(ekCert)],
    [cbor.encodeUint(3), cbor.encodeBstr(akPublic)],
  ]);
}

// D-206: Reset the shared KV store before each test to prevent state leakage
beforeEach(() => {
  setSharedKvStore(new Map());
});

describe('D-200: POST /v1/verdict', () => {
  it('returns a COSE_Sign1 verdict for an unknown device', async () => {
    const env = createEnv();
    const app = createApp(env);
    const deviceId = Buffer.alloc(32, 0xab);
    const nonce = Buffer.alloc(32, 0xcd);
    const body = buildVerdictRequest(deviceId, nonce);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
    expect(parseInt(resp.headers['content-length'] || '0', 10)).toBeGreaterThan(100);
  });

  it('returns a LOCKED verdict for a locked device', async () => {
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
    expect(resp.headers['content-type']).toContain('application/cose');
  });

  it('rejects invalid device_id length', async () => {
    const env = createEnv();
    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(16), Buffer.alloc(32));

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(400);
  });

  it('rejects invalid nonce length', async () => {
    const env = createEnv();
    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32), Buffer.alloc(16));

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(400);
  });

  it('rejects malformed CBOR', async () => {
    const env = createEnv();
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(Buffer.from([0xff, 0xff, 0xff]));

    expect(resp.status).toBe(400);
  });

  // S1.2: boot-ID recording — the verdict fetch IS the firmware boot report.
  it('S1.2: records boot_id and last_boot_at on the PBL device', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));

    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, 7);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.last_boot_id).toBe(7);
    expect(stored.last_boot_at).toBeTruthy();
    // last_boot_at should be ~now (within the last minute)
    expect(Date.now() - new Date(stored.last_boot_at).getTime()).toBeLessThan(60000);
  });

  it('S1.2: a second verdict bumps the recorded boot_id', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex,
      status: 'active',
      last_boot_id: 7,
      last_boot_at: '2026-01-01T00:00:00Z',
    }));

    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, 8);
    await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.last_boot_id).toBe(8);
  });

  it('S1.2: older firmware (no key 5) records null boot_id but still timestamps', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex,
      status: 'active',
    }));

    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, null);
    const resp = await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.last_boot_id).toBeNull();
    expect(stored.last_boot_at).toBeTruthy();
  });

  it('S1.2: non-integer boot_id is stored as null (defensive)', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex, status: 'active',
    }));

    const app = createApp(env);
    // Craft a request with a non-integer value at key 5 (float/string).
    const body = cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeBstr(Buffer.alloc(32, 0xab))],
      [cbor.encodeUint(2), cbor.encodeBstr(Buffer.alloc(32, 0xcd))],
      [cbor.encodeUint(3), cbor.encodeBstr(Buffer.alloc(32))],
      [cbor.encodeUint(4), cbor.encodeUint(1)],
      [cbor.encodeUint(5), cbor.encodeBstr(Buffer.from('notanint'))],
    ]);
    const resp = await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.last_boot_id).toBeNull();
  });

  // S1.3: attestation enrichment — keys 6/7/8 stored on the PBL device.
  it('S1.3: stores fve_protection_mask, loaded_image_digest, boot_path_flags', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex, status: 'active',
    }));

    const app = createApp(env);
    const digest = Buffer.alloc(32, 0x55);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, 7, {
      fveProtectionMask: 0x0006,
      loadedImageDigest: digest,
      bootPathFlags: 0x0a,
    });
    const resp = await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.fve_protection_mask).toBe(0x0006);
    expect(stored.loaded_image_digest).toBe(digest.toString('hex'));
    expect(stored.boot_path_flags).toBe(0x0a);
    expect(stored.last_boot_id).toBe(7);
  });

  it('S1.3: omits enrichment fields when keys absent (old firmware)', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex, status: 'active',
    }));

    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, 7);
    await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.fve_protection_mask).toBeUndefined();
    expect(stored.loaded_image_digest).toBeUndefined();
    expect(stored.boot_path_flags).toBeUndefined();
  });

  it('S1.3: malformed loaded_image_digest (wrong length) is ignored', async () => {
    const env = createEnv();
    const deviceIdHex = 'ab'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex, status: 'active',
    }));

    const app = createApp(env);
    const body = buildVerdictRequest(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd), 1, 7, {
      loadedImageDigest: Buffer.alloc(16),  // wrong length — must not store
      bootPathFlags: 0x02,
    });
    const resp = await request(app).post('/v1/verdict').set('Content-Type', 'application/cbor').send(body);

    expect(resp.status).toBe(200);
    const stored = JSON.parse(await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text'));
    expect(stored.loaded_image_digest).toBeUndefined();
    expect(stored.boot_path_flags).toBe(0x02);  // the valid field still stored
  });
});

describe('D-201: GET /v1/policy/:version', () => {
  it('returns a default policy when none is stored', async () => {
    const env = createEnv();
    const app = createApp(env);

    const resp = await request(app).get('/v1/policy/latest');

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
    expect(resp.headers['cache-control']).toContain('max-age=300');
  });

  it('returns a stored policy when one exists', async () => {
    const env = createEnv();
    const fakePolicy = Buffer.from([0xd1, 0x82, 0x01, 0x02, 0x03]);
    await env.LOCKDOWN_KV.put('pbl_policy:42', fakePolicy.toString('base64'));
    await env.LOCKDOWN_KV.put('pbl_policy:latest_version', '42');

    const app = createApp(env);

    const resp = await request(app).get('/v1/policy/42');

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
  });
});

describe('D-202: POST /v1/enroll', () => {
  it('enrolls a new device', async () => {
    const env = createEnv();
    const app = createApp(env);
    const deviceId = Buffer.alloc(32, 0x42);
    const ekCert = Buffer.from('fake-ek-cert');
    const akPublic = Buffer.from('fake-ak-public');
    const body = buildEnrollRequest(deviceId, ekCert, akPublic);

    const resp = await request(app)
      .post('/v1/enroll')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cbor');

    // Verify device was stored
    const stored = await env.LOCKDOWN_KV.get('pbl_devices:' + '42'.repeat(32), 'text');
    expect(stored).toBeTruthy();
    const device = JSON.parse(stored);
    expect(device.status).toBe('active');
  });

  it('returns already-enrolled status for existing device', async () => {
    const env = createEnv();
    const deviceIdHex = '42'.repeat(32);
    await env.LOCKDOWN_KV.put(`pbl_devices:${deviceIdHex}`, JSON.stringify({
      device_id: deviceIdHex,
      status: 'active',
      enrolled_at: '2026-01-01T00:00:00Z',
    }));

    const app = createApp(env);
    const body = buildEnrollRequest(
      Buffer.alloc(32, 0x42),
      Buffer.from('ek'),
      Buffer.from('ak'),
    );

    const resp = await request(app)
      .post('/v1/enroll')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
  });

  it('rejects missing ek_cert', async () => {
    const env = createEnv();
    const app = createApp(env);
    const body = cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeBstr(Buffer.alloc(32))],
      [cbor.encodeUint(3), cbor.encodeBstr(Buffer.from('ak'))],
    ]);

    const resp = await request(app)
      .post('/v1/enroll')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(400);
  });

  it('rejects invalid device_id length', async () => {
    const env = createEnv();
    const app = createApp(env);
    const body = buildEnrollRequest(
      Buffer.alloc(16),
      Buffer.from('ek'),
      Buffer.from('ak'),
    );

    const resp = await request(app)
      .post('/v1/enroll')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(400);
  });
});

describe('D-209: Policy version negotiation', () => {
  it('GET /policy/latest returns 304 when If-None-Match matches latest', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put('pbl_policy:latest_version', '42');
    await env.LOCKDOWN_KV.put('pbl_policy:42', Buffer.from('fake-policy').toString('base64'));
    const app = createApp(env);

    const resp = await request(app)
      .get('/v1/policy/latest')
      .set('If-None-Match', '42');

    expect(resp.status).toBe(304);
    expect(resp.headers.etag).toBe('42');
  });

  it('GET /policy/latest returns 200 with policy when If-None-Match differs', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put('pbl_policy:latest_version', '42');
    await env.LOCKDOWN_KV.put('pbl_policy:42', Buffer.from('fake-policy').toString('base64'));
    const app = createApp(env);

    const resp = await request(app)
      .get('/v1/policy/latest')
      .set('If-None-Match', '41');

    expect(resp.status).toBe(200);
    expect(resp.headers.etag).toBeDefined();
  });

  it('GET /policy/latest returns ETag header', async () => {
    const app = createApp();
    const resp = await request(app).get('/v1/policy/latest');
    expect(resp.status).toBe(200);
    expect(resp.headers.etag).toBeDefined();
  });
});

describe('D-209: Policy version list endpoint', () => {
  it('GET /policy returns latest version and versions list', async () => {
    const env = createEnv();
    await env.LOCKDOWN_KV.put('pbl_policy:latest_version', '5');
    await env.LOCKDOWN_KV.put('pbl_policy:3', Buffer.from('v3').toString('base64'));
    await env.LOCKDOWN_KV.put('pbl_policy:4', Buffer.from('v4').toString('base64'));
    await env.LOCKDOWN_KV.put('pbl_policy:5', Buffer.from('v5').toString('base64'));
    const app = createApp(env);

    const resp = await request(app)
      .get('/v1/policy')
      .set('Authorization', 'Bearer ' + makeToken());

    expect(resp.status).toBe(200);
    expect(resp.body.latest_version).toBe('5');
  });

  it('GET /policy returns 401 without auth', async () => {
    const app = createApp();
    const resp = await request(app).get('/v1/policy');
    expect(resp.status).toBe(401);
  });

  it('GET /policy returns 403 for viewer role', async () => {
    const app = createApp();
    const resp = await request(app)
      .get('/v1/policy')
      .set('Authorization', 'Bearer ' + makeToken('viewer'));
    expect(resp.status).toBe(403);
  });
});

describe('D-209: POST /policy/create — form-based policy creation', () => {
  it('creates a signed policy blob from JSON fields', async () => {
    const env = createEnv();
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send({
        version: 7,
        min_pbl_version: 1,
        lock_service_uri: 'https://pbl-verdict.example.com',
        verdict_freshness_seconds: 900,
        grace_period_seconds: 604800,
        oem_pk_allowlist: [{ subject: 'HP Inc.', issuer: 'HP Inc.', fingerprint: 'abcd' }],
        db_expectations: [{ fingerprint: 'ef01', label: 'Windows UEFI CA 2023' }],
      });

    expect(resp.status).toBe(200);
    expect(resp.body.stored).toBe(true);
    expect(resp.body.version).toBe('7');
    expect(resp.body.size).toBeGreaterThan(0);

    // Verify the policy was stored in KV
    const stored = await env.LOCKDOWN_KV.get('pbl_policy:7', 'text');
    expect(stored).toBeDefined();
    const latest = await env.LOCKDOWN_KV.get('pbl_policy:latest_version', 'text');
    expect(latest).toBe('7');
  });

  it('returns 400 when version is missing', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send({ lock_service_uri: 'https://example.com' });

    expect(resp.status).toBe(400);
    expect(resp.body.error).toContain('version');
  });

  it('returns 401 without auth', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Content-Type', 'application/json')
      .send({ version: 1 });

    expect(resp.status).toBe(401);
  });

  it('returns 403 for operator role (super-admin only)', async () => {
    const app = createApp();
    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('operator'))
      .set('Content-Type', 'application/json')
      .send({ version: 1 });

    expect(resp.status).toBe(403);
  });

  it('defaults optional fields to sensible values', async () => {
    const env = createEnv();
    const app = createApp(env);

    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', 'Bearer ' + makeToken('super-admin'))
      .set('Content-Type', 'application/json')
      .send({ version: 1 });

    expect(resp.status).toBe(200);
    expect(resp.body.version).toBe('1');
    // The policy should be stored and retrievable
    const stored = await env.LOCKDOWN_KV.get('pbl_policy:1', 'text');
    expect(stored).toBeDefined();
  });
});

describe('D-205: Ed25519 signing support', () => {
  it('generates an Ed25519 key pair with correct algorithm', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    expect(keys.algorithm).toBe('Ed25519');
    expect(keys.spki.length).toBeGreaterThan(0);
    expect(keys.pkcs8.length).toBeGreaterThan(0);
    expect(keys.kid.length).toBe(32); // SHA-256 digest
  });

  it('signs and verifies data with Ed25519', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const data = Buffer.from('test data for Ed25519');
    const signature = await cose.signData(keys.privateKey, data, 'Ed25519');
    expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes
    const valid = await cose.verifySignature(keys.publicKey, data, signature, 'Ed25519');
    expect(valid).toBe(true);
  });

  it('encodes COSE_Sign1 with Ed25519 algorithm ID (-8)', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const payload = cbor.encodeMap([
      [cbor.encodeUint(1), cbor.encodeTstr('test')],
    ]);
    const coseBlob = await cose.encodeCoseSign1(payload, keys);
    expect(coseBlob.length).toBeGreaterThan(0);

    // Verify the protected header contains alg=-8
    const decoded = cbor.decodeFirst(coseBlob);
    expect(decoded).toBeInstanceOf(Array);
    expect(decoded.length).toBe(4);
    // Element 0 is the protected header (bstr containing CBOR map)
    const protectedHeader = cbor.decodeFirst(decoded[0]);
    expect(protectedHeader.get(1)).toBe(-8); // COSE_ALG_ED25519
  });

  it('rejects invalid Ed25519 signature', async () => {
    const keys = await cose.generateSigningKey('Ed25519');
    const data = Buffer.from('test data');
    const badSig = Buffer.alloc(64, 0xff);
    const valid = await cose.verifySignature(keys.publicKey, data, badSig, 'Ed25519');
    expect(valid).toBe(false);
  });

  it('algorithmToCoseAlg maps correctly', () => {
    expect(cose.algorithmToCoseAlg('ES256')).toBe(-7);
    expect(cose.algorithmToCoseAlg('Ed25519')).toBe(-8);
  });
});
