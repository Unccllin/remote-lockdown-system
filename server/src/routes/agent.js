const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { withTransaction } = require('../db/withTransaction');
const { encryptField, readDualMode } = require('../db/fieldCrypto');
const { groupPbaCredentials } = require('../db/pbaCredentials');
const { hashApiKey, verifySharedKey } = require('../db/apiKey');
const { hmacVerify } = require('../middleware/hmacAuth');
const { getAgentBinariesDir } = require('../config/paths');
const { sendNotification } = require('../notifications/notify');
const { getDeviceByApiKeyHash, getDeviceByHostname, getDeviceByHardwareIdentity } = require('../db/deviceQueries');
const { createSharedEnv } = require('../pbl/kvStore');
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
    return res.status(401).json({ error: 'Missing x-agent-key header. Include the device API key in the x-agent-key header.' });
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

  return res.status(401).json({ error: 'Unauthorized. The provided API key does not match any enrolled device. Verify the key is correct or re-enroll the device.' });
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
async function updateDeviceCheckin(
  deviceId, hostname, macAddress, hardwareUuid, firmwareAudit, updateVerification, agentVersion
) {
  await pool.query(
    `UPDATE devices
       SET last_checkin   = NOW(),
           hostname       = $1,
           mac_address    = COALESCE($2, mac_address),
           hardware_uuid  = COALESCE($3, hardware_uuid),
           firmware_audit = COALESCE($5, firmware_audit),
           firmware_audit_at = CASE WHEN $5 IS NOT NULL THEN NOW() ELSE firmware_audit_at END,
           update_verification = COALESCE($6, update_verification),
           agent_version = COALESCE($7, agent_version),
           agent_version_at = CASE WHEN $7 IS NOT NULL THEN NOW() ELSE agent_version_at END
     WHERE id = $4`,
    [hostname, macAddress || null, hardwareUuid || null, deviceId,
     firmwareAudit ? JSON.stringify(firmwareAudit) : null,
     updateVerification || null,
     agentVersion || null]
  );
}

/**
 * D-222: the agent version string, as reported at check-in.
 *
 * Bounded and charset-restricted because it is device-reported data that the dashboard
 * renders verbatim. Anything that does not look like a version stays **null**, so "this
 * device has never reported a version" remains distinguishable from "on version X" — a
 * rollout cannot be verified if a malformed string silently counts as compliance.
 */
function normalizeAgentVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(trimmed) ? trimmed : null;
}

/**
 * Accept only the two update-verification modes the agent can report.
 *
 * Absent or unrecognised stays NULL (unknown) rather than being coerced: the
 * dashboard distinguishes "this device has never said" from "this device accepts
 * unauthenticated updates".
 */
function normalizeUpdateVerification(value) {
  const modes = ['signature', 'sha256-only', 'key-unreadable'];
  return modes.includes(value) ? value : null;
}

/**
 * S1.2: Correlate an agent check-in with the freshest PBL boot recorded for
 * this device's linked PBL identity.
 *
 * The firmware records last_boot_id (TPM reset counter) + last_boot_at into
 * pbl_devices:{id} on every /v1/verdict fetch — i.e., every cold boot where
 * PBL ran. This reads that record and classifies the boot's freshness
 * relative to now.
 *
 * Returns null when the device has no PBL identity (pbl_device_id unset) —
 * correlation is not applicable, not an alarm. Otherwise:
 *   { enrolled, last_boot_id, last_boot_at, boot_fresh, boot_class }
 * boot_fresh=false is the absence-alarm signal: agent is alive and checking
 * in, but no recent PBL boot — either a bypass or an S3 resume.
 *
 * S1.4 disambiguation via the agent-reported TPM restartCount
 * (tpmRestartCount). PBL never runs on S3 resume (finding F6), so on a
 * resume restartCount bumps while resetCount (boot_id) does not:
 *   restartCount > last_boot_id → a wake happened without a cold boot →
 *     boot_class = 's3_resume' (downgrade the alarm — expected behaviour)
 *   restartCount <= last_boot_id → no wake since last cold boot; a stale
 *     last_boot_at is a genuine bypass → boot_class = 'pbl_bypass'
 *   tpmRestartCount absent/unknown → can't disambiguate → 'unknown'
 * boot_class is only meaningful when boot_fresh === false.
 *
 * Freshness window: PBL_BOOT_FRESH_SECONDS env (default 900s = 15min). A cold
 * boot → PBL verdict → first agent check-in should land well inside this on
 * any healthy device. Best-effort — returns a degrade note on KV error.
 */
