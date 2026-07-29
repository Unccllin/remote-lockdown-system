/**
 * Phase 13: Alert scheduler.
 *
 * Runs every 60s and checks for:
 *   1. Newly stale devices — devices whose last_checkin is older than 2x
 *      their poll interval. For each newly stale device:
 *        - insert an audit_log entry (event_type='health_alert')
 *        - fire sendNotification('device_stale', {deviceId, hostname, lastCheckin})
 *   2. Server health (DB connectivity). On DB degradation:
 *        - fire sendNotification('health_degraded', {reason})
 *
 * Reuses the retentionScheduler pattern: setInterval + start/stop functions.
 * Never throws — all errors are caught and logged so the scheduler keeps
 * running across transient failures.
 */

const pool = require('../db/pool');
const { sendNotification } = require('../notifications/notify');

const DEFAULT_INTERVAL_MS = 60 * 1000; // 60 seconds

// Default poll interval (seconds) used as the staleness baseline. The agent
// route sends adaptive poll intervals per status; here we use the active
// default (300s) as the reference. A device is "stale" when its last_checkin
// is older than 2x this baseline (10 minutes).
const DEFAULT_POLL_INTERVAL_SEC = 300;
const STALE_THRESHOLD_SEC = DEFAULT_POLL_INTERVAL_SEC * 2; // 600s = 10 minutes

let intervalId = null;
let runInFlight = null;

// Track device IDs we've already alerted about in this process so we don't
// spam audit_log / notifications on every tick for the same stale device.
// Cleared when a device checks in again (handled by re-querying each tick).
const alertedDeviceIds = new Set();

/**
 * Check for stale devices and fire alerts for newly stale ones.
 *
 * A device is stale when last_checkin IS NOT NULL and older than the stale
 * threshold (2x poll interval). Devices that have never checked in are not
 * alerted here (they're handled at enrollment time).
 *
 * @returns {Promise<{ staleDevices: Array, newAlerts: number }>}
 */
async function checkStaleDevices() {
  const staleResult = await pool.query(
    `SELECT id, hostname, last_checkin
     FROM devices
     WHERE last_checkin IS NOT NULL
       AND last_checkin < NOW() - INTERVAL '${STALE_THRESHOLD_SEC} seconds'
     ORDER BY last_checkin ASC`
  );

  const staleDevices = staleResult.rows || [];
  let newAlerts = 0;

  // Determine which stale devices are newly stale (not yet alerted).
  const currentStaleIds = new Set(staleDevices.map((d) => d.id));

  for (const device of staleDevices) {
    if (alertedDeviceIds.has(device.id)) {
      // Already alerted for this device — skip until it recovers.
      continue;
    }

    // Insert audit_log entry with event_type='health_alert'.
    try {
      const detail =
        typeof pool.query === 'function' && pool._isSqlite
          ? JSON.stringify({
              deviceId: device.id,
              hostname: device.hostname,
              lastCheckin: device.last_checkin,
              reason: 'stale_checkin',
            })
          : {
              deviceId: device.id,
              hostname: device.hostname,
              lastCheckin: device.last_checkin,
              reason: 'stale_checkin',
            };
      await pool.query(
        `INSERT INTO audit_log (device_id, action, detail)
         VALUES ($1, $2, $3)`,
        [device.id, 'health_alert', detail]
      );
    } catch (err) {
      console.error('[alerts] failed to write audit_log for stale device:', err.message);
    }

    // Fire notification (fire-and-forget, never throws).
    try {
      await sendNotification('device_stale', {
        deviceId: device.id,
        hostname: device.hostname,
        lastCheckin: device.last_checkin,
      });
    } catch (err) {
      console.error('[alerts] stale-device notification failed:', err.message);
    }

    alertedDeviceIds.add(device.id);
    newAlerts += 1;
  }

  // Clear alerts for devices that have recovered (checked in again).
  for (const id of [...alertedDeviceIds]) {
    if (!currentStaleIds.has(id)) {
      alertedDeviceIds.delete(id);
    }
  }

  return { staleDevices, newAlerts };
}

// Track DB health state so we only notify on transitions (ok -> degraded).
let dbDegraded = false;

/**
 * Check server health (DB connectivity). Notifies on transition to degraded.
 * @returns {Promise<{ ok: boolean }>}
 */
async function checkServerHealth() {
  try {
    await pool.query('SELECT 1');
    dbDegraded = false;
    return { ok: true };
  } catch (err) {
    if (!dbDegraded) {
      // Transition from ok -> degraded: notify.
      dbDegraded = true;
      try {
        await sendNotification('health_degraded', {
          reason: err.message,
        });
      } catch (notifyErr) {
        console.error('[alerts] health_degraded notification failed:', notifyErr.message);
      }
    }
    return { ok: false, error: err.message };
  }
}

/**
 * Run one alert-check cycle.
 * @returns {Promise<void>}
 */
async function runAlertCheck() {
  // Check DB health first — if DB is down, skip stale-device checks (they'd
  // just fail) but still attempt the health notification.
  const health = await checkServerHealth();
  if (!health.ok) {
    console.error('[alerts] DB unavailable — skipping stale-device check:', health.error);
    return;
  }

  await checkStaleDevices();
}

/**
 * Start the alert scheduler.
 * @param {number} intervalMs — override interval (for testing)
 * @returns {void}
 */
function startAlertScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) {
    console.warn('[alerts] Scheduler already started — ignoring');
    return;
  }

  // Run once immediately on startup, then on interval.
  runInFlight = runAlertCheck().catch((err) => {
    console.error('[alerts] Initial check failed:', err.message);
  }).finally(() => { runInFlight = null; });

  intervalId = setInterval(() => {
    runInFlight = runAlertCheck().catch((err) => {
      console.error('[alerts] Scheduled check failed:', err.message);
    }).finally(() => { runInFlight = null; });
  }, intervalMs);

  console.log(`[alerts] Scheduler started (interval: ${intervalMs}ms)`);
}

/**
 * Stop the alert scheduler.
 * @param {number} timeoutMs — max time to wait for in-flight run
 * @returns {Promise<void>}
 */
async function stopAlertScheduler(timeoutMs = 3000) {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[alerts] Scheduler stopped');
  }

  if (runInFlight) {
    console.log('[alerts] Waiting for in-flight check to complete...');
    await Promise.race([
      runInFlight,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    console.log('[alerts] In-flight check completed or timed out');
  }
}

module.exports = {
  startAlertScheduler,
  stopAlertScheduler,
  runAlertCheck,
  checkStaleDevices,
  checkServerHealth,
};
