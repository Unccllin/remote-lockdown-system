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
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
  const admin = result.rows[0];
  if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: admin.id, username: admin.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
  res.json({ token, admin: { id: admin.id, username: admin.username } });
});

module.exports = router;
