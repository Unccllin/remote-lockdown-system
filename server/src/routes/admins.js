/**
 * Admin management routes — Phase 16 RBAC.
 *
 * All routes require authentication + super-admin role.
 *
 *   GET    /            — list all admins
 *   POST   /            — create a new admin (username, password, role)
 *   DELETE /:id         — delete an admin (cannot delete self; cannot
 *                          delete the last super-admin)
 *   PATCH  /:id         — update an admin's role (cannot change own role;
 *                          cannot demote the last super-admin)
 *
 * Self-protection rules:
 *   - A super-admin cannot delete or demote themselves. This prevents an
 *     accidental lockout where no super-admin remains.
 *   - The last super-admin cannot be deleted or demoted.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireRole, ROLE_HIERARCHY } = require('../middleware/auth');

const router = express.Router();

const VALID_ROLES = Object.keys(ROLE_HIERARCHY); // ['viewer', 'operator', 'super-admin']

/**
 * Count how many super-admins currently exist.
 * @returns {Promise<number>}
 */
async function countSuperAdmins() {
  const result = await pool.query(
    "SELECT COUNT(*) as count FROM admins WHERE role = 'super-admin'"
  );
  return parseInt(result.rows[0].count, 10);
}

// All admin-management routes require auth + super-admin role.
router.use(requireAuth, requireRole('super-admin'));

// ---------------------------------------------------------------------------
// GET / — list all admins
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const result = await pool.query(
    'SELECT id, username, role, created_at FROM admins ORDER BY created_at ASC'
  );
  res.json(result.rows);
});

// ---------------------------------------------------------------------------
// POST / — create a new admin
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { username, password, role } = req.body;

  // Validate input
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 100) {
    return res.status(400).json({ error: 'Username must be 3-100 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    const hash = bcrypt.hashSync(password, 12);
    const adminId = crypto.randomUUID();

    const result = await pool.query(
      'INSERT INTO admins (id, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role, created_at',
      [adminId, username, hash, role]
    );

    // Audit log
    await pool.query(
      'INSERT INTO audit_log (id, device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4, $5)',
      [
        crypto.randomUUID(),
        null,
        req.admin.id,
        'admin_created',
        JSON.stringify({ username, role }),
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Duplicate username
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete an admin
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  // Cannot delete self
  if (req.admin.id === id) {
    return res.status(403).json({ error: 'Cannot delete your own account' });
  }

  // Fetch the admin to be deleted
  const targetResult = await pool.query('SELECT * FROM admins WHERE id = $1', [id]);
  const target = targetResult.rows[0];
  if (!target) {
    return res.status(404).json({ error: 'Admin not found' });
  }

  // Cannot delete the last super-admin
  if (target.role === 'super-admin') {
    const superCount = await countSuperAdmins();
    if (superCount <= 1) {
      return res.status(403).json({ error: 'Cannot delete the last super-admin' });
    }
  }

  await pool.query('DELETE FROM admins WHERE id = $1', [id]);

  // Audit log
  await pool.query(
    'INSERT INTO audit_log (id, device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4, $5)',
    [
      crypto.randomUUID(),
      null,
      req.admin.id,
      'admin_deleted',
      JSON.stringify({ username: target.username, role: target.role }),
    ]
  );

  res.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// PATCH /:id — update an admin's role
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'role is required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  // Cannot change own role (prevents self-demotion lockout)
  if (req.admin.id === id) {
    return res.status(403).json({ error: 'Cannot change your own role' });
  }

  // Fetch the target admin
  const targetResult = await pool.query('SELECT * FROM admins WHERE id = $1', [id]);
  const target = targetResult.rows[0];
  if (!target) {
    return res.status(404).json({ error: 'Admin not found' });
  }

  // Cannot demote the last super-admin
  if (target.role === 'super-admin' && role !== 'super-admin') {
    const superCount = await countSuperAdmins();
    if (superCount <= 1) {
      return res.status(403).json({ error: 'Cannot demote the last super-admin' });
    }
  }

  const result = await pool.query(
    'UPDATE admins SET role = $1 WHERE id = $2 RETURNING id, username, role, created_at',
    [role, id]
  );

  // Audit log
  await pool.query(
    'INSERT INTO audit_log (id, device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4, $5)',
    [
      crypto.randomUUID(),
      null,
      req.admin.id,
      'admin_role_changed',
      JSON.stringify({ username: target.username, from: target.role, to: role }),
    ]
  );

  res.json(result.rows[0]);
});

module.exports = router;
