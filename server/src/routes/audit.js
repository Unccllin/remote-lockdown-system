const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { device_id } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  if (device_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device_id)) {
    return res.status(400).json({ error: 'Invalid device_id format' });
  }

  let query = `
    SELECT 
      al.*,
      d.hostname,
      a.username AS admin_username
    FROM audit_log al
    LEFT JOIN devices d ON al.device_id = d.id
    LEFT JOIN admins a ON al.admin_id = a.id
  `;
  const params = [];
  if (device_id) {
    query += ' WHERE al.device_id = $1';
    params.push(device_id);
    query += ` ORDER BY al.timestamp DESC LIMIT $2 OFFSET $3`;
    params.push(limit, offset);
  } else {
    query += ` ORDER BY al.timestamp DESC LIMIT $1 OFFSET $2`;
    params.push(limit, offset);
  }

  const result = await pool.query(query, params);
  res.json(result.rows);
});

module.exports = router;
