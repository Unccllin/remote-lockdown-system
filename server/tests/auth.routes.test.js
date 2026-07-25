const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./mockPool');
jest.mock('../src/db/pool', () => mockPool);

const authRoutes = require('../src/routes/auth');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

beforeEach(() => {
  mockPool.query.reset();
});

// NOTE: /api/auth/register was removed — admin creation now lives at
// POST /api/setup/create-admin, which enforces a first-admin-only guard.
// See setup.routes.test.js for coverage of that endpoint, including the
// 403-on-second-admin case that proves the guard works.

describe('POST /api/auth/login', () => {
  const app = createApp();

  test('returns JWT on valid credentials', async () => {
    const hash = bcrypt.hashSync('password123', 10);
    const admin = { id: 'admin-1', username: 'admin', password_hash: hash };
    mockPool.query.setResult('SELECT * FROM admins', { rows: [admin] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.admin.username).toBe('admin');

    // Verify token is valid
    const decoded = jwt.verify(res.body.token, 'test-secret-key-that-is-long-enough-for-validation-32');
    expect(decoded.username).toBe('admin');
  });

  test('returns 401 on wrong password', async () => {
    const hash = bcrypt.hashSync('correct-password', 10);
    const admin = { id: 'admin-1', username: 'admin', password_hash: hash };
    mockPool.query.setResult('SELECT * FROM admins', { rows: [admin] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  test('returns 401 on non-existent user', async () => {
    mockPool.query.setResult('SELECT * FROM admins', { rows: [] });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'password' });

    expect(res.status).toBe(401);
  });
});
