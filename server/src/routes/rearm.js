/**
 * POST /api/rearm — the PblPersistDxe bootstrap asks for a fresh agent install.
 *
 * Trust model (ADR-011 — this route used to be the "Computrace model")
 * -------------------------------------------------------------------
 * The firmware DXE module drops a self-contained bootstrap onto the ESP on every boot. On a wiped
 * or replaced disk that bootstrap cannot carry a device secret — the driver's own comment says so —
 * and it identifies the machine by `hardware_uuid`, a value printed in firmware setup and readable
 * from Windows by any process, including one belonging to the person holding the machine.
 *
 * So the UUID is **not** a credential, and this route does not treat it as one:
 *
 *   - only an enrolled, FLAGGED device may ask (unknown and active devices answer the same 404, so
 *     the route cannot be probed for which UUIDs exist);
 *   - asking creates a `rearm_requests` row and answers 409 — no key is issued;
 *   - a super-admin approves it through `/api/admin/rearm-requests`, and the next call consumes the
 *     approval, issues exactly one key, and returns the install script;
 *   - an approval expires, so it cannot be banked until a thief needs it, and it is deleted on use,
 *     so two racing callers cannot both be served.
 *
 * The technician's retry is what makes this workable in the field: the bootstrap writes its success
 * marker only after the install script runs, so a 409 leaves the device free to try again once the
 * administrator clicks approve.
 *
 * The response body must stay the script itself: the bootstrap writes it to a file and executes it,
 * so JSON-wrapping it would write something that never runs. It is served with `nosniff` because
 * script text reaching an HTML renderer is the XSS the direct-response-write rule warns about.
 */

const express = require('express');
const pool = require('../db/pool');
const { generateApiKey, hashApiKey } = require('../db/apiKey');
const installer = require('./installer');

const router = express.Router();

/** Statuses that mean "this device was flagged" — the only ones that may ask to re-arm. */
const REARMABLE_STATUSES = new Set(['stolen', 'locked', 'recovering', 'tracking']);

/** How long an administrator's approval stays usable. Long enough for a technician to retry. */
const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** Record or refresh this device's pending request. */
async function requestApproval(device, hardwareUuid, hostname, sourceIp) {
  const now = new Date().toISOString();
  const existing = await pool.query('SELECT * FROM rearm_requests WHERE device_id = $1', [device.id]);

  if (!existing.rows[0]) {
    await pool.query(
      `INSERT INTO rearm_requests (device_id, hardware_uuid, hostname, requested_at, source_ip, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [device.id, hardwareUuid, hostname || null, now, sourceIp || null]
    );
    return true;
  }

  // A denied request is not silently re-opened: the device may ask again, but that is a new request
  // and an administrator sees it arrive.
  await pool.query(
    `UPDATE rearm_requests
        SET hardware_uuid = $2, hostname = $3, requested_at = $4, source_ip = $5,
            status = 'pending', decided_at = NULL, decided_by = NULL, expires_at = NULL
      WHERE device_id = $1`,
    [device.id, hardwareUuid, hostname || null, now, sourceIp || null]
  );
  return true;
}

router.post('/', async (req, res, next) => {
  const { hardware_uuid: hardwareUuid, hostname } = req.body || {};

  if (typeof hardwareUuid !== 'string' || hardwareUuid.trim().length === 0) {
    return res.status(400).json({ error: 'hardware_uuid required' });
  }

  const uuid = hardwareUuid.trim();
  const sourceIp = req.ip || null;

  try {
    const found = await pool.query('SELECT * FROM devices WHERE hardware_uuid = $1', [uuid]);
    const device = found.rows[0];

    // Unknown UUID and an active device are indistinguishable by design: an active device asking
    // would be re-keyable by anyone who learned its UUID, and a distinct status would confirm that
    // the UUID exists.
    if (!device || !REARMABLE_STATUSES.has(device.status)) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const pending = await pool.query('SELECT * FROM rearm_requests WHERE device_id = $1', [device.id]);
    const request = pending.rows[0];

    if (request && request.status === 'denied') {
      return res.status(403).json({ error: 'Re-arm was denied by an administrator.' });
    }

    if (request && request.status === 'approved') {
      const expiresAt = request.expires_at ? Date.parse(request.expires_at) : NaN;
      const stillValid = Number.isFinite(expiresAt) && expiresAt > Date.now();

      if (stillValid) {
        // Consume before issuing, so two racing callers cannot both be served.
        await pool.query('DELETE FROM rearm_requests WHERE device_id = $1', [device.id]);

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
            null,
            'rearm_approval_used',
            { hardware_uuid: uuid, status: device.status, approved_by: request.decided_by || null },
          ]
        );

        const serverUrl = `${req.protocol}://${req.get('host')}`;
        const config = installer.helpers.buildDeviceConfig(updated.rows[0], serverUrl, apiKey);
        const script = installer.helpers.generateInstallPs1(config, updated.rows[0].hostname);

        res.type('text/plain; charset=utf-8');
        res.set('Cache-Control', 'no-cache');
        res.set('X-Content-Type-Options', 'nosniff');
        return res.send(script);
      }

      // Stale approval: drop it and record a fresh request rather than honouring an old decision.
      await pool.query('DELETE FROM rearm_requests WHERE device_id = $1', [device.id]);
    }

    await requestApproval(device, uuid, hostname, sourceIp);

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [device.id, null, 'rearm_requested', { hardware_uuid: uuid, status: device.status, source_ip: sourceIp }]
    );

    return res.status(409).json({
      error:
        'Re-arm requires administrator approval. An administrator has been notified; ' +
        're-run this recovery after it is approved.',
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.APPROVAL_TTL_MS = APPROVAL_TTL_MS;
module.exports.REARMABLE_STATUSES = REARMABLE_STATUSES;
