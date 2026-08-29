const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();

// NOTE: Admin account creation lives at POST /api/setup/create-admin
// (see routes/setup.js). That endpoint enforces a "first-admin-only" guard
// (403 once any admin exists), input validation, and an audit_log entry.
// Do NOT re-add an open /register route here — it would reintroduce the
// unauthenticated-admin-creation vulnerability fixed in this patch.

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  // Input validation
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required. Provide both fields in the request body.' });
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password must be strings.' });
  }
  if (username.length < 1 || username.length > 100) {
    return res.status(400).json({ error: 'username must be 1-100 characters.' });
  }
  if (password.length < 1 || password.length > 1000) {
    return res.status(400).json({ error: 'password must be 1-1000 characters.' });
  }
  // Prevent username injection (SQL wildcard abuse, log injection)
  if (!/^[a-zA-Z0-9_@.\-]+$/.test(username)) {
    return res.status(400).json({ error: 'username contains invalid characters. Allowed: letters, numbers, _ @ . -' });
  }

  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid credentials. Check your username and password and try again.' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials. Check your username and password and try again.' });

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role || 'viewer' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({ token, admin: { id: admin.id, username: admin.username, role: admin.role || 'viewer' } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

module.exports = router;
