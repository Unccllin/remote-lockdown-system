/**
 * Shared test helpers for the server test suite.
 *
 * Usage:
 *   const { makeToken, createApp, mockPool } = require('./helpers');
 *   jest.mock('../src/db/pool', () => mockPool);
 *
 * makeToken supports all argument orders used across the test suite:
 *   makeToken()                              — super-admin, admin-1, admin
 *   makeToken('admin-2')                     — super-admin with custom id
 *   makeToken('admin-2', 'bob')              — super-admin with custom id + name
 *   makeToken('admin-2', 'bob', 'device-admin') — custom role
 *   makeToken({ role: 'device-admin' })      — options object form
 */

const jwt = require('jsonwebtoken');
const express = require('express');

const { mockPool } = require('./mockPool');

const JWT_SECRET = 'test-secret-key-that-is-long-enough-for-validation-32';

/**
 * Create a signed JWT for testing.
 * Supports both positional and options-object forms.
 */
function makeToken(adminId = 'admin-1', username = 'admin', role = 'super-admin') {
  return jwt.sign({ id: adminId, username, role }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Create an Express app with the given routes mounted under /api.
 * Pass a routes object: { devices: devicesRoutes, admins: adminsRoutes, ... }
 */
function createApp(routes = {}) {
  const app = express();
  app.use(express.json());
  for (const [path, router] of Object.entries(routes)) {
    app.use(`/api/${path}`, router);
  }
  return app;
}

module.exports = { makeToken, createApp, mockPool, JWT_SECRET };
