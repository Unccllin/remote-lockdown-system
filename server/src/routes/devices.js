const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM devices ORDER BY enrolled_at DESC'
  );
  res.json(result.rows);
});

router.get('/:id', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(result.rows[0]);
});

router.post('/', requireAuth, async (req, res) => {
  const { hostname, owner_name } = req.body;
  if (!hostname || !owner_name) return res.status(400).json({ error: 'hostname and owner_name required' });

  try {
    const result = await pool.query(
      'INSERT INTO devices (hostname, owner_name) VALUES ($1, $2) RETURNING *',
      [hostname, owner_name]
    );
    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [result.rows[0].id, req.admin.id, 'device_enrolled', { hostname, owner_name }]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Hostname already registered' });
    throw err;
  }
});

router.patch('/:id', requireAuth, async (req, res) => {
  const { owner_name } = req.body;
  const result = await pool.query(
    'UPDATE devices SET owner_name = COALESCE($1, owner_name) WHERE id = $2 RETURNING *',
    [owner_name, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(result.rows[0]);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const result = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json({ deleted: result.rows[0].id });
});

router.post('/:id/flag-stolen', requireAuth, async (req, res) => {
  const { hostname_confirm } = req.body;

  const devResult = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  const device = devResult.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match' });
  }
  if (device.status === 'stolen') {
    return res.status(409).json({ error: 'Device already flagged as stolen' });
  }

  await pool.query('UPDATE devices SET status = $1 WHERE id = $2', ['stolen', device.id]);
  const cmd = await pool.query(
    'INSERT INTO commands (device_id, command_type) VALUES ($1, $2) RETURNING *',
    [device.id, 'lockdown']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'flag_stolen', { command_id: cmd.rows[0].id }]
  );

  res.json({ device: { ...device, status: 'stolen' }, command: cmd.rows[0] });
});

router.post('/:id/recover', requireAuth, async (req, res) => {
  const { hostname_confirm } = req.body;

  const devResult = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  const device = devResult.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match' });
  }
  if (device.status !== 'stolen' && device.status !== 'locked') {
    return res.status(409).json({ error: 'Device is not in a locked/stolen state' });
  }

  // Set transitional 'recovering' status — the agent ACK for the unlock
  // command will flip this to 'active' once decryption is confirmed.
  await pool.query('UPDATE devices SET status = $1 WHERE id = $2', ['recovering', device.id]);

  const keyResult = await pool.query(
    'SELECT * FROM encryption_keys WHERE device_id = $1 AND released_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [device.id]
  );
  const key = keyResult.rows[0] || null;
  if (key) {
    await pool.query('UPDATE encryption_keys SET released_at = NOW() WHERE id = $1', [key.id]);
  }

  const cmd = await pool.query(
    'INSERT INTO commands (device_id, command_type) VALUES ($1, $2) RETURNING *',
    [device.id, 'unlock']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'recover_device', { command_id: cmd.rows[0].id }]
  );

  res.json({
    device: { ...device, status: 'recovering' },
    command: cmd.rows[0],
    key_released: !!key,
    key_material: key ? key.key_material : null,
  });
});

/**
 * Start covert tracking — sends a 'track' command to the agent.
 * The device remains fully usable; the agent silently reports geolocation.
 */
router.post('/:id/track', requireAuth, async (req, res) => {
  const devResult = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  const device = devResult.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.status === 'tracking') {
    return res.status(409).json({ error: 'Device is already being tracked' });
  }

  const cmd = await pool.query(
    'INSERT INTO commands (device_id, command_type) VALUES ($1, $2) RETURNING *',
    [device.id, 'track']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'start_tracking', { command_id: cmd.rows[0].id }]
  );

  res.json({ device, command: cmd.rows[0] });
});

/**
 * Stop covert tracking — sends a 'stop_track' command to the agent.
 */
router.post('/:id/stop-track', requireAuth, async (req, res) => {
  const devResult = await pool.query('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  const device = devResult.rows[0];
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.status !== 'tracking') {
    return res.status(409).json({ error: 'Device is not being tracked' });
  }

  const cmd = await pool.query(
    'INSERT INTO commands (device_id, command_type) VALUES ($1, $2) RETURNING *',
    [device.id, 'stop_track']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'stop_tracking', { command_id: cmd.rows[0].id }]
  );

  res.json({ device, command: cmd.rows[0] });
});

/**
 * Get location history for a device.
 */
router.get('/:id/locations', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const result = await pool.query(
    `SELECT * FROM location_reports
     WHERE device_id = $1
     ORDER BY reported_at DESC
     LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(result.rows);
});

/**
 * Get the latest known location for a device.
 */
router.get('/:id/location/latest', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM location_reports
     WHERE device_id = $1
     ORDER BY reported_at DESC
     LIMIT 1`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'No location data' });
  res.json(result.rows[0]);
});

module.exports = router;
