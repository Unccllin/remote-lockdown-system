const express = require('express');
const pool = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { encryptField, readDualMode } = require('../db/fieldCrypto');
const { hashApiKey, verifySharedKey } = require('../db/apiKey');
const { hmacVerify } = require('../middleware/hmacAuth');
const { getAgentBinariesDir } = require('../config/paths');
const { sendNotification } = require('../notifications/notify');
const { getDeviceByApiKeyHash, getDeviceByHostname, getDeviceByHardwareIdentity } = require('../db/deviceQueries');
const logger = require('../logger');

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
    const device = await getDeviceByApiKeyHash(providedHash);
    if (device) {
      // Per-device key verified — attach device to request
      req.device = device;
      req.authMethod = 'per_device_key';
      // Phase 0: capture plaintext key for HMAC verification (downstream middleware)
      req.deviceKey = key;
      return next();
    }
  } catch (err) {
    logger.error({ err }, 'agentAuth: DB error during hash lookup, falling through to legacy');
  }

  // Step 2: CC5 legacy fallback — try AGENT_SHARED_KEY
  // Only for devices that don't have an api_key_hash (per-device fallback)
  const sharedKey = process.env.AGENT_SHARED_KEY;
  if (sharedKey && verifySharedKey(key, sharedKey)) {
    // The shared key matches — but we need to verify this device is
    // eligible for legacy fallback (api_key_hash IS NULL).
    // We identify the device from the request body.
    const { hostname, mac_address, hardware_uuid } = req.body || {};
    const device = await getDeviceByHardwareIdentity(hostname, mac_address, hardware_uuid);
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
  if (mac_address || hardware_uuid) {
    // Try hardware identity first (mac/uuid, then hostname fallback)
    return getDeviceByHardwareIdentity(hostname, mac_address, hardware_uuid);
  }
  // No hardware identity — just use hostname
  return getDeviceByHostname(hostname);
}

/**
 * Update device check-in timestamp and populate hardware identity if missing.
 */
async function updateDeviceCheckin(deviceId, hostname, macAddress, hardwareUuid) {
  await pool.query(
    `UPDATE devices
       SET last_checkin   = NOW(),
           hostname       = $1,
           mac_address    = COALESCE($2, mac_address),
           hardware_uuid  = COALESCE($3, hardware_uuid)
     WHERE id = $4`,
    [hostname, macAddress || null, hardwareUuid || null, deviceId]
  );
}

/**
 * Expire stale pending commands older than COMMAND_EXPIRY_DAYS.
 * Lightweight cleanup — runs on each checkin but only affects the current device.
 */
async function expireStaleCommands(deviceId) {
  const COMMAND_EXPIRY_DAYS = parseInt(process.env.COMMAND_EXPIRY_DAYS || '30', 10);
  await pool.query(
    `UPDATE commands SET status = 'expired', executed_at = NOW()
     WHERE device_id = $1 AND status = 'pending'
       AND created_at < NOW() - ($2 || ' days')::interval`,
    [deviceId, COMMAND_EXPIRY_DAYS]
  );
}

/**
 * Fetch the next pending command for a device (oldest first).
 * Uses the (device_id, status) index for efficiency.
 */
async function fetchPendingCommand(deviceId) {
  const cmdResult = await pool.query(
    `SELECT * FROM commands WHERE device_id = $1 AND status = 'pending' ORDER BY created_at ASC LIMIT 1`,
    [deviceId]
  );
  return cmdResult.rows[0] || null;
}

/**
 * Fetch encryption key and BIOS password for an unlock command.
 * Uses CC16 dual-mode reads (decrypt if encrypted, fall back to plaintext).
 * @returns {{ keyMaterial: string|null, biosPassword: string|null }}
 */
