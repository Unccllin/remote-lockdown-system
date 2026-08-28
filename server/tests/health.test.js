const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool, JWT_SECRET } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const healthRoutes = require('../src/routes/health');


function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRoutes);
  return app;
}

function makeToken() {
  return jwt.sign({ id: 'admin-1', username: 'admin' }, JWT_SECRET, {
    expiresIn: '1h',
  });
}

beforeEach(() => {
  mockPool.query.reset();
});

describe('GET /api/health', () => {
  const app = createApp();

  test('returns 200 with status ok (liveness)', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  test('does not require auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/health/ready', () => {
  const app = createApp();

  test('returns 200 when DB is connected', async () => {
    // Default mock returns { rows: [] } for SELECT 1 — that's a successful query.
    const res = await request(app).get('/api/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.dbLatencyMs).toBeDefined();
  });

  test('returns 503 when DB query fails', async () => {
    mockPool.setError('SELECT 1', new Error('connection refused'));

    const res = await request(app).get('/api/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('disconnected');
    expect(res.body.error).toBeDefined();
  });
});

describe('GET /api/health/detailed', () => {
  const app = createApp();

  test('requires auth — returns 401 without token', async () => {
    const res = await request(app).get('/api/health/detailed');

    expect(res.status).toBe(401);
  });

  test('returns fleet stats with auth', async () => {
    // Mock the fleet stats aggregate query.
    mockPool.query.setResult('FROM devices', {
      rows: [
        {
          total: '5',
          active: '3',
          stale: '1',
          missing: '1',
          dead: '0',
          never: '0',
        },
      ],
    });
    // Mock the pending command queue depth query.
    mockPool.query.setResult('FROM commands WHERE status', {
      rows: [{ pending: '2' }],
    });
    // Mock the recent alerts query (returns none).
    mockPool.query.setResult('FROM audit_log', { rows: [] });

    const res = await request(app)
      .get('/api/health/detailed')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.fleet).toBeDefined();
    expect(res.body.fleet.total).toBe(5);
    expect(res.body.fleet.active).toBe(3);
    expect(res.body.fleet.stale).toBe(1);
    expect(res.body.fleet.missing).toBe(1);
    expect(res.body.fleet.dead).toBe(0);
    expect(res.body.queueDepth).toBe(2);
    expect(res.body.db.connected).toBe(true);
    expect(res.body.server.uptimeSeconds).toBeDefined();
    expect(Array.isArray(res.body.recentAlerts)).toBe(true);
  });

  test('reports degraded status when DB is down', async () => {
    mockPool.setError('SELECT 1', new Error('connection refused'));

    const res = await request(app)
      .get('/api/health/detailed')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db.connected).toBe(false);
    expect(res.body.fleet.total).toBe(0);
  });
});
