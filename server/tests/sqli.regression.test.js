/**
 * FA7: SQLi regression smoke test.
 *
 * Single smoke test that verifies parameterized queries are used on key
 * endpoints. This is NOT a comprehensive SQLi suite — it's a regression
 * guard to ensure no raw string concatenation crept into the query paths.
 *
 * The mock pool intercepts all SQL and checks that user input appears in
 * params (parameterized), not in the SQL string itself.
 */

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const authRoutes = require('../src/routes/auth');
const devicesRoutes = require('../src/routes/devices');
const agentRoutes = require('../src/routes/agent');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-that-is-long-enough-for-validation-32';

function makeToken() {
  return jwt.sign({ id: '00000000-0000-0000-0000-000000000001', username: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/agent', agentRoutes);
  return app;
}

const SQLI_PAYLOADS = [
  "'; DROP TABLE devices; --",
  "' OR '1'='1",
  "' UNION SELECT * FROM admins; --",
  "1; DELETE FROM devices WHERE '1'='1",
];

describe('FA7: SQLi regression smoke test', () => {
  const app = createApp();

  beforeEach(() => {
    mockPool.query.reset();
  });

  test('device enrollment: SQLi in hostname is rejected at input validation; SQLi in owner_name is parameterized', async () => {
    // hostname is now charset-validated at the input boundary (see
    // validateHostname in routes/devices.js) — SQLi payloads contain chars
    // outside [a-zA-Z0-9-] and must be rejected (400) before any INSERT.
    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('INSERT INTO devices', { rows: [{ id: 'dev-1', hostname: payload, owner_name: payload }] });

      const res = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ hostname: payload, owner_name: 'valid-owner' });

      // Input validation rejects the malicious hostname — no INSERT issued.
      expect(res.status).toBe(400);
      const insertCall = mockPool.query.mock.calls.find(
        c => c[0].includes('INSERT INTO devices')
      );
      expect(insertCall).toBeUndefined();
    }

    // owner_name remains a free-text field and still relies on DB
    // parameterization — verify a SQLi payload there is parameterized, not
    // concatenated into the SQL string.
    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('INSERT INTO devices', { rows: [{ id: 'dev-1', hostname: 'DEV-001', owner_name: payload }] });

      const res = await request(app)
        .post('/api/devices')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ hostname: 'DEV-001', owner_name: payload });

      // The request should succeed (mock returns a row)
      expect(res.status).toBe(201);

      // Verify the SQLi payload is in params, NOT in the SQL string
      const insertCall = mockPool.query.mock.calls.find(
        c => c[0].includes('INSERT INTO devices')
      );
      expect(insertCall).toBeDefined();
      // The SQL string should NOT contain the payload
      expect(insertCall[0]).not.toContain('DROP TABLE');
      expect(insertCall[0]).not.toContain('UNION SELECT');
      expect(insertCall[0]).not.toContain("OR '1'='1");
      // The payload should be in the params array
      expect(insertCall[1]).toContain(payload);
    }
  });

  test('agent checkin: SQLi in hostname is parameterized', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE hostname', { rows: [device] });
    mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });

    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('SELECT * FROM devices WHERE api_key_hash', { rows: [] });
      mockPool.query.setResult('SELECT * FROM devices WHERE hostname', { rows: [device] });
      mockPool.query.setResult('SELECT * FROM commands', { rows: [] });

      const res = await request(app)
        .post('/api/agent/checkin')
        .set('x-agent-key', process.env.AGENT_SHARED_KEY)
        .send({ hostname: payload });

      // Find the hostname query
      const hostnameCall = mockPool.query.mock.calls.find(
        c => c[0].includes('SELECT * FROM devices WHERE hostname')
      );
      expect(hostnameCall).toBeDefined();
      // SQL string should NOT contain the payload
      expect(hostnameCall[0]).not.toContain('DROP TABLE');
      expect(hostnameCall[0]).not.toContain('UNION SELECT');
      // Payload should be in params
      expect(hostnameCall[1]).toContain(payload);
    }
  });

  test('flag-stolen: SQLi in device ID is parameterized', async () => {
    const device = { id: 'dev-1', hostname: 'DEV-001', status: 'active' };
    mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
    mockPool.query.setResult('INSERT INTO commands', { rows: [{ id: 'cmd-1' }] });

    for (const payload of SQLI_PAYLOADS) {
      mockPool.query.reset();
      mockPool.query.setResult('SELECT * FROM devices WHERE id', { rows: [device] });
      mockPool.query.setResult('INSERT INTO commands', { rows: [{ id: 'cmd-1' }] });

      const res = await request(app)
        .post(`/api/devices/${payload}/flag-stolen`)
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ hostname_confirm: 'DEV-001' });

      // Find the SELECT by id query
      const selectCall = mockPool.query.mock.calls.find(
        c => c[0].includes('SELECT * FROM devices WHERE id')
      );
      expect(selectCall).toBeDefined();
      // SQL string should NOT contain the payload
      expect(selectCall[0]).not.toContain('DROP TABLE');
      expect(selectCall[0]).not.toContain('UNION SELECT');
      // Payload should be in params
      expect(selectCall[1]).toContain(payload);
    }
  });
});