async function fetchUnlockMaterials(deviceId) {
  let keyMaterial = null;
  const keyResult = await pool.query(
    `SELECT * FROM encryption_keys WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [deviceId]
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

  // Fetch BIOS password for unlock — the agent needs it to revert UEFI lockdown
  let biosPassword = null;
  const pwResult = await pool.query(
    `SELECT * FROM bios_passwords WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [deviceId]
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

  return { keyMaterial, biosPassword };
}

/**
 * Calculate the adaptive poll interval for a device based on its status.
 * Values are configurable via ADAPTIVE_POLL_*_SEC env vars (defaults shown).
 */
function calculatePollInterval(deviceStatus) {
  const ADAPTIVE_POLL = {
    stolen: parseInt(process.env.ADAPTIVE_POLL_STOLEN_SEC || '30', 10),
    tracking: parseInt(process.env.ADAPTIVE_POLL_TRACKING_SEC || '30', 10),
    recovering: parseInt(process.env.ADAPTIVE_POLL_RECOVERING_SEC || '30', 10),
    locked: parseInt(process.env.ADAPTIVE_POLL_LOCKED_SEC || '60', 10),
    active: parseInt(process.env.ADAPTIVE_POLL_ACTIVE_SEC || '300', 10),
  };
  return ADAPTIVE_POLL[deviceStatus] || 300;
}

router.post('/checkin', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, mac_address, hardware_uuid } = req.body;
  if (!hostname) return res.status(400).json({ error: 'hostname required' });

  // FA3: If authenticated via per-device key, req.device is already set.
  // For legacy shared-key auth, find the device from body fields.
  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  // --- Update phase: record check-in and populate hardware identity if missing ---
  await updateDeviceCheckin(device.id, hostname, mac_address, hardware_uuid);

  // Phase 5: Expire stale pending commands (older than COMMAND_EXPIRY_DAYS).
  await expireStaleCommands(device.id);

  // Phase 5: Fetch the next pending command (if any).
  const command = await fetchPendingCommand(device.id);

  let keyMaterial = null;
  let biosPassword = null;
  if (command && command.command_type === 'unlock') {
    const materials = await fetchUnlockMaterials(device.id);
    keyMaterial = materials.keyMaterial;
    biosPassword = materials.biosPassword;
  }

  // Phase 5: Adaptive polling — tell the agent how often to check in.
  // The agent uses this value if present, falling back to its config
  // default (poll_interval from config file or env var).
  const serverPollInterval = calculatePollInterval(device.status);

  res.json({
    device_id: device.id,
    status: device.status,
    poll_interval: serverPollInterval,
    command: command
      ? {
          id: command.id,
          type: command.command_type,
          command_uuid: command.command_uuid || null,
          key_material: keyMaterial,
          bios_password: biosPassword,
        }
      : null,
  });
});

