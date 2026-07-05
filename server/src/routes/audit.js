const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const { device_id, limit = 100, offset = 0 } = req.query;
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
