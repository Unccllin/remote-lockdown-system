/**
 * FA5: Location data retention scheduler.
 *
 * Periodically deletes location_reports older than LOCATION_RETENTION_DAYS
 * (default 90, hard ceiling 180). Uses pg_advisory_lock to ensure only
 * one instance runs the purge across multiple server instances.
 *
 * CC13: Configurable retention period, validated by FA6's validateEnv().
 *
 * The scheduler is started by index.js and stopped during graceful shutdown
 * (before pool.end() to avoid racing the shutdown).
 *
 * Each run writes an audit_log entry with the number of rows deleted.
 */

const pool = require('../db/pool');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ADVISORY_LOCK_KEY = 54321; // arbitrary fixed key for retention job

let intervalId = null;
let runInFlight = null;

/**
 * Run the retention purge once.
 * Uses pg_advisory_lock to ensure single-instance execution.
 * @returns {Promise<{rowsDeleted: number}>}
 */
async function runRetentionPurge() {
  const retentionDays = parseInt(process.env.LOCATION_RETENTION_DAYS || '90', 10);
  const client = await pool.connect();

  try {
    // Try to acquire an advisory lock — non-blocking
    // If another instance is already running the purge, skip.
    //
    // On PostgreSQL/PGlite: pg_try_advisory_lock returns a boolean column.
    // On SQLite: the SQL is translated to SELECT 1, so the result column
    // is named '1' (or 'pg_try_advisory_lock' is absent). SQLite is
    // single-process, so the JS-level runInFlight guard already prevents
    // concurrent runs within the same process — the advisory lock is only
    // needed for multi-process Postgres deployments. If the column is
    // absent, treat the lock as acquired.
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    const lockAcquired = lockResult.rows[0].pg_try_advisory_lock !== false &&
                         lockResult.rows[0].pg_try_advisory_lock !== 0;
    if (!lockAcquired) {
      console.log('[retention] Another instance is running the purge — skipping');
      return { rowsDeleted: 0, skipped: true };
    }

    // Delete location reports older than the retention period
    const deleteResult = await client.query(
      `DELETE FROM location_reports
       WHERE reported_at < NOW() - INTERVAL '${retentionDays} days'
       RETURNING id`
    );

    const rowsDeleted = deleteResult.rowCount || 0;

    // Write audit log entry
    if (rowsDeleted > 0) {
      // SQLite doesn't accept JS objects as JSON parameters — stringify.
      const detail = typeof pool.query === 'function' && pool._isSqlite
        ? JSON.stringify({ rowsDeleted, retentionDays })
        : { rowsDeleted, retentionDays };
      await client.query(
        `INSERT INTO audit_log (action, detail)
         VALUES ($1, $2)`,
        ['retention_purge', detail]
      );
    }

    console.log(`[retention] Purged ${rowsDeleted} location reports older than ${retentionDays} days`);
    return { rowsDeleted, skipped: false };
  } finally {
    // Release the advisory lock
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Start the retention scheduler.
 * @param {number} intervalMs — override interval (for testing)
 * @returns {void}
 */
function startScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) {
    console.warn('[retention] Scheduler already started — ignoring');
    return;
  }

  // Run once immediately on startup, then on interval
  runInFlight = runRetentionPurge().catch((err) => {
    console.error('[retention] Initial purge failed:', err.message);
  }).finally(() => { runInFlight = null; });

  intervalId = setInterval(() => {
    runInFlight = runRetentionPurge().catch((err) => {
      console.error('[retention] Scheduled purge failed:', err.message);
    }).finally(() => { runInFlight = null; });
  }, intervalMs);

  console.log(`[retention] Scheduler started (interval: ${intervalMs}ms, retention: ${process.env.LOCATION_RETENTION_DAYS || 90} days)`);
}

/**
 * Stop the retention scheduler.
 * Waits for any in-flight run to complete (with a timeout).
 * @param {number} timeoutMs — max time to wait for in-flight run
 * @returns {Promise<void>}
 */
async function stopScheduler(timeoutMs = 3000) {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[retention] Scheduler stopped');
  }

  // Wait for any in-flight run to complete
  if (runInFlight) {
    console.log('[retention] Waiting for in-flight purge to complete...');
    await Promise.race([
      runInFlight,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    console.log('[retention] In-flight purge completed or timed out');
  }
}

module.exports = { startScheduler, stopScheduler, runRetentionPurge };
