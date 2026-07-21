const express = require('express');
const pool = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { encryptField, readDualMode } = require('../db/fieldCrypto');
const { hashApiKey, verifyApiKey, verifySharedKey } = require('../db/apiKey');
const { hmacVerify } = require('../middleware/hmacAuth');

const router = express.Router();

/**
 * FA3 / CC5 / CC6: Per-device API key authentication.
 *
 * The agent sends its key in the x-agent-key header. The server:
 *   1. Hashes the provided key and looks up the device by api_key_hash.
 *   2. If found → authenticated (per-device key). The device row is attached
 *      to req.device for downstream use.
 *   3. If not found → CC5 legacy fallback: try AGENT_SHARED_KEY against
 *      devices that have api_key_hash IS NULL. The device is identified
 *      by hostname/mac/uuid from the request body (the old findDevice flow).
 *      This fallback is PER-DEVICE: once a device has an api_key_hash,
 *      the shared key stops working for it.
 *   4. If neither works → 401.
 *
 * CC6: No mandatory x-device-id header. Device identification is via
 * hash lookup (per-device key) or body fields (legacy fallback).
 */
async function agentAuth(req, res, next) {
  const key = req.headers['x-agent-key'];
  if (!key) {
    return res.status(401).json({ error: 'Missing x-agent-key header' });
  }

  // Step 1: Try per-device key authentication (hash lookup)
  const providedHash = hashApiKey(key);
  try {
    const result = await pool.query(
      'SELECT * FROM devices WHERE api_key_hash = $1 LIMIT 1',
      [providedHash]
    );
    if (result.rows[0]) {
      // Per-device key verified — attach device to request
      req.device = result.rows[0];
      req.authMethod = 'per_device_key';
      // Phase 0: capture plaintext key for HMAC verification (downstream middleware)
      req.deviceKey = key;
      return next();
    }
  } catch (err) {
    // DB error during hash lookup — fall through to legacy
  }

  // Step 2: CC5 legacy fallback — try AGENT_SHARED_KEY
  // Only for devices that don't have an api_key_hash (per-device fallback)
  const sharedKey = process.env.AGENT_SHARED_KEY;
  if (sharedKey && verifySharedKey(key, sharedKey)) {
    // The shared key matches — but we need to verify this device is
    // eligible for legacy fallback (api_key_hash IS NULL).
    // We identify the device from the request body.
    const { hostname, mac_address, hardware_uuid } = req.body || {};
    let device = null;
    if (mac_address || hardware_uuid) {
      const r = await pool.query(
        `SELECT * FROM devices
         WHERE (mac_address = $1 AND $1 IS NOT NULL)
            OR (hardware_uuid = $2 AND $2 IS NOT NULL)
         LIMIT 1`,
        [mac_address || null, hardware_uuid || null]
      );
      device = r.rows[0];
    }
    if (!device && hostname) {
      const r = await pool.query('SELECT * FROM devices WHERE hostname = $1', [hostname]);
      device = r.rows[0];
    }
    if (device && !device.api_key_hash) {
      // CC5: Legacy fallback succeeds only for devices without per-device key
      req.device = device;
      req.authMethod = 'legacy_shared_key';
      return next();
    }
    // Device has api_key_hash → shared key no longer works for it (CC5)
  }

  return res.status(401).json({ error: 'Unauthorized' });
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

router.post('/checkin', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, mac_address, hardware_uuid } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname required' });

  // FA3: If authenticated via per-device key, req.device is already set.
  // For legacy shared-key auth, find the device from body fields.
  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
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
      // CC16: Dual-mode read — decrypt if encrypted, fall back to plaintext
      keyMaterial = readDualMode(
        keyResult.rows[0],
        'key_material',
        'key_material_encrypted',
        'key_enc_nonce',
        'key_enc_tag'
      );
    }
  }

  // Fetch BIOS password for unlock — the agent needs it to revert UEFI lockdown
  let biosPassword = null;
  if (command && command.command_type === 'unlock') {
    const pwResult = await pool.query(
      `SELECT * FROM bios_passwords WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [device.id]
    );
    if (pwResult.rows[0]) {
      // CC16: Dual-mode read for bios_password
      biosPassword = readDualMode(
        pwResult.rows[0],
        'password',
        'password_encrypted',
        'pw_enc_nonce',
        'pw_enc_tag'
      );
    }
  }

  res.json({
    device_id: device.id,
    status: device.status,
    command: command
      ? { id: command.id, type: command.command_type, key_material: keyMaterial, bios_password: biosPassword }
      : null,
  });
});

// A2/A4: command-ack wrapped in transaction with idempotent key insert
router.post('/command-ack', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, command_id, result_status, key_material, bios_password, mac_address, hardware_uuid, boot_lock_status } = req.body;
  if (!hostname || !command_id || !result_status) {
    return res.status(400).json({ error: 'hostname, command_id, result_status required' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  try {
    await withTransaction(async (client) => {
      // A4: Update command status (idempotent — if already executed, no-op)
      await client.query(
        `UPDATE commands SET status = $1, executed_at = NOW()
         WHERE id = $2 AND device_id = $3`,
        [result_status, command_id, device.id]
      );

      // A3/A4: Insert encryption key with ON CONFLICT DO NOTHING (idempotent)
      if (key_material) {
        const enc = encryptField(key_material);
        await client.query(
          `INSERT INTO encryption_keys (device_id, command_id, key_material, key_material_encrypted, key_enc_nonce, key_enc_tag)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING`,
          [device.id, command_id, key_material, enc.ciphertext, enc.nonce, enc.tag]
        );
      }

      // A3: Insert BIOS password (encrypted at rest)
      if (bios_password) {
        const enc = encryptField(bios_password);
        await client.query(
          `INSERT INTO bios_passwords (device_id, password, password_encrypted, pw_enc_nonce, pw_enc_tag)
           VALUES ($1, $2, $3, $4, $5)`,
          [device.id, bios_password, enc.ciphertext, enc.nonce, enc.tag]
        );
      }

      if (result_status === 'executed') {
        const cmdResult = await client.query('SELECT command_type FROM commands WHERE id = $1', [command_id]);
        const cmdType = cmdResult.rows[0]?.command_type;
        await client.query(
          'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
          [device.id, `agent_${cmdType}_confirmed`, { command_id, boot_lock_status }]
        );

        if (cmdType === 'lockdown') {
          await client.query("UPDATE devices SET status = 'locked' WHERE id = $1", [device.id]);
        } else if (cmdType === 'unlock') {
          await client.query("UPDATE devices SET status = 'active' WHERE id = $1", [device.id]);
        } else if (cmdType === 'track') {
          await client.query("UPDATE devices SET status = 'tracking' WHERE id = $1", [device.id]);
        } else if (cmdType === 'stop_track') {
          await client.query("UPDATE devices SET status = 'active' WHERE id = $1", [device.id]);
        }
      }
    });

    res.json({ ok: true });
  } catch (err) {
    // A4: Idempotent retry — if the conflict is from a duplicate insert, treat as success
    if (err.code === '23505') {
      return res.json({ ok: true, deduplicated: true });
    }
    throw err;
  }
});

// A2: deadman-report wrapped in transaction
router.post('/deadman-report', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, mac_address, hardware_uuid, key_material } = req.body;
  if (!hostname || !key_material) {
    return res.status(400).json({ error: 'hostname and key_material required' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  try {
    await withTransaction(async (client) => {
      // A3: Encrypt key_material at rest
      const enc = encryptField(key_material);

      // A4: Use synthetic command_id "deadman" for dedup — if the agent
      // retries the deadman report, ON CONFLICT DO NOTHING prevents duplicates
      await client.query(
        `INSERT INTO encryption_keys (device_id, command_id, key_material, key_material_encrypted, key_enc_nonce, key_enc_tag)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING`,
        [device.id, 'deadman', key_material, enc.ciphertext, enc.nonce, enc.tag]
      );

      // Mark device as locked (not just stolen — the deadman actually encrypted it)
      await client.query("UPDATE devices SET status = 'locked' WHERE id = $1", [device.id]);

      await client.query(
        'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
        [device.id, 'agent_deadman_lockdown_confirmed', { source: 'deadman_switch' }]
      );
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.json({ ok: true, deduplicated: true });
    }
    throw err;
  }
});

/**
 * Location report — the agent calls this periodically when in tracking mode.
 * Stores the geolocation data for map display and history.
 *
 * FA5: Sensitive location fields (latitude, longitude, city, region, ip_address)
 * are encrypted at rest using LOCATION_FIELD_KEY (AES-256-GCM).
 * raw_data is no longer stored — the write path uses an explicit allowlist
 * of fields rather than storing the entire location object. This prevents
 * accidental storage of future fields that may contain PII.
 */
router.post('/location', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, mac_address, hardware_uuid, location } = req.body;
  if (!hostname || !location) {
    return res.status(400).json({ error: 'hostname and location required' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  const {
    latitude, longitude, accuracy_meters, source,
    city, region, country, ip, wifi_count,
  } = location;

  // FA5: Encrypt sensitive location fields at rest
  const latEnc = latitude != null ? encryptField(String(latitude), 'LOCATION_FIELD_KEY') : {};
  const lonEnc = longitude != null ? encryptField(String(longitude), 'LOCATION_FIELD_KEY') : {};
  const cityEnc = city ? encryptField(city, 'LOCATION_FIELD_KEY') : {};
  const regionEnc = region ? encryptField(region, 'LOCATION_FIELD_KEY') : {};
  const ipEnc = ip ? encryptField(ip, 'LOCATION_FIELD_KEY') : {};

  await pool.query(
    `INSERT INTO location_reports
       (device_id, latitude, longitude, accuracy_meters, source,
        city, region, country, ip_address, wifi_count,
        latitude_enc, lat_enc_nonce, lat_enc_tag,
        longitude_enc, lon_enc_nonce, lon_enc_tag,
        city_enc, city_enc_nonce, city_enc_tag,
        region_enc, region_enc_nonce, region_enc_tag,
        ip_address_enc, ip_enc_nonce, ip_enc_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
    [
      device.id, latitude, longitude, accuracy_meters || null,
      source || 'ip', city || null, region || null, country || null,
      ip || null, wifi_count || null,
      // Encrypted columns
      latEnc.ciphertext || null, latEnc.nonce || null, latEnc.tag || null,
      lonEnc.ciphertext || null, lonEnc.nonce || null, lonEnc.tag || null,
      cityEnc.ciphertext || null, cityEnc.nonce || null, cityEnc.tag || null,
      regionEnc.ciphertext || null, regionEnc.nonce || null, regionEnc.tag || null,
      ipEnc.ciphertext || null, ipEnc.nonce || null, ipEnc.tag || null,
    ]
  );

  res.json({ ok: true });
});

module.exports = router;
