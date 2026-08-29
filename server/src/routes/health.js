const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

// Track server start time for uptime reporting.
const START_TIME = Date.now();

/**
 * Run a DB probe (`SELECT 1`) with a timeout so a hung DB doesn't
 * keep the health check hanging indefinitely.
 *
 * @param {number} timeoutMs — abort the probe after this many ms
 * @returns {Promise<{ ok: boolean, latencyMs: number, error?: string }>}
 */
async function probeDb(timeoutMs = 3000) {
  const start = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB probe timed out')), timeoutMs)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: 'unreachable' };
  }
}

/**
 * GET / — liveness probe.
 *
 * Returns 200 + { status: "ok", timestamp } if the process is up.
 * No auth required (for load balancer / Kubernetes liveness checks).
 * Intentionally cheap — does NOT touch the DB.
 */
router.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /ready — readiness probe.
 *
 * Returns 200 if the server can handle requests (DB connected),
 * 503 if the DB is unreachable. No auth required.
 */
router.get('/ready', async (_req, res) => {
  const db = await probeDb();
  if (db.ok) {
    res.status(200).json({
      status: 'ok',
      db: 'connected',
      dbLatencyMs: db.latencyMs,
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'degraded',
      db: 'disconnected',
      error: db.error,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /detailed — full system status (admin auth required).
 *
 * Returns:
 *  - Server status (uptime, memory usage)
 *  - DB connection status + latency
 *  - Agent fleet checkin statistics (active / stale / missing / dead / never)
 *  - Command queue depth (pending commands)
 *  - Recent health alerts from audit_log
 */
router.get('/detailed', requireAuth, async (_req, res) => {
  const db = await probeDb();

  // Default fleet stats (used if DB is down so the endpoint still responds).
  const fleet = {
    active: 0,
    stale: 0,
    missing: 0,
    dead: 0,
    never: 0,
    total: 0,
  };
  let queueDepth = 0;
  let recentAlerts = [];

  if (db.ok) {
    // Agent checkin status counts.
    //
    // Thresholds (per skill domain):
    //   active:  last_checkin within 2x poll interval (<= 2 min ago)
    //   stale:   last_checkin > 2 min but <= 24 h ago
    //   missing: last_checkin > 24 h but <= 72 h ago
    //   dead:    last_checkin > 72 h ago (dead man's switch should have fired)
    //   never:   last_checkin IS NULL
    try {
      const fleetResult = await pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (
            WHERE last_checkin IS NOT NULL
              AND last_checkin > NOW() - INTERVAL '2 minutes'
          ) AS active,
          COUNT(*) FILTER (
            WHERE last_checkin IS NOT NULL
              AND last_checkin <= NOW() - INTERVAL '2 minutes'
              AND last_checkin > NOW() - INTERVAL '24 hours'
          ) AS stale,
          COUNT(*) FILTER (
            WHERE last_checkin IS NOT NULL
              AND last_checkin <= NOW() - INTERVAL '24 hours'
              AND last_checkin > NOW() - INTERVAL '72 hours'
          ) AS missing,
          COUNT(*) FILTER (
            WHERE last_checkin IS NOT NULL
              AND last_checkin <= NOW() - INTERVAL '72 hours'
          ) AS dead,
          COUNT(*) FILTER (
            WHERE last_checkin IS NULL
          ) AS never
        FROM devices
      `);
      const row = fleetResult.rows[0] || {};
      fleet.active = parseInt(row.active, 10) || 0;
      fleet.stale = parseInt(row.stale, 10) || 0;
      fleet.missing = parseInt(row.missing, 10) || 0;
      fleet.dead = parseInt(row.dead, 10) || 0;
      fleet.never = parseInt(row.never, 10) || 0;
      fleet.total = parseInt(row.total, 10) || 0;
    } catch (err) {
      // Non-fatal — fleet stats just stay at zero.
      logger.error({ err }, '[health] fleet stats query failed');
    }

    // Pending command queue depth.
    try {
      const queueResult = await pool.query(
        `SELECT COUNT(*) AS pending FROM commands WHERE status = 'pending'`
      );
      queueDepth = parseInt(queueResult.rows[0]?.pending, 10) || 0;
    } catch (err) {
      logger.error({ err }, '[health] queue depth query failed');
    }

    // Recent health alerts from audit_log.
    try {
      const alertsResult = await pool.query(
        `SELECT id, action, detail, timestamp
         FROM audit_log
         WHERE action = 'health_alert'
         ORDER BY timestamp DESC
         LIMIT 10`
      );
      recentAlerts = alertsResult.rows || [];
    } catch (err) {
      logger.error({ err }, '[health] recent alerts query failed');
    }
  }

  const mem = process.memoryUsage();

  // Overall server health: ok if DB is connected, degraded otherwise.
  const serverStatus = db.ok ? 'ok' : 'degraded';

  res.json({
    status: serverStatus,
    timestamp: new Date().toISOString(),
    server: {
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      },
    },
    db: {
      connected: db.ok,
      latencyMs: db.latencyMs,
      error: db.error || null,
    },
    fleet,
    queueDepth,
    recentAlerts,
  });
});

module.exports = router;
