/**
 * Test: Error messages contain fix instructions (L10 principle).
 *
 * Verifies that key error messages across the server follow the pattern:
 *   <what went wrong>. <how to fix it>
 *
 * This test checks a representative sample of error responses from various
 * endpoints. It does NOT test every single error message — it tests the
 * pattern (a period followed by guidance text).
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// Mock the DB pool to avoid needing a real database connection
jest.mock('../src/db/pool', () => {
  const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
  return { query: mockQuery, connect: jest.fn() };
});

// Build a minimal app with the routes we want to test
function buildApp() {
  const app = express();
  app.use(express.json());

  // Mock JWT_SECRET for test tokens
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

  // Mount the real routes
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/setup', require('../src/routes/setup'));
  app.use('/api/admins', require('../src/routes/admins'));
  app.use('/api/audit', require('../src/routes/audit'));

  // 404 + error handlers (same as index.js)
  app.all('/api/*', (req, res) => {
    res.status(404).json({ error: 'Not found. Check the API endpoint path and method. Available routes are under /api/devices, /api/agent, /api/auth, /api/admins, /api/audit, /api/setup, /api/health.' });
  });
  app.use((err, _req, res, _next) => {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Conflict — resource already exists. Use a unique value for the field that caused the conflict.' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error. Check server logs for details and contact support if the issue persists.' });
  });

  return app;
}

// Check that an error message contains fix instructions.
// Pattern: a period followed by at least 10 characters of guidance text.
function hasFixInstructions(errorMsg) {
  if (!errorMsg || typeof errorMsg !== 'string') return false;
  // Look for ". " followed by at least 10 chars of guidance
  return /\.\s.{10,}/.test(errorMsg);
}

describe('Error messages contain fix instructions', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  test('auth login: missing fields includes fix instructions', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({});
    expect(res.status).toBe(400);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('auth login: invalid credentials includes fix instructions', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('setup: missing fields includes fix instructions', async () => {
    const res = await request(app)
      .post('/api/setup/create-admin')
      .send({});
    expect(res.status).toBe(400);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('setup: short password includes fix instructions', async () => {
    const res = await request(app)
      .post('/api/setup/create-admin')
      .send({ username: 'testuser', password: 'short' });
    expect(res.status).toBe(400);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('audit: invalid device_id format includes fix instructions', async () => {
    // Need auth for audit routes — create a test token
    const token = jwt.sign(
      { id: 'test', username: 'test', role: 'viewer' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app)
      .get('/api/audit?device_id=invalid-format')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('404: unmatched API route includes fix instructions', async () => {
    const res = await request(app)
      .get('/api/nonexistent-endpoint');
    expect(res.status).toBe(404);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });

  test('middleware auth: missing Authorization header includes fix instructions', async () => {
    // The admins route requires auth — no token should trigger auth middleware
    const res = await request(app)
      .get('/api/admins');
    expect(res.status).toBe(401);
    expect(hasFixInstructions(res.body.error)).toBe(true);
  });
});
