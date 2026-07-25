const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const setupRoutes = require('../src/routes/setup');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', setupRoutes);
  // Match the production error handler so thrown errors become 500s
  // rather than crashing supertest.
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

// Helper: make the COUNT query return a specific admin count.
// Pattern must match the SQL in setup.js: 'SELECT COUNT(*) as count FROM admins'.
function setAdminCount(count) {
  mockPool.query.setResult('SELECT COUNT(*) as count FROM admins', {
    rows: [{ count: String(count) }],
  });
}

describe('GET /api/setup/status', () => {
  test('returns needsSetup:true when no admin exists', async () => {
    setAdminCount(0);
    const res = await request(createApp()).get('/api/setup/status');

    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
    expect(res.body.adminCount).toBe(0);
  });

  test('returns needsSetup:false when an admin exists', async () => {
    setAdminCount(1);
    const res = await request(createApp()).get('/api/setup/status');

    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(false);
    expect(res.body.adminCount).toBe(1);
  });

  test('returns needsSetup:true when the admins table is missing (DB error)', async () => {
    // Simulate the table-not-initialized branch in setup.js.
    mockPool.setError(
      'SELECT COUNT(*) as count FROM admins',
      new Error('relation "admins" does not exist')
    );

    const res = await request(createApp()).get('/api/setup/status');

    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
    expect(res.body.adminCount).toBe(0);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /api/setup/create-admin', () => {
  test('creates the first admin and returns 201', async () => {
    // First COUNT → 0 (no admin yet). INSERT INTO admins / audit_log
    // hit the default mock (returns { rows: [] }), which is fine.
    setAdminCount(0);

    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.username).toBe('admin');

    // Verify both INSERTs were issued (admins + audit_log).
    const calls = mockPool.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('INSERT INTO admins'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO audit_log'))).toBe(true);
  });

  test('hashes the password with bcrypt cost 12', async () => {
    setAdminCount(0);

    await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin', password: 'password123' });

    // Find the INSERT INTO admins call and inspect the hashed param.
    const insertCall = mockPool.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO admins')
    );
    expect(insertCall).toBeDefined();
    const hash = insertCall[1][2]; // params: [id, username, password_hash]
    expect(typeof hash).toBe('string');
    // bcrypt hashes start with $2b$ (or $2a$/$2y$) followed by the cost.
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(bcrypt.compareSync('password123', hash)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // The critical guard: once any admin exists, this endpoint must refuse
  // to create another. This is the test that proves the open-registration
  // vulnerability is closed (not just moved from /api/auth/register to here).
  // If this test ever fails, setup.js has drifted the same way auth.js did.
  // -----------------------------------------------------------------------
  test('returns 403 when an admin already exists (first-admin-only guard)', async () => {
    setAdminCount(1);

    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'second-admin', password: 'password123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/already been completed|disabled/i);

    // Critical: no INSERT INTO admins must have been issued.
    const calls = mockPool.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('INSERT INTO admins'))).toBe(false);
  });

  test('returns 400 when username is missing', async () => {
    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ password: 'password123' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when password is missing', async () => {
    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when username is shorter than 3 chars', async () => {
    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'ab', password: 'password123' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when username contains disallowed characters', async () => {
    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin user', password: 'password123' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when password is shorter than 8 chars', async () => {
    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin', password: 'short' });

    expect(res.status).toBe(400);
  });

  test('returns 409 on duplicate username (UNIQUE constraint)', async () => {
    setAdminCount(0);
    // Make the INSERT throw an error whose message includes 'UNIQUE',
    // matching the branch in setup.js's catch block.
    mockPool.setError(
      'INSERT INTO admins',
      new Error('UNIQUE constraint failed: admins.username')
    );

    const res = await request(createApp())
      .post('/api/setup/create-admin')
      .send({ username: 'admin', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });
});
