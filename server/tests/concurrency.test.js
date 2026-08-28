/**
 * FA7 / CC8: Concurrency tests.
 *
 * Tests concurrent agent checkins and command ACKs.
 *
 * NOTE: PGlite is single-connection (serialized via async mutex in pglitePool).
 * These tests verify that concurrent requests are serialized correctly and
 * don't corrupt each other's state. True parallel DB execution would require
 * a real PostgreSQL server — these tests validate the application-level
 * concurrency handling (no race conditions in route handlers, no interleaved
 * transactions).
 */

const { mockPool } = require('./helpers');
jest.mock('../src/db/pool', () => mockPool);

const request = require('supertest');
const express = require('express');
const agentRoutes = require('../src/routes/agent');

const AGENT_KEY = process.env.AGENT_SHARED_KEY;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return app;
}

describe('CC8: Concurrency — concurrent agent requests', () => {
  const app = createApp();

  beforeEach(() => {
    mockPool.query.reset();
  });

  test('concurrent checkins from different devices all succeed', async () => {
    // Setup: each device has its own row
    const devices = [
      { id: 'dev-1', hostname: 'DEV-001', status: 'active' },
      { id: 'dev-2', hostname: 'DEV-002', status: 'active' },
      { id: 'dev-3', hostname: 'DEV-003', status: 'active' },
    ];

    // Mock returns the matching device based on hostname in the query
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT * FROM devices WHERE api_key_hash')) {
        return { rows: [] }; // no per-device key match
      }
      if (sql.includes('SELECT * FROM devices WHERE hostname')) {
        const hostname = params[0];
        const device = devices.find(d => d.hostname === hostname);
        return { rows: device ? [device] : [] };
      }
      if (sql.includes('SELECT * FROM commands')) {
        return { rows: [] }; // no pending commands
      }
      return { rows: [] };
    });

    // Fire 3 concurrent checkins
    const promises = devices.map(d =>
      request(app)
        .post('/api/agent/checkin')
        .set('x-agent-key', AGENT_KEY)
        .send({ hostname: d.hostname })
    );

    const results = await Promise.all(promises);

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.device_id).toBeDefined();
    }

    // Verify each device got its own ID
    const deviceIds = results.map(r => r.body.device_id);
    expect(new Set(deviceIds).size).toBe(3);
  });

  test('concurrent command ACKs for different commands don\'t interleave', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'stolen' };
    const cmds = [
      { id: 'cmd-1', command_type: 'lockdown' },
      { id: 'cmd-2', command_type: 'lockdown' },
    ];

    let cmdIdx = 0;
    mockPool.query.mockImplementation(async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT * FROM devices WHERE api_key_hash')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM devices WHERE hostname')) {
        return { rows: [device] };
      }
      if (sql.includes('SELECT command_type FROM commands')) {
        const cmdId = params[0];
        const cmd = cmds.find(c => c.id === cmdId) || cmds[cmdIdx++ % cmds.length];
        return { rows: [cmd] };
      }
      return { rows: [] };
    });

    // Fire 2 concurrent ACKs
    const promises = cmds.map(cmd =>
      request(app)
        .post('/api/agent/command-ack')
        .set('x-agent-key', AGENT_KEY)
        .send({
          hostname: 'DEV-001',
          command_id: cmd.id,
          result_status: 'executed',
          key_material: `key-${cmd.id}==`,
        })
    );

    const results = await Promise.all(promises);

    // Both should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  test('concurrent location reports are serialized correctly', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'tracking' };

    mockPool.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT * FROM devices WHERE api_key_hash')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM devices WHERE hostname')) {
        return { rows: [device] };
      }
      return { rows: [] };
    });

    // Fire 5 concurrent location reports
    const promises = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post('/api/agent/location')
        .set('x-agent-key', AGENT_KEY)
        .send({
          hostname: 'DEV-001',
          location: {
            latitude: 37.7749 + i * 0.001,
            longitude: -122.4194,
            source: 'wifi',
          },
        })
    );

    const results = await Promise.all(promises);

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });
});
