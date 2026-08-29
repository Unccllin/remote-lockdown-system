const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

/**
 * POST / — Receive a hardware test artifact from the hw_test_harness v2.0.
 *
 * The agent's --upload flag POSTs the CTRF/legacy JSON artifact here.
 * We store it in the hw_test_artifacts table and associate it with the
 * device (if the artifact contains a matching hostname).
 *
 * Auth: requires admin auth (the harness is run by an admin, not the agent).
 * Body: the full artifact JSON object.
 */
router.post('/', requireAuth, async (req, res) => {
  const artifact = req.body;

  // Basic validation — must look like a harness artifact
  if (!artifact || typeof artifact !== 'object') {
    return res.status(400).json({ error: 'Artifact must be a JSON object' });
  }

  // Accept both CTRF format ({ results: { ... } }) and legacy format ({ harness_version, ... })
  const isCtrf = artifact.results && artifact.results.tool;
  const isLegacy = artifact.harness_version;

  if (!isCtrf && !isLegacy) {
    return res.status(400).json({
      error: 'Invalid artifact format — expected CTRF ({results:{tool,...}}) or legacy ({harness_version,...})',
    });
  }

  // Extract summary + environment
  const summary = isCtrf
    ? artifact.results.summary
    : artifact.summary;
  const environment = isCtrf
    ? artifact.results.extra?.environment
    : artifact.environment;
  const harnessVersion = isCtrf
    ? artifact.results.tool?.version
    : artifact.harness_version;
  const tests = isCtrf
    ? artifact.results.tests
    : artifact.results;

  if (!summary) {
    return res.status(400).json({ error: 'Artifact missing summary' });
  }

  const hostname = environment?.hostname || null;
  const agentHash = environment?.agent_binary_hash || null;

  try {
    // Try to find a matching device by hostname
    let deviceId = null;
    if (hostname) {
      const devResult = await pool.query(
        'SELECT id FROM devices WHERE hostname = $1 ORDER BY created_at DESC LIMIT 1',
        [hostname]
      );
      if (devResult.rows.length > 0) {
        deviceId = devResult.rows[0].id;
      }
    }

    // Store the artifact
    const result = await pool.query(
      `INSERT INTO hw_test_artifacts
        (device_id, admin_id, hostname, harness_version, agent_hash,
         total_tests, passed, failed, skipped, errors, artifact_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, created_at`,
      [
        deviceId,
        req.admin?.id || null,
        hostname,
        harnessVersion || null,
        agentHash,
        summary.tests || summary.total || 0,
        summary.passed || 0,
        summary.failed || 0,
        summary.skipped || 0,
        summary.errors || 0,
        JSON.stringify(artifact),
      ]
    );

    const artifactId = result.rows[0].id;
    logger.info({
      artifactId,
      hostname,
      deviceId,
      harnessVersion,
      summary,
    }, 'HW test artifact uploaded');

    // Log to audit trail
    if (req.admin?.id) {
      await pool.query(
        `INSERT INTO audit_log (admin_id, device_id, action, detail)
         VALUES ($1, $2, 'hw_test_artifact_upload', $3)`,
        [
          req.admin.id,
          deviceId,
          `Harness v${harnessVersion}: ${summary.passed}/${summary.tests || summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
        ]
      );
    }

    res.status(201).json({
      id: artifactId,
      device_id: deviceId,
      hostname,
      summary: {
        total: summary.tests || summary.total || 0,
        passed: summary.passed || 0,
        failed: summary.failed || 0,
        skipped: summary.skipped || 0,
        errors: summary.errors || 0,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to store HW test artifact');

    // If the table doesn't exist, return a helpful error
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'hw_test_artifacts table not found — run the migration to create it',
      });
    }
    res.status(500).json({ error: 'Failed to store artifact' });
  }
});

/**
 * GET / — List recent hardware test artifacts.
 *
 * Returns the most recent artifacts, optionally filtered by device_id.
 */
router.get('/', requireAuth, async (req, res) => {
  const { device_id } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  try {
    let query = `
      SELECT id, device_id, admin_id, hostname, harness_version, agent_hash,
             total_tests, passed, failed, skipped, errors, created_at
      FROM hw_test_artifacts
    `;
    const params = [];

    if (device_id) {
      if (!/^[0-9a-f-]{16,36}$/i.test(device_id)) {
        return res.status(400).json({ error: 'Invalid device_id format' });
      }
      query += ' WHERE device_id = $1';
      params.push(device_id);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'Failed to list HW test artifacts');
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'hw_test_artifacts table not found — run the migration to create it',
      });
    }
    res.status(500).json({ error: 'Failed to list artifacts' });
  }
});

/**
 * GET /:id — Get a specific artifact (including full JSON).
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid artifact ID' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM hw_test_artifacts WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Artifact not found' });
    }

    const row = result.rows[0];
    // Parse the artifact JSON if it's stored as a string
    if (typeof row.artifact_json === 'string') {
      row.artifact_json = JSON.parse(row.artifact_json);
    }

    res.json(row);
  } catch (err) {
    logger.error({ err }, 'Failed to get HW test artifact');
    if (err.code === '42P01') {
      return res.status(503).json({
        error: 'hw_test_artifacts table not found — run the migration to create it',
      });
    }
    res.status(500).json({ error: 'Failed to get artifact' });
  }
});

module.exports = router;
