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

describe('POST /api/auth/register', () => {
  const app = createApp();

  test('creates a new admin account', async () => {
    const admin = { id: 'admin-1', username: 'admin', created_at: '2025-01-01T00:00:00Z' };
    mockPool.query.setResult('INSERT INTO admins', { rows: [admin] });

    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('admin');
  });

  test('returns 400 if username or password missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin' });

    expect(res.status).toBe(400);
  });
});

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
    const decoded = jwt.verify(res.body.token, 'test-secret-key');
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
