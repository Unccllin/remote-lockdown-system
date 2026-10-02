const request = require('supertest');
const express = require('express');

const { mockPool } = require('./helpers');
const { makeToken } = require('./helpers');

jest.mock('../src/db/pool', () => mockPool);
jest.mock('../src/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const hwTestArtifactRoutes = require('../src/routes/hwTestArtifact');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/hw-test-artifact', hwTestArtifactRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const LEGACY_ARTIFACT = {
  harness_version: '2.0',
  timestamp: '2026-08-29T12:00:00Z',
  environment: {
    platform: 'Windows',
    hostname: 'TEST-LAPTOP-001',
    agent_binary_hash: 'abc123',
  },
  results: [
    { test_id: 'E-ENCRYPT-01', status: 'PASS', detail: 'OK' },
    { test_id: 'E-LOCK-SCREEN-01', status: 'SKIP', detail: 'Not Windows' },
  ],
  summary: { total: 2, passed: 1, failed: 0, skipped: 1, errors: 0 },
};

const CTRF_ARTIFACT = {
  results: {
    tool: { name: 'hw-test-harness', version: '2.0' },
    summary: { tests: 2, passed: 1, failed: 0, skipped: 1, errors: 0 },
    tests: [
      { name: 'E-ENCRYPT-01', status: 'passed', duration: 100 },
      { name: 'E-LOCK-SCREEN-01', status: 'skipped', duration: 0 },
    ],
    extra: {
      environment: {
        platform: 'Windows',
        hostname: 'TEST-LAPTOP-001',
        agent_binary_hash: 'abc123',
      },
    },
  },
};

describe('POST /api/hw-test-artifact', () => {
  beforeEach(() => {
    mockPool.query.reset();
  });

  test('returns 401 without auth', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .send(LEGACY_ARTIFACT);
    expect(res.status).toBe(401);
  });

  test('stores legacy format artifact and returns 201', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // device lookup
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, created_at: '2026-08-29T12:00:00Z' }],
    }); // insert
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // audit log insert

    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(LEGACY_ARTIFACT);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(res.body.hostname).toBe('TEST-LAPTOP-001');
    expect(res.body.summary.passed).toBe(1);
  });

  test('stores CTRF format artifact and returns 201', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // device lookup
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 2, created_at: '2026-08-29T12:00:00Z' }],
    }); // insert
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // audit log insert

    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(CTRF_ARTIFACT);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(2);
    expect(res.body.summary.passed).toBe(1);
  });

  test('returns 400 for invalid artifact format', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ foo: 'bar' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid artifact format/i);
  });

  test('returns 400 for non-object body', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send('not-json-object');

    expect(res.status).toBe(400);
  });

  test('associates artifact with matching device by hostname', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 'dev-123' }],
    }); // device lookup — found
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 3, created_at: '2026-08-29T12:00:00Z' }],
    }); // insert
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // audit log insert

    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(LEGACY_ARTIFACT);

    expect(res.status).toBe(201);
    expect(res.body.device_id).toBe('dev-123');
    // Verify device lookup query used the hostname
    expect(mockPool.query.mock.calls[0][0]).toContain('WHERE hostname = $1');
    expect(mockPool.query.mock.calls[0][1]).toContain('TEST-LAPTOP-001');
  });

  test('returns 503 when table does not exist', async () => {
    const tableErr = new Error('relation does not exist');
    tableErr.code = '42P01';
    mockPool.query.mockRejectedValueOnce(tableErr);

    const app = createApp();
    const res = await request(app)
      .post('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(LEGACY_ARTIFACT);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/table not found/i);
  });
});

describe('GET /api/hw-test-artifact', () => {
  beforeEach(() => {
    mockPool.query.reset();
  });

  test('returns 401 without auth', async () => {
    const app = createApp();
    const res = await request(app).get('/api/hw-test-artifact');
    expect(res.status).toBe(401);
  });

  test('returns list of artifacts with auth', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, hostname: 'HOST-1', harness_version: '2.0', passed: 5 },
        { id: 2, hostname: 'HOST-2', harness_version: '2.0', passed: 3 },
      ],
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/hw-test-artifact')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].hostname).toBe('HOST-1');
  });

  test('filters by device_id when provided', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const app = createApp();
    await request(app)
      .get('/api/hw-test-artifact?device_id=12345678-1234-1234-1234-1234567890ab')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(mockPool.query.mock.calls[0][0]).toContain('WHERE device_id = $1');
  });

  test('returns 400 for invalid device_id format', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/hw-test-artifact?device_id=invalid!')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
  });
});

describe('GET /api/hw-test-artifact/:id', () => {
  beforeEach(() => {
    mockPool.query.reset();
  });

  test('returns 401 without auth', async () => {
    const app = createApp();
    const res = await request(app).get('/api/hw-test-artifact/1');
    expect(res.status).toBe(401);
  });

  test('returns artifact by id', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          hostname: 'HOST-1',
          artifact_json: '{"harness_version":"2.0"}',
        },
      ],
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/hw-test-artifact/1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.artifact_json).toEqual({ harness_version: '2.0' });
  });

  test('returns 404 when artifact not found', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const app = createApp();
    const res = await request(app)
      .get('/api/hw-test-artifact/999')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });

  test('returns 400 for invalid id', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/hw-test-artifact/abc')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
  });
});