// A2/A4: command-ack wrapped in transaction with idempotent key insert
// Phase 5: supports command_uuid for client-side idempotency, and
// expanded status values: 'executed', 'failed', 'not_now'.
router.post('/command-ack', agentAuth, hmacVerify(), async (req, res) => {
  const {
    hostname, command_id, result_status, key_material, bios_password,
    mac_address, hardware_uuid, boot_lock_status, command_uuid,
    boot_lock_detail, encryption_blocked_files, lock_session_context,
  } = req.body;
  if (!hostname || !command_id || !result_status) {
    return res.status(400).json({ error: 'hostname, command_id, result_status required' });
  }

  // Phase 5: Validate result_status — only allow known values
  const VALID_STATUSES = ['executed', 'failed', 'not_now'];
  if (!VALID_STATUSES.includes(result_status)) {
    return res.status(400).json({
      error: `Invalid result_status: ${result_status}. Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered' });

  // Phase 5: If command_uuid is provided, check for duplicate ACK.
  // This allows the agent to retry safely — if we've already seen this
  // UUID, return success without re-processing.
  if (command_uuid) {
    const dupResult = await pool.query(
      'SELECT id FROM commands WHERE command_uuid = $1 AND status != $2',
      [command_uuid, 'pending']
    );
    if (dupResult.rows[0]) {
      // Already processed — idempotent success
      return res.json({ ok: true, deduplicated: true });
    }
  }

  try {
    await withTransaction(async (client) => {
      // A4: Update command status (idempotent — if already executed, no-op)
      // Phase 5: Also store command_uuid if provided
      if (command_uuid) {
        await client.query(
          `UPDATE commands SET status = $1, executed_at = NOW(), command_uuid = $2
           WHERE id = $3 AND device_id = $4`,
          [result_status, command_uuid, command_id, device.id]
        );
      } else {
        await client.query(
          `UPDATE commands SET status = $1, executed_at = NOW()
           WHERE id = $2 AND device_id = $3`,
          [result_status, command_id, device.id]
        );
      }

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

        // Phase 17: Compute lockdown_effective for lockdown commands.
        // This flags the dangerous case where the agent ACKed "executed" but
        // boot lockdown silently no-op'd (critical_applied=0 with partial status).
        // Without this, the dashboard shows "locked" while the machine boots
        // normally from USB — the encryption key is the only remaining barrier.
        //
        // Semantics:
        //   - null: not a lockdown command, or boot lock was not attempted
        //     (boot_lock_enabled=false in agent config) — not applicable
        //   - true: boot lockdown was attempted AND at least one critical
        //     setting was applied across BCD + HP UEFI layers
        //   - false: boot lockdown was attempted BUT zero critical settings
        //     were applied — the device is encrypted-only, not boot-locked
        let lockdownEffective = null;
        if (cmdType === 'lockdown' && boot_lock_detail) {
          const attempted = boot_lock_detail.boot_lock_attempted === true;
          const critTotal = boot_lock_detail.critical_applied_total || 0;
          if (attempted) {
            lockdownEffective = critTotal > 0;
          }
        }

        await client.query(
          'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
          [device.id, `agent_${cmdType}_confirmed`, {
            command_id, command_uuid, boot_lock_status,
            boot_lock_detail: boot_lock_detail || undefined,
            lockdown_effective: lockdownEffective,
            encryption_blocked_files: encryption_blocked_files || undefined,
            lock_session_context: lock_session_context || undefined,
          }]
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
      } else if (result_status === 'failed') {
        // Phase 5: Log failures for audit trail
        await client.query(
          'INSERT INTO audit_log (device_id, action, detail) VALUES ($1, $2, $3)',
          [device.id, 'agent_command_failed', { command_id, command_uuid, boot_lock_status }]
        );
      }
      // 'not_now' — the agent couldn't execute (e.g., user is working).
      // The command stays in 'not_now' status. The server can re-queue it
      // or the admin can cancel it. No device status change.
    });

    // Fire-and-forget notifications for critical command confirmations.
    // These are the events an admin needs to know about in real-time:
    //   - lockdown confirmed → device is now encrypted and locked down
    //   - unlock confirmed   → device has been successfully recovered
    if (result_status === 'executed') {
      const cmdTypeRow = await pool.query('SELECT command_type FROM commands WHERE id = $1', [command_id]);
      const cmdType = cmdTypeRow.rows[0]?.command_type;
      if (cmdType === 'lockdown') {
        // Phase 17: Include lockdown_effective + boot_lock_detail in the
        // notification so notification channels (email/Slack) can flag
        // ineffective lockdowns, not just the dashboard.
        let lockdownEffective = null;
        if (boot_lock_detail) {
          const attempted = boot_lock_detail.boot_lock_attempted === true;
          const critTotal = boot_lock_detail.critical_applied_total || 0;
          if (attempted) {
            lockdownEffective = critTotal > 0;
          }
        }
        sendNotification('agent_lockdown_confirmed', {
          deviceId: device.id, hostname: device.hostname,
          commandId: command_id, bootLockStatus: boot_lock_status,
          lockdownEffective, bootLockDetail: boot_lock_detail || undefined,
        });
      } else if (cmdType === 'unlock') {
        sendNotification('agent_unlock_confirmed', {
          deviceId: device.id, hostname: device.hostname,
          commandId: command_id,
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    // A4: Idempotent retry — if the conflict is from a duplicate insert, treat as success
    // Phase 5: Also handle command_uuid unique constraint violation
    if (err.code === '23505' || (command_uuid && err.message?.includes('command_uuid'))) {
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

    // Fire-and-forget notification — the deadman switch fired, meaning the
    // agent hasn't been able to reach the server for the configured grace
    // period. The device has self-locked as a failsafe.
    sendNotification('agent_deadman_lockdown_confirmed', {
      deviceId: device.id, hostname: device.hostname,
      source: 'deadman_switch',
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

/**
 * Phase 4: Agent auto-update check.
 *
 * The agent calls this endpoint on each checkin (or periodically) to see
 * if a newer version of itself is available. If so, it downloads the
 * new binary from /api/agent/download, verifies the SHA-256, and signals
 * the watchdog to perform a hot-swap restart.
 *
 * Auth: agentAuth (per-device key or legacy shared key).
 * HMAC: optional (transition period — unsigned requests get a warning).
 *
 * Request body: { hostname, agent_version, platform }
 * Response: { update_available: bool, latest_version, sha256, download_url, size }
 */
router.get('/update', agentAuth, async (req, res) => {
  const agentVersion = req.headers['x-agent-version'] || req.query.version || '0.0.0';
  const agentPlatform = req.headers['x-agent-platform'] || req.query.platform || 'linux';

  // Find the bundled agent binary
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  // Use the shared path resolver from config/paths.js
  const binariesDir = getAgentBinariesDir();

  const ext = agentPlatform === 'win' ? '.exe' : '';
  const agentBinName = `lockdown-agent${ext}`;

  let binPath = null;
  if (binariesDir) {
    const p = path.join(binariesDir, agentBinName);
    if (fs.existsSync(p)) {
      binPath = p;
    }
  }

  if (!binPath) {
    // No binary available — report no update
    return res.json({
      update_available: false,
      latest_version: agentVersion,
      reason: 'no_binary_available',
    });
  }

  const stat = fs.statSync(binPath);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(binPath));
  const sha256 = hash.digest('hex');

  const LATEST_VERSION = '1.0.0';
  const updateAvailable = compareVersions(agentVersion, LATEST_VERSION) < 0;

  // Build download URL — the agent will use its server_url + this path
  const downloadPath = `/api/agent/download?platform=${agentPlatform}`;

  res.json({
    update_available: updateAvailable,
    latest_version: LATEST_VERSION,
    current_version: agentVersion,
    sha256,
    size: stat.size,
    download_url: downloadPath,
    built_at: stat.mtime.toISOString(),
  });
});

/**
 * Phase 4: Agent binary download endpoint.
 *
 * Serves the pre-built agent binary for auto-update. The agent verifies
 * the SHA-256 hash (from /update) before applying the update.
 *
 * Auth: agentAuth (per-device key or legacy shared key).
 */
router.get('/download', agentAuth, async (req, res) => {
  const agentPlatform = req.query.platform || 'linux';

  const fs = require('fs');
  const path = require('path');

  // Use the shared path resolver from config/paths.js
  const binariesDir = getAgentBinariesDir();

  const ext = agentPlatform === 'win' ? '.exe' : '';
  const agentBinName = `lockdown-agent${ext}`;

  let binPath = null;
  if (binariesDir) {
    const p = path.join(binariesDir, agentBinName);
    if (fs.existsSync(p)) {
      binPath = p;
    }
  }

  if (!binPath) {
    return res.status(404).json({ error: 'Agent binary not available' });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${agentBinName}"`);
  res.sendFile(path.resolve(binPath));
});

/**
 * Compare two version strings (semver-ish: "1.2.3").
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

module.exports = router;