async function correlatePblBoot(device, tpmRestartCount) {
  if (!device || !device.pbl_device_id) return null;

  const freshSec = parseInt(process.env.PBL_BOOT_FRESH_SECONDS || '900', 10);
  try {
    const env = createSharedEnv();
    const data = await env.LOCKDOWN_KV.get(`pbl_devices:${device.pbl_device_id}`, 'text');
    if (!data) {
      // Linked to a PBL id that has no KV record — treat as "no boot seen".
      return { enrolled: false, last_boot_id: null, last_boot_at: null, boot_fresh: false, boot_class: 'unknown' };
    }
    const pbl = JSON.parse(data);
    const lastBootAt = pbl.last_boot_at || null;
    const lastBootId = (pbl.last_boot_id === undefined) ? null : pbl.last_boot_id;

    let bootFresh = false;
    if (lastBootAt) {
      const ageSec = (Date.now() - new Date(lastBootAt).getTime()) / 1000;
      bootFresh = ageSec <= freshSec;
    }

    // S1.4: classify a stale/absent boot as resume vs bypass. Only worth
    // classifying when the boot is stale — a fresh boot is unambiguous.
    let bootClass = null;
    if (!bootFresh) {
      if (tpmRestartCount === null || tpmRestartCount === undefined) {
        bootClass = 'unknown';  // agent didn't/can't report restartCount
      } else if (lastBootId === null) {
        bootClass = 'unknown';  // no PBL boot baseline to compare against
      } else if (tpmRestartCount > lastBootId) {
        bootClass = 's3_resume';   // wake without a cold boot
      } else {
        bootClass = 'pbl_bypass';  // check-in but PBL never ran this boot
      }
    }

    return {
      enrolled: true,
      last_boot_id: lastBootId,
      last_boot_at: lastBootAt,
      boot_fresh: bootFresh,
      boot_class: bootClass,
    };
  } catch (err) {
    // KV unavailable / parse error — degrade, don't fail the check-in.
    return { enrolled: true, last_boot_id: null, last_boot_at: null, boot_fresh: false, boot_class: 'unknown', note: 'pbl_lookup_failed' };
  }
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

  // Fetch BIOS passwords for unlock — the agent needs the Setup Password to
  // revert UEFI lockdown, and the Power-On Password (if PBA was active) to
  // clear it during remove_boot_lockdown.
  // T8: Fetch all password types and pick the most recent of each.
  // T9: Also fetch bitlocker_pin and bitlocker_recovery for PBA recovery.
  let biosPassword = null;
  let powerOnPassword = null;
  let bitlockerPin = null;
  let bitlockerRecoveryPassword = null;
  const pwResult = await pool.query(
    `SELECT * FROM bios_passwords WHERE device_id = $1 ORDER BY created_at DESC`,
    [deviceId]
  );
  const pbaCreds = groupPbaCredentials(pwResult.rows);
  biosPassword = pbaCreds.setup_password;
  powerOnPassword = pbaCreds.power_on_password;
  bitlockerPin = pbaCreds.bitlocker_pin;
  bitlockerRecoveryPassword = pbaCreds.bitlocker_recovery_password;

  return { keyMaterial, biosPassword, powerOnPassword, bitlockerPin, bitlockerRecoveryPassword };
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
  // S1.4: agent-reported TPM restartCount (optional; absent on non-Windows
  // or no-TBS). Used to classify a stale PBL boot as S3-resume vs bypass.
  const tpmRestartCount = (typeof req.body.tpm_restart_count === 'number'
    && Number.isInteger(req.body.tpm_restart_count)
    && req.body.tpm_restart_count >= 0)
    ? req.body.tpm_restart_count : null;
  if (!hostname) return res.status(400).json({ error: 'hostname required. Include the hostname field in the request body.' });

  // FA3: If authenticated via per-device key, req.device is already set.
  // For legacy shared-key auth, find the device from body fields.
  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered. Enroll the device first via POST /api/devices, or verify the hostname and hardware identity fields match an enrolled device.' });

  // --- Update phase: record check-in and populate hardware identity if missing ---
  // firmware_audit: optional per-device SPI/Secure-Boot recon (PblPersistDxe
  // delivery posture). Validated to a plain object; stored verbatim as JSONB.
  const firmwareAudit = (req.body.firmware_audit
    && typeof req.body.firmware_audit === 'object'
    && !Array.isArray(req.body.firmware_audit))
    ? req.body.firmware_audit : null;
  // B-006: how this device verifies updates ("signature" | "sha256-only"), so the
  // dashboard can show which devices would accept an unauthenticated binary.
  const updateVerification = normalizeUpdateVerification(req.body.update_verification);
  // D-222: the agent has always sent this (and /api/agent/update reads it from a header),
  // but nothing stored it, so the fleet could not answer "which build is on that machine?".
  // Absent for pre-D-222 agents: COALESCE keeps any earlier value rather than resetting it.
  const agentVersion = normalizeAgentVersion(req.body.agent_version);
  await updateDeviceCheckin(
    device.id, hostname, mac_address, hardware_uuid, firmwareAudit, updateVerification, agentVersion
  );

  // Phase 5: Expire stale pending commands (older than COMMAND_EXPIRY_DAYS).
  await expireStaleCommands(device.id);

  // Phase 5: Fetch the next pending command (if any).
  const command = await fetchPendingCommand(device.id);

  let keyMaterial = null;
  let biosPassword = null;
  let powerOnPassword = null;
  let bitlockerPin = null;
  let bitlockerRecoveryPassword = null;
  if (command && command.command_type === 'unlock') {
    const materials = await fetchUnlockMaterials(device.id);
    keyMaterial = materials.keyMaterial;
    biosPassword = materials.biosPassword;
    powerOnPassword = materials.powerOnPassword;
    bitlockerPin = materials.bitlockerPin;
    bitlockerRecoveryPassword = materials.bitlockerRecoveryPassword;
  }

  // Phase 5: Adaptive polling — tell the agent how often to check in.
  // The agent uses this value if present, falling back to its config
  // default (poll_interval from config file or env var).
  const serverPollInterval = calculatePollInterval(device.status);

  // S1.2: Cross-layer absence correlation. If this agent device is linked to
  // a PBL identity (pbl_device_id set at enroll), read the PBL device's
  // last_boot_id / last_boot_at — recorded by /v1/verdict every time the
  // firmware fetched a verdict (i.e., every cold boot PBL ran). Compare
  // last_boot_at to this check-in: a running agent with a stale or absent
  // PBL boot means either (a) PBL was bypassed this boot, or (b) an S3
  // resume (no TPM reset → no new boot_id — disambiguated by S1.4's
  // restartCount). We flag, not block, per the DEGRADED-alarm ruling.
  const pblBoot = await correlatePblBoot(device, tpmRestartCount);

  res.json({
    device_id: device.id,
    status: device.status,
    poll_interval: serverPollInterval,
    // S1.2/S1.4: boot-ID correlation result. null = device has no PBL
    // identity. Otherwise { enrolled, last_boot_id, last_boot_at, boot_fresh,
    // boot_class } — boot_fresh=false is the absence signal; boot_class
    // disambiguates it ('s3_resume'|'pbl_bypass'|'unknown') via the
    // agent-reported restartCount.
    pbl_boot: pblBoot,
    // B-005: server-authoritative timestamp — the agent anchors its deadman
    // last_seen to this, so a local clock rollback becomes detectable.
    server_time: Math.floor(Date.now() / 1000),
    command: command
      ? {
          id: command.id,
          type: command.command_type,
          command_uuid: command.command_uuid || null,
          key_material: keyMaterial,
          bios_password: biosPassword,
          // T7/T8: PBA credentials and flag for the agent
          power_on_password: powerOnPassword,
          enable_pba: command.enable_pba || false,
          // T9: BitLocker PBA credentials for unlock (agent doesn't need these
          // to disable_pba — it uses the local state file — but the dashboard
          // needs them for the PBA Recovery panel in T10)
          bitlocker_pin: bitlockerPin,
          bitlocker_recovery_password: bitlockerRecoveryPassword,
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
    power_on_password, bitlocker_pin, bitlocker_recovery_password,
  } = req.body;
  if (!hostname || !command_id || !result_status) {
    return res.status(400).json({ error: 'hostname, command_id, result_status required. Include all three fields in the request body.' });
  }

  // Validate key_material is a string (not an object) — encryptField expects a string
  if (key_material != null && typeof key_material !== 'string') {
    return res.status(400).json({ error: 'key_material must be a string (base64-encoded key), not an object or array.' });
  }

  // Phase 5: Validate result_status — only allow known values
  const VALID_STATUSES = ['executed', 'failed', 'not_now'];
  if (!VALID_STATUSES.includes(result_status)) {
    return res.status(400).json({
      error: `Invalid result_status: ${result_status}. Must be one of: ${VALID_STATUSES.join(', ')}. Use one of the allowed values.`,
    });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered. Enroll the device first via POST /api/devices, or verify the hostname and hardware identity fields match an enrolled device.' });

  // 009: Look up command_type before the transaction so we can compute
  // lockdown_effective once and reuse it in the UPDATE, audit log, and
  // notification. Commands are immutable (only status changes), so reading
  // command_type outside the transaction is safe.
  const cmdTypeRow = await pool.query('SELECT command_type FROM commands WHERE id = $1 AND device_id = $2', [command_id, device.id]);
  const cmdType = cmdTypeRow.rows[0]?.command_type;

  // 009: Compute lockdown_effective — used in the UPDATE query, the audit
  // log, and the notification. This flags the dangerous case where the
  // agent ACKed "executed" but boot lockdown silently no-op'd
  // (critical_applied=0 with partial status).
  //
  // Semantics:
  //   - null: not a lockdown command, not executed, or boot lock was not
  //     attempted (not applicable)
  //   - true: boot lockdown was attempted AND at least one critical setting
  //     was applied across BCD + HP UEFI layers
  //   - false: boot lockdown was attempted BUT zero critical settings were
  //     applied — the device is encrypted-only, not boot-locked
  let lockdownEffective = null;
  if (result_status === 'executed' && cmdType === 'lockdown' && boot_lock_detail) {
    const attempted = boot_lock_detail.boot_lock_attempted === true;
    const critTotal = boot_lock_detail.critical_applied_total || 0;
    if (attempted) {
      lockdownEffective = critTotal > 0;
    }
  }

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
      // 009: Persist boot_lock_status, boot_lock_detail, lockdown_effective
      //   so enforcement path results are queryable from the DB, not just
      //   visible in server notification logs.
      //   lockdownEffective was computed above (before the transaction).

      if (command_uuid) {
        await client.query(
          `UPDATE commands SET status = $1, executed_at = NOW(), command_uuid = $2,
             boot_lock_status = $3, boot_lock_detail = $4, lockdown_effective = $5
           WHERE id = $6 AND device_id = $7`,
          [result_status, command_uuid, boot_lock_status || null,
           boot_lock_detail || null, lockdownEffective, command_id, device.id]
        );
      } else {
        await client.query(
          `UPDATE commands SET status = $1, executed_at = NOW(),
             boot_lock_status = $2, boot_lock_detail = $3, lockdown_effective = $4
           WHERE id = $5 AND device_id = $6`,
          [result_status, boot_lock_status || null,
           boot_lock_detail || null, lockdownEffective, command_id, device.id]
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

      // A3: Insert BIOS Setup password (encrypted at rest)
      // T8: Specify password_type='setup' explicitly (migration 008 adds the column)
      if (bios_password) {
        const enc = encryptField(bios_password);
        await client.query(
          `INSERT INTO bios_passwords (device_id, password, password_encrypted, pw_enc_nonce, pw_enc_tag, password_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [device.id, bios_password, enc.ciphertext, enc.nonce, enc.tag, 'setup']
        );
      }

      // T7/T8: Insert Power-On Password (encrypted at rest, password_type='power_on')
      // This is the HP Power-On Password set when enable_pba=True. The agent
      // needs it during unlock to clear the Power-On Password (Tier 1 PBA removal).
      if (power_on_password) {
        const encPw = encryptField(power_on_password);
        await client.query(
          `INSERT INTO bios_passwords (device_id, password, password_encrypted, pw_enc_nonce, pw_enc_tag, password_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [device.id, power_on_password, encPw.ciphertext, encPw.nonce, encPw.tag, 'power_on']
        );
      }

      // T9: Insert BitLocker TPM+PIN (encrypted at rest, password_type='bitlocker_pin')
      // This is the PIN the operator needs to enter at the pre-boot prompt on a
      // rebooted PBA device. The agent doesn't need it for disable_pba (it uses
      // the local state file), but the dashboard needs it for the PBA Recovery panel.
      if (bitlocker_pin) {
        const encPin = encryptField(bitlocker_pin);
        await client.query(
          `INSERT INTO bios_passwords (device_id, password, password_encrypted, pw_enc_nonce, pw_enc_tag, password_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [device.id, bitlocker_pin, encPin.ciphertext, encPin.nonce, encPin.tag, 'bitlocker_pin']
        );
      }

      // T9: Insert BitLocker recovery password (encrypted at rest, password_type='bitlocker_recovery')
      // This is the 48-digit numerical password that can unlock the drive if the
      // PIN is lost. The operator needs it for the PBA Recovery runbook.
      if (bitlocker_recovery_password) {
        const encRec = encryptField(bitlocker_recovery_password);
        await client.query(
          `INSERT INTO bios_passwords (device_id, password, password_encrypted, pw_enc_nonce, pw_enc_tag, password_type)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [device.id, bitlocker_recovery_password, encRec.ciphertext, encRec.nonce, encRec.tag, 'bitlocker_recovery']
        );
      }

      if (result_status === 'executed') {
        // cmdType and lockdownEffective were already computed above
        // (before the transaction). No need to re-query command_type here.

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
      // cmdType and lockdownEffective were already computed above
      // (before the transaction). Reuse them here for the notification.
      if (cmdType === 'lockdown') {
        // Phase 17: Include lockdown_effective + boot_lock_detail in the
        // notification so notification channels (email/Slack) can flag
        // ineffective lockdowns, not just the dashboard.
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
/**
 * S4: Escrow-before-arm — dedicated key-escrow endpoint.
 *
 * The agent calls this BEFORE it starts encrypting during a lockdown. It
 * sends the freshly-generated encryption key bound to the lockdown
 * command_id; the server persists it (encrypted at rest) so the key is
 * escrowed BEFORE the point of no return. If escrow fails the agent
 * refuses to encrypt — a device stays unlocked rather than locked-out
 * (unlocked > locked-without-recovery-key).
 *
 * Idempotent on (device_id, command_id): retries on the same command are
 * safe — ON CONFLICT DO NOTHING keeps the first escrowed key.
 */
router.post('/escrow-key', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, command_id, key_material, mac_address, hardware_uuid } = req.body;
  if (!hostname || !command_id || !key_material) {
    return res.status(400).json({ error: 'hostname, command_id, key_material required. Include all three fields in the request body.' });
  }
  if (typeof key_material !== 'string') {
    return res.status(400).json({ error: 'key_material must be a string (base64-encoded key).' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered. Enroll the device first via POST /api/devices, or verify the hostname and hardware identity fields match an enrolled device.' });

  // The command must exist and belong to this device — escrow is bound to
  // a real lockdown command, not free-floating key material.
  const cmdRow = await pool.query(
    'SELECT id, command_type FROM commands WHERE id = $1 AND device_id = $2',
    [command_id, device.id]
  );
  if (!cmdRow.rows[0]) {
    return res.status(404).json({ error: 'Command not found for this device.' });
  }

  const enc = encryptField(key_material);
  await pool.query(
    `INSERT INTO encryption_keys (device_id, command_id, key_material, key_material_encrypted, key_enc_nonce, key_enc_tag)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (device_id, command_id) WHERE command_id IS NOT NULL DO NOTHING`,
    [device.id, command_id, key_material, enc.ciphertext, enc.nonce, enc.tag]
  );

  res.json({ escrowed: true, command_id });
});

router.post('/deadman-report', agentAuth, hmacVerify(), async (req, res) => {
  const { hostname, mac_address, hardware_uuid, key_material } = req.body;
  if (!hostname || !key_material) {
    return res.status(400).json({ error: 'hostname and key_material required. Include both fields in the request body.' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered. Enroll the device first via POST /api/devices, or verify the hostname and hardware identity fields match an enrolled device.' });

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
    return res.status(400).json({ error: 'hostname and location required. Include both fields in the request body.' });
  }

  const device = req.device || await findDevice(hostname, mac_address, hardware_uuid);
  if (!device) return res.status(404).json({ error: 'Device not registered. Enroll the device first via POST /api/devices, or verify the hostname and hardware identity fields match an enrolled device.' });

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

  // Published release version. Configurable because it is a deployment fact:
  // the binary served is whatever is on disk, so a hardcoded literal lets the
  // two disagree (the Worker reads it from metadata for the same reason).
  const LATEST_VERSION = process.env.AGENT_LATEST_VERSION || '1.0.0';
  const updateAvailable = compareVersions(agentVersion, LATEST_VERSION) < 0;

  // Build download URL — the agent will use its server_url + this path
  const downloadPath = `/api/agent/download?platform=${agentPlatform}`;

  // S0.6 (B-006): detached Ed25519 signature over the update metadata.
  // Signed payload: "v1:{version}:{sha256}" — binds the binary's hash to
  // the version it claims. UPDATE_SIGNING_KEY holds a PEM private key
  // (file path or inline PEM); the agent verifies against a pinned
  // update-domain public key — separate from the recovery-escrow key.
  // A configured-but-broken key fails closed rather than serving
  // unsigned updates.
  const signingKey = process.env.UPDATE_SIGNING_KEY;
  let signature = null;
  if (signingKey) {
    try {
      const pem = fs.existsSync(signingKey) ? fs.readFileSync(signingKey) : signingKey;
      const payload = `v1:${LATEST_VERSION}:${sha256}`;
      signature = crypto.sign(null, Buffer.from(payload), pem).toString('base64');
    } catch (e) {
      return res.status(500).json({ error: 'update signing failed' });
    }
  }

  res.json({
    update_available: updateAvailable,
    latest_version: LATEST_VERSION,
    current_version: agentVersion,
    sha256,
    size: stat.size,
    download_url: downloadPath,
    built_at: stat.mtime.toISOString(),
    signature,
    signature_alg: signature ? 'ed25519' : null,
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
/**
 * POST /api/agent/efs-cert — the agent escrows its EFS recovery certificate.
 *
 * Body: { cert_base64, cert_password? } — the .pfx (already an encrypted
 * container) plus the password that protects it. Agent-authenticated: the device
 * is identified by its own key, so an agent can only store *its own* backup.
 *
 * The Worker has had this route all along and agent.py posts to it, but Express
 * had none, so on a self-hosted deployment every upload 404'd and no backup was
 * ever kept (S208, found by the cross-surface audit). The password is encrypted at
 * rest when FIELD_ENCRYPTION_KEY is configured, using the repo's dual-mode pattern.
 */
router.post('/efs-cert', agentAuth, hmacVerify(), async (req, res, next) => {
  const device = req.device;
  const { cert_base64: certBase64, cert_password: certPassword } = req.body || {};

  if (typeof certBase64 !== 'string' || certBase64.length === 0) {
    return res.status(400).json({ error: 'Missing cert_base64 field' });
  }

  try {
    // Encrypt the password that protects the .pfx (the .pfx is already encrypted).
    let enc = null;
    if (certPassword) {
      try {
        enc = encryptField(certPassword);
      } catch (err) {
        // No FIELD_ENCRYPTION_KEY configured (dev). The plaintext column keeps the
        // backup usable; the column is marked as such by the null enc columns.
        req.log?.warn?.({ err: err.message }, 'EFS cert password stored unencrypted');
      }
    }

    const now = new Date().toISOString();
    const params = [
      device.id,
      certBase64,
      // The plaintext column is only used when encryption is unavailable. Keeping
      // the password in BOTH columns would leave the secret readable at rest,
      // which is exactly what encrypting it was meant to prevent.
      enc ? null : certPassword || null,
      enc ? enc.ciphertext : null,
      enc ? enc.nonce : null,
      enc ? enc.tag : null,
      now,
    ];

    // One row per device (the newest backup wins) — update, then insert if absent.
    const updated = await pool.query(
      `UPDATE device_efs_certs
          SET cert_base64 = $2, cert_password = $3, cert_password_enc = $4,
              cert_password_nonce = $5, cert_password_tag = $6, uploaded_at = $7
        WHERE device_id = $1`,
      params
    );
    if (updated.rowCount === 0) {
      await pool.query(
        `INSERT INTO device_efs_certs
           (device_id, cert_base64, cert_password, cert_password_enc,
            cert_password_nonce, cert_password_tag, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        params
      );
    }

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, null, 'efs_cert_uploaded', {}]
    );

    res.json({ device: { id: device.id, hostname: device.hostname }, stored: true });
  } catch (err) {
    next(err);
  }
});

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
    return res.status(404).json({ error: 'Agent binary not available. Build the agent and place it in the agent binaries directory. Run make build-agent to create the binary.' });
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

/**
 * The device/admin credential presented on an uninstall-auth request.
 *
 * Three surfaces have to agree on this and did not (S252):
 *   - the Worker (`serverless/worker.ts`) reads `X-API-Key`;
 *   - `agentAuth` above reads `x-agent-key`;
 *   - `agent/tamper_protection.py` sends **`X-API-Key`** (plus a bearer token).
 *
 * So a device key presented the way the agent actually presents it was invisible here,
 * both uninstall-auth routes answered 401, and on a self-hosted server the token flow
 * could never complete. Reading both header names is the compatibility surface; the
 * bearer fallback still means "admin token only", because a device key is not one.
 */
function uninstallCredential(req) {
  return {
    agentKey: req.headers['x-agent-key'] || req.headers['x-api-key'],
    bearerToken: (req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''),
  };
}

/**
 * Is this request allowed to issue/verify an uninstall token — and as which device?
 *
 * Returns the **authenticated device row** when the caller presents a device key, or `null` when
 * it authenticated with the deployment's ADMIN_TOKEN. The row is what D-221 needs: the token is
 * bound to a device id, and the only trustworthy id is the one the key resolved to. Using the id
 * from the request body would make the property "does the caller claim an id" instead.
 */
async function authorizedForUninstall(req) {
  const { agentKey, bearerToken } = uninstallCredential(req);
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

  if (agentKey) {
    try {
      const device = await getDeviceByApiKeyHash(hashApiKey(agentKey));
      if (device) return { device };
    } catch {
      // Fall through to the admin-token check rather than 500ing on a DB blip.
    }
  }
  if (bearerToken && ADMIN_TOKEN && bearerToken === ADMIN_TOKEN) {
    return { device: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// D-221: the uninstall token scheme
// ---------------------------------------------------------------------------
// Canonical form, shared with the Worker and pinned by
// `docs/adr/D-221-token-vectors.json`:
//
//   window = floor(unix_seconds / 300) * 300
//   token  = HMAC_SHA256(secret=ADMIN_TOKEN, msg=f"{device_id}:{window}")   # lowercase hex
//
// What this replaced: `HMAC(ADMIN_TOKEN, window)` with no device input — so every device in a
// deployment received the same token — keyed by `ADMIN_TOKEN || 'fallback'`, which made the token
// computable from this repository whenever the secret was unset.
const UNINSTALL_TOKEN_WINDOW_SECONDS = 300;

function uninstallWindowFor(seconds) {
  return Math.floor(seconds / UNINSTALL_TOKEN_WINDOW_SECONDS) * UNINSTALL_TOKEN_WINDOW_SECONDS;
}

/** The bound token: only the named device may present it. */
function deriveUninstallToken(secret, deviceId, window) {
  return crypto.createHmac('sha256', secret).update(`${deviceId}:${window}`).digest('hex');
}

/**
 * The PREVIOUS Express derivation, kept for one release (ruling Q2-A): a device whose agent has
 * not yet taken the update must still be able to uninstall. Verification logs when this path is
 * taken, so the deprecation is visible rather than merely intended.
 */
function legacyUninstallToken(secret, window) {
  return crypto.createHmac('sha256', secret).update(String(window)).digest('hex');
}

// The date the legacy scheme stops being accepted. `docs/adr/D-221-token-vectors.json` is the
// authoritative statement; this literal exists so the deprecation response tells caller and
// operator WHEN, and `legacy_sunset` is pinned against it by the test below it in
// server/tests/uninstallAuth.test.js. On that date
// `scripts/test_cross_surface_contract.py` fails with the deletion checklist.
const LEGACY_UNINSTALL_TOKEN_SUNSET = '2027-02-04';

/** Constant-time comparison of two hex strings (unequal lengths are never equal). */
function safeEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8');
  const b = Buffer.from(String(right), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Which device is this token for?
 *
 * A device-key caller is bound to **its own** row and may not name another device. The admin-token
 * caller has no device of its own, so it must name one — an unbound token can no longer be issued,
 * which is the point of D-221.
 */
function uninstallSubject(auth, body) {
  if (auth.device) return { deviceId: auth.device.id, error: null };
  const claimed = typeof body?.device_id === 'string' ? body.device_id.trim() : '';
  if (!claimed) {
    return {
      deviceId: null,
      error:
        'device_id required: an uninstall token is bound to one device, and an admin-token ' +
        'call has no device of its own to bind to.',
    };
  }
  return { deviceId: claimed, error: null };
}

/**
 * POST /api/agent/uninstall-auth — Issue a short-lived uninstall token.
 *
 * The agent calls this when a local admin wants to uninstall the agent.
 * The server issues a token valid for 5 minutes. The local uninstall
 * script must present this token to remove tamper protection (ACLs,
 * registry DENY ACEs) before deleting the agent.
 *
 * Accepts either agent API key (x-agent-key or X-API-Key) or admin bearer token.
 */
router.post('/uninstall-auth', async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

  const auth = await authorizedForUninstall(req);
  if (!auth) {
    // Never echo the presented credential: the agent logs this body verbatim when
    // a token request fails (tamper_protection.py, `except HTTPError`).
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Q3-A: no secret, no token. Before D-221 this fell back to the literal string
  // 'fallback', so a deployment that never set ADMIN_TOKEN issued a token anyone could
  // compute from this repository.
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error:
        'Uninstall tokens are disabled: ADMIN_TOKEN is not set on this server. Set it and ' +
        'restart; an uninstall token is derived from it.',
    });
  }

  const { deviceId, error } = uninstallSubject(auth, req.body);
  if (error) return res.status(400).json({ error });

  const window = uninstallWindowFor(Math.floor(Date.now() / 1000));
  const uninstallToken = deriveUninstallToken(ADMIN_TOKEN, deviceId, window);

  return res.json({
    uninstall_token: uninstallToken,
    expires_in: UNINSTALL_TOKEN_WINDOW_SECONDS,
    issued_at: new Date().toISOString(),
    device_id: deviceId,
  });
});

/**
 * POST /api/agent/uninstall-auth/verify — Verify an uninstall token.
 *
 * Checks if the token is valid (within the current or previous 5-minute window).
 */
router.post('/uninstall-auth/verify', async (req, res) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

  const auth = await authorizedForUninstall(req);
  if (!auth) {
    // Same rule as the issuing route: a body that carries a token is logged verbatim
    // by the agent on failure, so the rejection must not repeat it.
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error:
        'Uninstall tokens are disabled: ADMIN_TOKEN is not set on this server. Set it and ' +
        'restart; an uninstall token is derived from it.',
    });
  }

  const providedToken = req.body?.uninstall_token;
  if (!providedToken || typeof providedToken !== 'string') {
    return res.status(400).json({ error: 'uninstall_token required' });
  }

  const { deviceId, error } = uninstallSubject(auth, req.body);
  if (error) return res.status(400).json({ error });

  // Current and previous 5-minute windows, so ordinary clock skew does not break an uninstall.
  const now = Math.floor(Date.now() / 1000);
  const validWindows = [uninstallWindowFor(now), uninstallWindowFor(now - UNINSTALL_TOKEN_WINDOW_SECONDS)];

  for (const window of validWindows) {
    if (safeEqual(providedToken, deriveUninstallToken(ADMIN_TOKEN, deviceId, window))) {
      return res.json({ authorized: true, verified: true });
    }
  }

  // Q2-A migration window: still accept the PREVIOUS deployment-wide scheme so a device whose
  // agent has not yet taken the update can uninstall. It is logged every time, because the
  // acceptance is meant to end.
  for (const window of validWindows) {
    if (safeEqual(providedToken, legacyUninstallToken(ADMIN_TOKEN, window))) {
      logger.warn(
        { deviceId, sunset: LEGACY_UNINSTALL_TOKEN_SUNSET },
        `[uninstall-auth] accepted a LEGACY deployment-wide uninstall token — D-221 removed device `
          + `binding from this scheme. It is deleted on ${LEGACY_UNINSTALL_TOKEN_SUNSET}; update the `
          + 'agent on this device before then or it cannot be uninstalled afterwards.'
      );
      return res.json({
        authorized: true,
        verified: true,
        deprecated_scheme: 'legacy-deployment-wide',
        deprecated_scheme_sunset: LEGACY_UNINSTALL_TOKEN_SUNSET,
      });
    }
  }

  return res.json({ authorized: false, verified: false });
});

// Exposed for the test that pins it against docs/adr/D-221-token-vectors.json.
router.LEGACY_UNINSTALL_TOKEN_SUNSET = LEGACY_UNINSTALL_TOKEN_SUNSET;

module.exports = router;
