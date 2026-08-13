/**
 * Setup routes — first-run admin creation.
 *
 * These endpoints are used by the Electron admin app's first-run setup wizard.
 * They are only active when no admin user exists yet (first run).
 *
 * Security:
 *   - GET /api/setup/status: returns { needsSetup: true/false }
 *     This endpoint is safe to expose — it only reveals whether any admin
 *     exists, not any actual data.
 *   - POST /api/setup/create-admin: creates the initial admin account.
 *     This endpoint ONLY works when no admin exists. Once the first admin
 *     is created, it returns 403 (forbidden) permanently.
 *     This prevents attackers from using it to create rogue admin accounts.
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const logger = require('../logger');

/**
 * GET /api/setup/status
 * Returns whether the system needs initial setup (no admin exists).
 */
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM admins');
    const count = parseInt(result.rows[0].count);
    res.json({
      needsSetup: count === 0,
      adminCount: count,
    });
  } catch (err) {
    // If the admins table doesn't exist yet, setup is needed
    res.json({
      needsSetup: true,
      adminCount: 0,
      error: 'Database not initialized',
    });
  }
});

/**
 * POST /api/setup/create-admin
 * Creates the initial admin account. Only works when no admin exists.
 *
 * Body: { username, password }
 * Validation:
 *   - username: 3-100 chars, alphanumeric + underscore + hyphen
 *   - password: minimum 8 chars
 */
router.post('/create-admin', async (req, res) => {
  const { username, password } = req.body;

  // Validate input
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required. Provide both fields in the request body.' });
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 100) {
    return res.status(400).json({ error: 'Username must be 3-100 characters. Choose a shorter or longer username.' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens. Remove any special characters.' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters. Choose a longer password.' });
  }

  try {
    // CRITICAL SECURITY CHECK: verify no admin exists
    const checkResult = await pool.query('SELECT COUNT(*) as count FROM admins');
    const count = parseInt(checkResult.rows[0].count);

    if (count > 0) {
      // An admin already exists — this endpoint is permanently disabled
      return res.status(403).json({
        error: 'Initial setup has already been completed. This endpoint is disabled. Log in with an existing admin account and use /api/admins to create new admins.',
      });
    }

    // Create the admin account
    // bcrypt cost 12 — matches the cost the old /api/auth/register route used
    // before it was deleted in favor of this single admin-creation endpoint.
    // Phase 16: the first admin is granted 'super-admin' so they can manage
    // other admins. Subsequent admins are created via /api/admins with a
    // chosen role.
    const hash = bcrypt.hashSync(password, 12);
    const adminId = crypto.randomUUID();

    await pool.query(
      'INSERT INTO admins (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
      [adminId, username, hash, 'super-admin']
    );

    // Log the setup event (no admin_id since this is the first admin)
    await pool.query(
      'INSERT INTO audit_log (id, device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), null, adminId, 'initial_setup', JSON.stringify({ username })]
    );

    logger.info('[setup] Initial admin created: %s', username);

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully',
      username,
    });
  } catch (err) {
    logger.error({ err }, '[setup] Failed to create admin');

    // Handle duplicate username
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists. Choose a different username.' });
    }

    res.status(500).json({ error: 'Failed to create admin account. Check server logs for details and try again.' });
  }
});

module.exports = router;
