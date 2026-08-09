/**
 * Phase 13: Prometheus metrics endpoint.
 *
 * GET /metrics — exposes Prometheus text-format metrics for external scraping.
 * No auth required (standard Prometheus scrape target, kept outside the API
 * auth layer by mounting on /metrics rather than /api/metrics).
 *
 * Custom metrics (collected from the DB on each scrape):
 *   - lockdown_devices_total{status}        — gauge, device counts by status
 *   - lockdown_commands_pending_total       — gauge, pending command count
 *   - lockdown_commands_completed_total     — counter, completed commands
 *   - lockdown_agent_checkins_total         — counter, total checkins
 *   - lockdown_stale_devices_total          — gauge, devices with stale checkin
 *   - lockdown_uptime_seconds               — gauge, server uptime
 *   - lockdown_db_query_duration_seconds    — histogram, DB query latency
 *
 * Also includes prom-client default metrics (process, GC).
 */

const express = require('express');
const promClient = require('prom-client');
const pool = require('../db/pool');
const logger = require('../logger');

const router = express.Router();

// Track server start time for uptime reporting.
const START_TIME = Date.now();

// Use a dedicated Registry so custom metrics don't collide with the global
// default registry (which holds the default process/GC metrics).
const registry = new promClient.Registry();

// Collect default metrics (process, GC) into our registry.
promClient.collectDefaultMetrics({ register: registry });

// --- Custom metrics -------------------------------------------------------

const devicesTotal = new promClient.Gauge({
  name: 'lockdown_devices_total',
  help: 'Number of devices by status',
  labelNames: ['status'],
  registers: [registry],
});

const commandsPendingTotal = new promClient.Gauge({
  name: 'lockdown_commands_pending_total',
  help: 'Number of pending commands in the queue',
  registers: [registry],
});

const commandsCompletedTotal = new promClient.Counter({
  name: 'lockdown_commands_completed_total',
  help: 'Total number of completed commands',
  registers: [registry],
});

const agentCheckinsTotal = new promClient.Counter({
  name: 'lockdown_agent_checkins_total',
  help: 'Total number of agent checkins',
  registers: [registry],
});

const staleDevicesTotal = new promClient.Gauge({
  name: 'lockdown_stale_devices_total',
  help: 'Number of devices with a stale checkin (last_checkin older than 2x poll interval)',
  registers: [registry],
});

const uptimeSeconds = new promClient.Gauge({
  name: 'lockdown_uptime_seconds',
  help: 'Server uptime in seconds',
  registers: [registry],
});

const dbQueryDurationSeconds = new promClient.Histogram({
  name: 'lockdown_db_query_duration_seconds',
  help: 'Database query latency in seconds',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

// --- DB-backed collection -------------------------------------------------
//
// Counters (commands_completed_total, agent_checkins_total) are monotonically
// increasing in the DB. We track the last observed value and only inc() the
// counter by the positive delta — this keeps the Prometheus counter monotonic
// even if rows are deleted (the counter never decreases).
let lastCompletedCount = null;
let lastCheckinCount = null;

/**
 * Collect all DB-backed metrics in a single pass.
 * Every query is wrapped so a failure in one doesn't abort the whole scrape.
 */
async function collectMetrics() {
  // Uptime — always available.
  uptimeSeconds.set((Date.now() - START_TIME) / 1000);

  // Probe DB latency with a SELECT 1, observed into the histogram.
  const probeStart = Date.now();
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    logger.error({ err }, '[metrics] DB probe failed');
  }
  dbQueryDurationSeconds.observe((Date.now() - probeStart) / 1000);

  if (!dbOk) {
    // DB unavailable — leave DB-backed metrics at their last values.
    return;
  }

  // Device counts by status.
  try {
    const statusResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM devices GROUP BY status`
    );
    // Reset all status labels to 0 first so removed statuses don't linger.
    devicesTotal.reset();
    for (const row of statusResult.rows || []) {
      devicesTotal.set({ status: row.status }, parseInt(row.count, 10) || 0);
    }
  } catch (err) {
    logger.error({ err }, '[metrics] device status query failed');
  }

  // Pending commands (gauge).
  try {
    const pendingResult = await pool.query(
      `SELECT COUNT(*)::int AS pending FROM commands WHERE status = 'pending'`
    );
    commandsPendingTotal.set(parseInt(pendingResult.rows[0]?.pending, 10) || 0);
  } catch (err) {
    logger.error({ err }, '[metrics] pending commands query failed');
  }

  // Completed commands (counter — inc by positive delta only).
  try {
    const completedResult = await pool.query(
      `SELECT COUNT(*)::int AS completed FROM commands WHERE status = 'completed'`
    );
    const completed = parseInt(completedResult.rows[0]?.completed, 10) || 0;
    if (lastCompletedCount === null) {
      commandsCompletedTotal.inc(completed);
    } else if (completed > lastCompletedCount) {
      commandsCompletedTotal.inc(completed - lastCompletedCount);
    }
    lastCompletedCount = completed;
  } catch (err) {
    logger.error({ err }, '[metrics] completed commands query failed');
  }

  // Agent checkins (counter — proxy: count of devices that have ever checked
  // in, i.e. last_checkin IS NOT NULL). inc by positive delta only.
  try {
    const checkinResult = await pool.query(
      `SELECT COUNT(*)::int AS checkins FROM devices WHERE last_checkin IS NOT NULL`
    );
    const checkins = parseInt(checkinResult.rows[0]?.checkins, 10) || 0;
    if (lastCheckinCount === null) {
      agentCheckinsTotal.inc(checkins);
    } else if (checkins > lastCheckinCount) {
      agentCheckinsTotal.inc(checkins - lastCheckinCount);
    }
    lastCheckinCount = checkins;
  } catch (err) {
    logger.error({ err }, '[metrics] checkin count query failed');
  }

  // Stale devices — last_checkin older than 2x the default active poll
  // interval (300s * 2 = 600s = 10 minutes). Matches the health.js fleet
  // "stale" definition (> 2 minutes) loosely; here we use a conservative
  // 2x-poll threshold per the skill domain.
  try {
    const staleResult = await pool.query(
      `SELECT COUNT(*)::int AS stale
       FROM devices
       WHERE last_checkin IS NOT NULL
         AND last_checkin < NOW() - INTERVAL '10 minutes'`
    );
    staleDevicesTotal.set(parseInt(staleResult.rows[0]?.stale, 10) || 0);
  } catch (err) {
    logger.error({ err }, '[metrics] stale devices query failed');
  }
}

/**
 * GET / — Prometheus text-format metrics.
 *
 * No auth. Collects fresh DB-backed metrics on each scrape, then returns the
 * registry output in Prometheus exposition format.
 */
router.get('/', async (_req, res) => {
  try {
    await collectMetrics();
    const metrics = await registry.metrics();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics);
  } catch (err) {
    logger.error({ err }, '[metrics] failed to collect metrics');
    // Still return default metrics if possible, otherwise 500.
    try {
      const metrics = await registry.metrics();
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.status(500).send(metrics);
    } catch (_e) {
      res.status(500).send('# metrics collection failed\n');
    }
  }
});

module.exports = router;
