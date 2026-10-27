const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const logger = require('../logger');
const integrations = require('../integrations');

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



/** GET /api/integrations — cheap status of each connector (no upstream call). */
router.get('/', requireAuth, requireRole('operator'), (_req, res) => {
  res.json({
    integrations: integrations.list().map((c) => c.status()),
  });
});

/**
 * GET /api/integrations/:id/devices
 *
 * Upstream-agnostic on purpose: the registry decides which connector answers,
 * so adding or replacing an upstream never changes this route (the S142 finding
 * was that the first upstream had no usable REST surface at all).
 *
 * 200 { devices, fetchedAt, source }  — normalized inventory
 * 404 { error, code: 'UNKNOWN_CONNECTOR' } — no such connector
 * 503 { error, code: 'NOT_CONFIGURED' } — integration off / no credentials
 * 502 { error, code: 'UPSTREAM_ERROR' } — upstream unreachable or malformed
 */
router.get('/:id/devices', requireAuth, requireRole('operator'), async (req, res) => {
  const connector = integrations.get(req.params.id);
  if (!connector) {
    return res.status(404).json({
      error: `No integration named "${req.params.id}". Available: ${integrations.list().map((c) => c.id).join(', ')}.`,
      code: 'UNKNOWN_CONNECTOR',
    });
  }

  try {
    const { devices, fetchedAt } = await connector.getDevices();
    res.json({ source: connector.id, readOnly: true, fetchedAt, devices });
  } catch (err) {
    if (err instanceof integrations.ConnectorNotConfigured) {
      return res.status(503).json({
        error: `The ${connector.id} integration is not configured. See server/.env.example.`,
        code: err.code,
      });
    }
    if (err instanceof integrations.ConnectorUpstreamError) {
      // Log the reason, not the URL (it may carry an auth token).
      logger.warn({ connector: connector.id, reason: err.message }, '[integrations] upstream failed');
      return res.status(502).json({
        error: `The ${connector.id} upstream could not be read. Inventory is unavailable; the rest of the API is unaffected.`,
        code: err.code,
      });
    }
    throw err;
  }
});

module.exports = router;
