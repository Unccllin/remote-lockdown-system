const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const { mockPool, JWT_SECRET } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const auditRoutes = require('../src/routes/audit');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit', auditRoutes);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

function makeToken() {
  return jwt.sign({ id: 'admin-1', username: 'admin', role: 'super-admin' }, JWT_SECRET, {
    expiresIn: '1h',
  });
}

beforeEach(() => {
  mockPool.query.reset();
});

describe('GET /api/audit', () => {
  test('returns 401 without auth token', async () => {
    const res = await request(createApp()).get('/api/audit');

    expect(res.status).toBe(401);
  });

  test('returns 200 and an array with auth', async () => {
    const rows = [
      { id: 1, action: 'admin_login', hostname: 'DEV-001', admin_username: 'admin' },
      { id: 2, action: 'device_locked', hostname: 'DEV-002', admin_username: 'admin' },
    ];
    mockPool.query.setResult('FROM audit_log', { rows });

    const res = await request(createApp())
      .get('/api/audit')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].action).toBe('admin_login');
  });

  test('filters by device_id when provided', async () => {
    const deviceId = '12345678-1234-1234-1234-1234567890ab';
    const rows = [
      { id: 3, action: 'device_locked', device_id: deviceId, hostname: 'DEV-002', admin_username: 'admin' },
    ];
    mockPool.query.setResult('FROM audit_log', { rows });

    const res = await request(createApp())
      .get(`/api/audit?device_id=${deviceId}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].device_id).toBe(deviceId);

    // Verify the WHERE clause was applied
    const queryCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('FROM audit_log') && c[0].includes('WHERE al.device_id = $1')
    );
    expect(queryCall).toBeDefined();
    expect(queryCall[1]).toContain(deviceId);
  });

  test('applies limit when provided', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      action: 'admin_login',
      hostname: 'DEV-001',
      admin_username: 'admin',
    }));
    mockPool.query.setResult('FROM audit_log', { rows });

    const res = await request(createApp())
      .get('/api/audit?limit=10')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(10);

    // Verify LIMIT was passed as a query parameter
    const queryCall = mockPool.query.mock.calls.find(
      (c) => c[0].includes('FROM audit_log') && c[0].includes('LIMIT')
    );
    expect(queryCall).toBeDefined();
    expect(queryCall[1]).toContain(10);
  });

  test('returns 400 when device_id has invalid format', async () => {
    const res = await request(createApp())
      .get('/api/audit?device_id=invalid!')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid device_id/i);
  });
});
