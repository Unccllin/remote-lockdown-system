const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

function agentAuth(req, res, next) {
  const key = req.headers['x-agent-key'];
  if (!key || key !== process.env.AGENT_SHARED_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * Find a device by hardware identity (MAC + UUID) first, fall back to hostname.
 * Returns the device row or null.
 */
async function findDevice(hostname, mac_address, hardware_uuid) {
  let devResult;
  if (mac_address || hardware_uuid) {
    devResult = await pool.query(
      `SELECT * FROM devices
       WHERE (mac_address = $1 AND $1 IS NOT NULL)
          OR (hardware_uuid = $2 AND $2 IS NOT NULL)
       LIMIT 1`,
      [mac_address || null, hardware_uuid || null]
    );
  }
  if (!devResult || !devResult.rows[0]) {
    devResult = await pool.query('SELECT * FROM devices WHERE hostname = $1', [hostname]);
  }
  return devResult.rows[0] || null;
}

router.post('/checkin', agentAuth, async (req, res) => {
  const { hostname, mac_address, hardware_uuid } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname required' });

  const device = await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  // --- Update phase: record check-in and populate hardware identity if missing ---
  await pool.query(
    `UPDATE devices
       SET last_checkin   = NOW(),
           hostname       = $1,
           mac_address    = COALESCE($2, mac_address),
           hardware_uuid  = COALESCE($3, hardware_uuid)
     WHERE id = $4`,
    [hostname, mac_address || null, hardware_uuid || null, device.id]
  );

  const cmdResult = await pool.query(
    `SELECT * FROM commands WHERE device_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    [device.id]
  );
  const command = cmdResult.rows[0] || null;

  let keyMaterial = null;
  if (command && command.command_type === 'unlock') {
    const keyResult = await pool.query(
      `SELECT * FROM encryption_keys WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [device.id]
    );
    if (keyResult.rows[0]) {
      keyMaterial = keyResult.rows[0].key_material;
    }
  }

  res.json({
    device_id: device.id,
    status: device.status,
    command: command
      ? { id: command.id, type: command.command_type, key_material: keyMaterial }
      : null,
  });
});

router.post('/command-ack', agentAuth, async (req, res) => {
  const { hostname, command_id, result_status, key_material, mac_address, hardware_uuid } = req.body;
  if (!hostname || !command_id || !result_status) {
    return res.status(400).json({ error: 'hostname, command_id, result_status required' });
  }

  const device = await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  await pool.query(
    `UPDATE commands SET status = $1, executed_at = NOW() WHERE id = $2 AND device_id = $3`,
    [result_status, command_id, device.id]
  );

  if (key_material) {
    await pool.query(
      'INSERT INTO encryption_keys (device_id, key_material) VALUES ($1, $2)',
      [device.id, key_material]
    );
  }

  if (result_status === 'executed') {
    const cmdResult = await pool.query('SELECT command_type FROM commands WHERE id = $1', [command_id]);
    const cmdType = cmdResult.rows[0]?.command_type;
    await pool.query(
      'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
      [device.id, `agent_${cmdType}_confirmed`, { command_id }]
    );

    if (cmdType === 'lockdown') {
      await pool.query("UPDATE devices SET status = 'locked' WHERE id = $1", [device.id]);
    } else if (cmdType === 'unlock') {
      await pool.query("UPDATE devices SET status = 'active' WHERE id = $1", [device.id]);
    }
  }

  res.json({ ok: true });
});

/**
 * Dead man's switch report — the agent calls this when it comes back online
 * after a deadman-triggered lockdown. It uploads the encryption key so the
 * admin can recover the device through the normal recover flow.
 */
router.post('/deadman-report', agentAuth, async (req, res) => {
  const { hostname, mac_address, hardware_uuid, key_material } = req.body;
  if (!hostname || !key_material) {
    return res.status(400).json({ error: 'hostname and key_material required' });
  }

  const device = await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  // Store the deadman key so it can be released during recovery
  await pool.query(
    'INSERT INTO encryption_keys (device_id, key_material) VALUES ($1, $2)',
    [device.id, key_material]
  );

  // Mark device as locked (not just stolen — the deadman actually encrypted it)
  await pool.query("UPDATE devices SET status = 'locked' WHERE id = $1", [device.id]);

  await pool.query(
    'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
    [device.id, 'agent_deadman_lockdown_confirmed', { source: 'deadman_switch' }]
  );

  res.json({ ok: true });
});

module.exports = router;
