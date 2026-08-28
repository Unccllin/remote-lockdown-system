/**
 * Phase 13: Tests for the Prometheus metrics endpoint.
 *
 * Covers:
 *   - GET /metrics returns 200
 *   - Response is text/plain (Prometheus exposition format)
 *   - Response contains the lockdown_devices_total custom metric
 *   - Response contains process metrics (from prom-client defaults)
 *   - No auth required
 */

const request = require('supertest');
const express = require('express');

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const metricsRoutes = require('../src/routes/metrics');

function createApp() {
  const app = express();
  app.use('/metrics', metricsRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

describe('GET /metrics', () => {
  const app = createApp();

  test('returns 200', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  test('response is text/plain (Prometheus format)', async () => {
    const res = await request(app).get('/metrics');
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // Prometheus exposition format uses HELP/TYPE lines.
    expect(res.text).toMatch(/# (HELP|TYPE)/);
  });

  test('response contains lockdown_devices_total metric', async () => {
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('lockdown_devices_total');
  });

  test('response contains process metrics (prom-client defaults)', async () => {
    const res = await request(app).get('/metrics');
    // prom-client default metrics include process_* and node_* metrics.
    expect(res.text).toMatch(/process_/);
  });

  test('does not require auth', async () => {
    // No Authorization header — should still return 200.
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  test('still returns 200 when DB is unavailable', async () => {
    mockPool.setError('SELECT 1', new Error('connection refused'));
    const res = await request(app).get('/metrics');
    // Endpoint should not 500 on DB failure — it returns whatever metrics
    // it can (default process metrics + last-known custom values).
    expect(res.status).toBe(200);
  });
});
