/**
 * POST /api/rearm — hardware-UUID-bound re-arm for the PblPersistDxe bootstrap.
 *
 * Why this exists
 * ---------------
 * The firmware DXE module drops a self-contained bootstrap onto the ESP on every
 * boot. On a wiped or replaced disk that bootstrap cannot carry a device secret,
 * so it identifies the machine by `hardware_uuid` and asks the server to re-arm
 * it (firmware/PblPkg/PblPersistDxe/PblPersistDxe.c posts to `/api/rearm` and
 * writes the response — which is a **plain-text install.ps1** — to a file and
 * runs it).
 *
 * The Worker implemented this; Express had no such route, so on a self-hosted
 * deployment the bootstrap got a 404 and the machine could not re-arm itself
 * (S208, found by the cross-surface audit).
 *
 * Trust model (deliberately narrow, and the reason for every check below)
 * ----------------------------------------------------------------------
 * `hardware_uuid` is a stable identifier, not a secret. So:
 *   - only a device that is ENROLLED and was FLAGGED (stolen / locked /
 *     recovering / tracking) may re-arm — an active device re-arming would let
 *     anyone who learns a hardware UUID re-key it;
 *   - unknown and active devices answer the SAME 404, so the endpoint cannot be
 *     probed for which hardware UUIDs exist;
 *   - it is unauthenticated (the bootstrap has no credential yet), so it carries
 *     a strict rate limit;
 *   - every successful re-arm is audited, and the old key is replaced — the
 *     previous agent copy stops authenticating.
 *
 * This is the Computrace model: the platform is owned, the identifier is stable,
 * and possession of the flagged machine is what authorises recovery.
 */

const express = require('express');
const pool = require('../db/pool');
const { generateApiKey, hashApiKey } = require('../db/apiKey');
const installer = require('./installer');

const router = express.Router();

/** Statuses that mean "this device was flagged" — the only ones that may re-arm. */
const REARMABLE_STATUSES = new Set(['stolen', 'locked', 'recovering', 'tracking']);

router.post('/', async (req, res, next) => {
  const { hardware_uuid: hardwareUuid, hostname } = req.body || {};

  if (typeof hardwareUuid !== 'string' || hardwareUuid.trim().length === 0) {
    return res.status(400).json({ error: 'hardware_uuid required' });
  }

  try {
    const found = await pool.query('SELECT * FROM devices WHERE hardware_uuid = $1', [
      hardwareUuid.trim(),
    ]);
    const device = found.rows[0];

    // Unknown hardware UUID and an active device are indistinguishable by design:
    // an active device that re-armed would be re-keyable by anyone who learned its
    // UUID, and a distinct status would confirm the UUID exists.
    if (!device || !REARMABLE_STATUSES.has(device.status)) {
      return res.status(404).json({ error: 'Device not found' });
    }

    // Fresh credentials: the bootstrap installs an agent that must authenticate,
    // and replacing the hash retires the previous copy.
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    const updated = await pool.query(
      'UPDATE devices SET api_key_hash = $1 WHERE id = $2 RETURNING *',
      [apiKeyHash, device.id]
    );

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [
        device.id,
        null, // no admin is present at boot; provenance is the hardware UUID
        'rearm',
        { hardware_uuid: hardwareUuid.trim(), status: device.status, hostname: hostname || null },
      ]
    );

    // The bootstrap writes this to a file and executes it, so the body must be the
    // script itself — not JSON wrapping it (Invoke-RestMethod returns the text).
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const config = installer.helpers.buildDeviceConfig(updated.rows[0], serverUrl, apiKey);
    const script = installer.helpers.generateInstallPs1(config, updated.rows[0].hostname);

    res.type('text/plain; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    // A .ps1 body served as text/plain is still sniffable: without nosniff, a browser
    // that sniffs HTML here would execute markup from any value that reaches the script
    // (hostname comes from the device table). The script is what the bootstrap writes to
    // disk and runs, so it cannot be JSON-wrapped; nosniff is what keeps a browser from
    // treating it as a document (S251).
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(script);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
