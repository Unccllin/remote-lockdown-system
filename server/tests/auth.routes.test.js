const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { mockPool } = require('./helpers');
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

describe('username normalisation (one contract for every route)', () => {
  const { normalizeUsername } = require('../src/validation/username');
  const app = createApp();

  test('trims before use', () => {
    expect(normalizeUsername('  local-admin  ')).toEqual({ ok: true, value: 'local-admin' });
  });

  test('allows the documented character set, including @ and .', () => {
    const names = ['admin', 'local-admin', 'ops_1', 'ops@example.com', 'first.last'];
    // Collect failures rather than asserting in a loop: the assertion names the
    // offending value, which a bare expect() cannot.
    const rejected = names.filter((name) => !normalizeUsername(name).ok);
    expect(rejected).toEqual([]);
  });

  test('rejects whitespace *inside* the name, with a message that says so', () => {
    const result = normalizeUsername('bad name');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/may contain only/);
  });

  test('rejects a non-string', () => {
    expect(normalizeUsername(undefined).ok).toBe(false);
    expect(normalizeUsername(42).ok).toBe(false);
  });

  test('enforces 3-100 on creation but not on login', () => {
    expect(normalizeUsername('ab').ok).toBe(false);
    expect(normalizeUsername('ab', { enforceLength: false }).ok).toBe(true);
  });

  test('login accepts a padded username for the existing account', async () => {
    // Reported from a freshly set-up machine: " local-admin" was rejected as
    // "invalid characters", which reads exactly like a wrong password.
    const hash = bcrypt.hashSync('password123', 10);
    mockPool.query.setResult('SELECT * FROM admins', {
      rows: [{ id: 'admin-1', username: 'local-admin', password_hash: hash }],
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: '  local-admin  ', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.admin.username).toBe('local-admin');
    // The lookup must use the trimmed value, or the row would never match.
    const lookup = mockPool.query.mock.calls.find((c) => /FROM admins WHERE username/.test(c[0]));
    expect(lookup[1][0]).toBe('local-admin');
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
