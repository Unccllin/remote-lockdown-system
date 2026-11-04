/**
 * EFS certificate escrow: POST /api/agent/efs-cert (agent) +
 * GET /api/devices/:id/efs-cert (super-admin).
 *
 * The agent has always posted to the first route and the Worker has always served
 * it; Express had neither, so a self-hosted deployment silently kept no backup
 * (S208, found by the cross-surface audit). The response is a recovery secret, so
 * the download is gated and audited.
 */

const request = require('supertest');

const { mockPool, makeToken, createApp } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const agentRoutes = require('../src/routes/agent');
const devicesRoutes = require('../src/routes/devices');

const app = createApp({ agent: agentRoutes, devices: devicesRoutes });

const AGENT_KEY = 'test-agent-key-that-is-long-enough-24';

beforeEach(() => {
  mockPool.query.reset();
});

function provisionDevice(overrides = {}) {
  const device = {
    id: 'dev-1',
    hostname: 'DEV-001',
    status: 'active',
    api_key_hash: 'hash-of-key',
    ...overrides,
  };
  mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [device] });
  mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
  return device;
}

describe('POST /api/agent/efs-cert', () => {
  test('requires agent auth', async () => {
    const res = await request(app).post('/api/agent/efs-cert').send({ cert_base64: 'QUJD' });
    expect(res.status).toBe(401);
  });

  test('requires cert_base64', async () => {
    provisionDevice();
    const res = await request(app)
      .post('/api/agent/efs-cert')
      .set('x-agent-key', AGENT_KEY)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cert_base64/);
  });

  test('stores the backup, encrypted password included, and audits it', async () => {
    provisionDevice();
    mockPool.query.setResult('UPDATE device_efs_certs', { rows: [], rowCount: 0 });
    mockPool.query.setResult('INSERT INTO device_efs_certs', { rows: [] });

    const res = await request(app)
      .post('/api/agent/efs-cert')
      .set('x-agent-key', AGENT_KEY)
      .send({ cert_base64: 'QUJDRA==', cert_password: 'pfx-pass' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device: { id: 'dev-1', hostname: 'DEV-001' }, stored: true });

    const insert = mockPool.query.mock.calls.find((c) => /INSERT INTO device_efs_certs/.test(c[0]));
    expect(insert).toBeTruthy();
    const params = insert[1];
    expect(params[0]).toBe('dev-1');
    expect(params[1]).toBe('QUJDRA==');
    // The password is encrypted at rest (FIELD_ENCRYPTION_KEY is set in tests):
    // ciphertext present, and NOT the plaintext in the encrypted column.
    expect(params[3]).toBeTruthy();
    expect(params[3]).not.toBe('pfx-pass');
    expect(params[4]).toBeTruthy(); // nonce
    expect(params[5]).toBeTruthy(); // tag
    // …and the plaintext column must be null, or the secret is readable at rest
    // anyway (caught live, not by the first version of this test).
    expect(params[2]).toBeNull();

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('efs_cert_uploaded');
  });

  test('replaces an existing backup instead of adding a second row', async () => {
    provisionDevice();
    mockPool.query.setResult('UPDATE device_efs_certs', { rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/agent/efs-cert')
      .set('x-agent-key', AGENT_KEY)
      .send({ cert_base64: 'TkVX' });

    expect(res.status).toBe(200);
    expect(mockPool.query.mock.calls.some((c) => /INSERT INTO device_efs_certs/.test(c[0]))).toBe(
      false
    );
  });
});

describe('GET /api/devices/:id/efs-cert', () => {
  test('is super-admin only', async () => {
    const noAuth = await request(app).get('/api/devices/dev-1/efs-cert');
    expect(noAuth.status).toBe(401);

    const operator = await request(app)
      .get('/api/devices/dev-1/efs-cert')
      .set('Authorization', `Bearer ${makeToken('admin-2', 'ops', 'operator')}`);
    expect(operator.status).toBe(403);
  });

  test('404s when the device has no backup', async () => {
    mockPool.query.setResult('SELECT * FROM device_efs_certs', { rows: [] });

    const res = await request(app)
      .get('/api/devices/dev-1/efs-cert')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No EFS certificate backup/);
  });

  test('returns the backup and audits the disclosure', async () => {
    mockPool.query.setResult('SELECT * FROM device_efs_certs', {
      rows: [
        {
          device_id: 'dev-1',
          cert_base64: 'QUJDRA==',
          cert_password: 'legacy-plaintext',
          cert_password_enc: null,
          cert_password_nonce: null,
          cert_password_tag: null,
          uploaded_at: '2026-11-04T00:00:00Z',
        },
      ],
    });

    const res = await request(app)
      .get('/api/devices/dev-1/efs-cert')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.cert_base64).toBe('QUJDRA==');
    // Legacy plaintext rows still read (dual-mode), and the read is audited.
    expect(res.body.cert_password).toBe('legacy-plaintext');

    const audit = mockPool.query.mock.calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit[1][2]).toBe('efs_cert_downloaded');
  });
});
