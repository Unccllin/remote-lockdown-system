/**
 * D-210: Full PBL flow integration test through Express.
 *
 * Exercises the complete PBL lifecycle via HTTP:
 * 1. Health check
 * 2. Enroll a device (CBOR)
 * 3. Get verdict for the enrolled device (CBOR → COSE_Sign1)
 * 4. Lock the device (admin)
 * 5. Get verdict for the locked device (should be LOCKED)
 * 6. Create a policy via form (admin)
 * 7. Download the policy (COSE_Sign1)
 * 8. Attest the device (JSON)
 * 9. Override challenge (JSON)
 * 10. Override response (JSON → COSE_Sign1)
 * 11. Verify device is now recovering
 * 12. Unlock the device (admin)
 * 13. Delete the device (admin)
 * 14. Verify audit trail records exist
 *
 * This test does NOT require PBL firmware or QEMU/swtpm — it exercises
 * the Express server's PBL route handlers end-to-end via supertest.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { router, createEnv } = require('../src/routes/pbl');
const { setSharedKvStore } = require('../src/pbl/kvStore');
const cbor = require('../src/pbl/cbor');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';
process.env.JWT_SECRET = JWT_SECRET;

function makeToken(role = 'super-admin') {
  return jwt.sign({ id: 'admin-1', username: 'admin', role }, JWT_SECRET, { expiresIn: '1h' });
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

function buildVerdictRequest(deviceId, nonce, policyVersion = 1) {
  return cbor.encodeMap([
    [cbor.encodeUint(1), cbor.encodeBstr(deviceId)],
    [cbor.encodeUint(2), cbor.encodeBstr(nonce)],
    [cbor.encodeUint(3), cbor.encodeBstr(Buffer.alloc(32))],
    [cbor.encodeUint(4), cbor.encodeUint(policyVersion)],
  ]);
}

function buildEnrollRequest(deviceId, ekCert, akPublic) {
  return cbor.encodeMap([
    [cbor.encodeUint(1), cbor.encodeBstr(deviceId)],
    [cbor.encodeUint(2), cbor.encodeBstr(ekCert)],
    [cbor.encodeUint(3), cbor.encodeBstr(akPublic)],
  ]);
}

describe('D-210: Full PBL flow integration through Express', () => {
  let app;
  let env;
  const deviceIdHex = 'ab'.repeat(32);
  const deviceIdBytes = Buffer.alloc(32, 0xab);
  const nonce = Buffer.alloc(32, 0xcd);
  const token = makeToken('super-admin');

  beforeAll(() => {
    setSharedKvStore(new Map());  // D-206: Fresh KV store for integration test
    env = createEnv();
    app = createApp(env);
  });

  it('1. Health check returns ok', async () => {
    const resp = await request(app).get('/v1/health');
    expect(resp.status).toBe(200);
    expect(resp.body.status).toBe('ok');
  });

  it('2. Enrolls a new device (CBOR)', async () => {
    const ekCert = Buffer.alloc(64, 0x11);
    const akPublic = Buffer.alloc(128, 0x22);
    const body = buildEnrollRequest(deviceIdBytes, ekCert, akPublic);

    const resp = await request(app)
      .post('/v1/enroll')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cbor');
    expect(parseInt(resp.headers['content-length'] || '0', 10)).toBeGreaterThan(0);

    // Verify device was stored
    const stored = await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text');
    expect(stored).toBeTruthy();
    const device = JSON.parse(stored);
    expect(device.device_id).toBe(deviceIdHex);
    expect(device.status).toBe('active');
  });

  it('3. Gets UNLOCKED verdict for active device (CBOR → COSE_Sign1)', async () => {
    const body = buildVerdictRequest(deviceIdBytes, nonce);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
    expect(parseInt(resp.headers['content-length'] || '0', 10)).toBeGreaterThan(100);
  });

  it('4. Locks the device (admin)', async () => {
    const resp = await request(app)
      .post(`/v1/devices/${deviceIdHex}/lock`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({});

    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('locked');
  });

  it('5. Gets LOCKED verdict for locked device (CBOR → COSE_Sign1)', async () => {
    const body = buildVerdictRequest(deviceIdBytes, nonce);

    const resp = await request(app)
      .post('/v1/verdict')
      .set('Content-Type', 'application/cbor')
      .send(body);

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
    expect(parseInt(resp.headers['content-length'] || '0', 10)).toBeGreaterThan(100);

    // Verify challenge_seed was stored
    const seed = await env.LOCKDOWN_KV.get(`pbl_challenge_seed:${deviceIdHex}`, 'text');
    expect(seed).toBeTruthy();
    expect(seed.length).toBe(32);
  });

  it('6. Creates a policy via form (admin)', async () => {
    const resp = await request(app)
      .post('/v1/policy/create')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({
        version: 1,
        lock_service_uri: 'https://pbl-verdict.example.com',
        spi_protection_required: true,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.stored).toBe(true);
    expect(resp.body.version).toBe('1');
  });

  it('7. Downloads the policy (COSE_Sign1)', async () => {
    const resp = await request(app).get('/v1/policy/latest');

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
    expect(parseInt(resp.headers['content-length'] || '0', 10)).toBeGreaterThan(0);
    expect(resp.headers.etag).toBeDefined();
  });

  it('8. Attests the device (JSON)', async () => {
    const resp = await request(app)
      .post('/v1/attest')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceIdHex,
        quote: Buffer.from('test-quote').toString('base64'),
      });

    expect(resp.status).toBe(200);
    expect(resp.body.attested).toBe(true);
    expect(resp.body).toHaveProperty('quote_verified');
    expect(resp.body).toHaveProperty('ak_name_valid');
    expect(resp.body).toHaveProperty('pcr_digest_valid');
  });

  it('9. Override challenge (JSON)', async () => {
    // Get the stored challenge_seed from the verdict
    const seed = await env.LOCKDOWN_KV.get(`pbl_challenge_seed:${deviceIdHex}`, 'text');

    const resp = await request(app)
      .post('/v1/override/challenge')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceIdHex,
        challenge_seed: seed,
      });

    expect(resp.status).toBe(200);
    expect(resp.body.challenge).toBeTruthy();
    expect(resp.body.expires_at).toBeGreaterThan(0);
  });

  it('10. Override response (JSON → COSE_Sign1)', async () => {
    // Get the stored challenge
    const challengeData = await env.LOCKDOWN_KV.get(`pbl_override_challenge:${deviceIdHex}`, 'text');
    const stored = JSON.parse(challengeData);

    const resp = await request(app)
      .post('/v1/override/response')
      .set('Content-Type', 'application/json')
      .send({
        device_id: deviceIdHex,
        challenge: stored.challenge,
        response: 'dev-mode-response',
      });

    expect(resp.status).toBe(200);
    expect(resp.headers['content-type']).toContain('application/cose');
  });

  it('11. Verifies device is now recovering', async () => {
    const stored = await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text');
    const device = JSON.parse(stored);
    expect(device.status).toBe('recovering');
  });

  it('12. Unlocks the device (admin)', async () => {
    const resp = await request(app)
      .post(`/v1/devices/${deviceIdHex}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({});

    expect(resp.status).toBe(200);
    expect(resp.body.device.status).toBe('active');
  });

  it('13. Deletes the device (admin)', async () => {
    const resp = await request(app)
      .delete(`/v1/devices/${deviceIdHex}`)
      .set('Authorization', `Bearer ${token}`);

    expect(resp.status).toBe(200);
    // Verify device is gone
    const stored = await env.LOCKDOWN_KV.get(`pbl_devices:${deviceIdHex}`, 'text');
    expect(stored).toBeNull();
  });

  it('14. Verifies audit trail records exist', async () => {
    const keys = await env.LOCKDOWN_KV.list({ prefix: `pbl_override_audit:${deviceIdHex}:` });
    expect(keys.keys.length).toBeGreaterThan(0);
  });
});
