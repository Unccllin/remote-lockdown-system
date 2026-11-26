/**
 * /api/admin/rearm-requests — the approval queue for re-arm requests (ADR-011, D-226).
 *
 * `POST /api/rearm` is unauthenticated by necessity (the firmware bootstrap has no credential), so
 * the decision to re-key a flagged device is made here, by a super-admin, and recorded on both
 * sides: the request audit and the decision audit. Both differ in kind, so an incident review can
 * tell "a device asked" from "an administrator allowed it".
 *
 * Approval is deliberately a separate step from issuing: the approval only sets a row to `approved`
 * with a 15-minute `expires_at`. The device's next `POST /api/rearm` consumes it and gets the key.
 */

const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

/** Same window as the re-arm route: an approval cannot be banked until someone needs it. */
const APPROVAL_TTL_MS = 15 * 60 * 1000;

router.use(requireAuth, requireRole('super-admin'));

/** GET — the pending queue, newest first, with the device's current status for context. */
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.device_id, r.hardware_uuid, r.hostname, r.requested_at, r.source_ip, r.status,
              d.hostname AS device_hostname, d.status AS device_status
         FROM rearm_requests r
         JOIN devices d ON d.id = r.device_id
        WHERE r.status = 'pending'
        ORDER BY r.requested_at DESC`
    );
    return res.json({ requests: result.rows });
  } catch (err) {
    return next(err);
  }
});

async function decide(req, res, next, decision) {
  const { deviceId } = req.params;

  try {
    const now = new Date();
    const expiresAt = decision === 'approved'
      ? new Date(now.getTime() + APPROVAL_TTL_MS).toISOString()
      : null;

    const updated = await pool.query(
      `UPDATE rearm_requests
          SET status = $2, decided_at = $3, decided_by = $4, expires_at = $5
        WHERE device_id = $1 AND status = 'pending'
        RETURNING *`,
      [deviceId, decision, now.toISOString(), req.admin?.id || null, expiresAt]
    );

    if (updated.rowCount === 0) {
      // Either there is no request, or it was already decided. Both answer the same way so the
      // endpoint cannot be used to enumerate device ids.
      return res.status(404).json({ error: 'No pending re-arm request for that device.' });
    }

    await pool.query(
      'INSERT INTO audit_log (device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4)',
      [
        deviceId,
        req.admin?.id || null,
        decision === 'approved' ? 'rearm_approved' : 'rearm_denied',
        { decided_by: req.admin?.username || null, expires_at: expiresAt },
      ]
    );

    return res.json({ request: updated.rows[0] });
  } catch (err) {
    return next(err);
  }
}

router.post('/:deviceId/approve', (req, res, next) => decide(req, res, next, 'approved'));
router.post('/:deviceId/deny', (req, res, next) => decide(req, res, next, 'denied'));

module.exports = router;
module.exports.APPROVAL_TTL_MS = APPROVAL_TTL_MS;
