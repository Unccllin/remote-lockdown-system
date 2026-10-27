const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger = require('../logger');
const meshcentral = require('../integrations/meshcentral');

const router = express.Router();

/**
 * Integration surface — OURS.
 *
 * See docs/adr/INTEGRATION-OWNERSHIP.md. These routes expose a normalized,
 * read-only inventory view. They do not proxy destructive actions: lockdown,
 * unlock and policy changes are issued through our own command queue and audit
 * log, never through a third-party API.
 *
 * Contract notes:
 *   - The shape below is defined here, not by the upstream. Swapping
 *     MeshCentral for another RMM changes the connector, not this route.
 *   - A missing or broken upstream is a degraded feature, never a broken
 *     service: it answers 503/502 and the rest of the API is unaffected.
 *   - No credential, URL query or upstream payload is echoed to the client or
 *     written to the log.
 */

const CONNECTORS = [meshcentral];

/** GET /api/integrations — cheap status of each connector (no upstream call). */
router.get('/', requireAuth, requireRole('operator'), (_req, res) => {
  res.json({
    integrations: CONNECTORS.map((c) => c.status()),
  });
});

/**
 * GET /api/integrations/meshcentral/devices
 *
 * 200 { devices, fetchedAt, source }  — normalized inventory
 * 503 { error, code: 'NOT_CONFIGURED' } — integration off / no credentials
 * 502 { error, code: 'UPSTREAM_ERROR' } — upstream unreachable or malformed
 */
router.get('/meshcentral/devices', requireAuth, requireRole('operator'), async (_req, res) => {
  try {
    const { devices, fetchedAt } = await meshcentral.getDevices();
    res.json({ source: 'meshcentral', readOnly: true, fetchedAt, devices });
  } catch (err) {
    if (err instanceof meshcentral.ConnectorNotConfigured) {
      return res.status(503).json({
        error: 'The MeshCentral integration is not configured. Set MESHCENTRAL_URL and credentials.',
        code: err.code,
      });
    }
    if (err instanceof meshcentral.ConnectorUpstreamError) {
      // Log the reason, not the URL (it may carry an auth token).
      logger.warn({ reason: err.message }, '[integrations] meshcentral upstream failed');
      return res.status(502).json({
        error: 'The MeshCentral upstream could not be read. Inventory is unavailable; the rest of the API is unaffected.',
        code: err.code,
      });
    }
    throw err;
  }
});

module.exports = router;
