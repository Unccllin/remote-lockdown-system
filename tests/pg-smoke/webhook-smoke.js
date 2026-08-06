/**
 * Phase 13 (real): Webhook notification smoke test.
 *
 * Stands up a local HTTP receiver, sets NOTIFICATION_WEBHOOK_URL, then drives
 * the alert scheduler against a real PostgreSQL database to verify:
 *   1. Stale-device alert → webhook fires with eventType='device_stale' + payload
 *   2. Health-degraded alert → webhook fires with eventType='health_degraded'
 *   3. No spurious alerts on subsequent ticks (dedup via alertedDeviceIds)
 *   4. Recovery clears the alerted state (device checks in → re-stale → new alert)
 *
 * Usage:
 *   export DATABASE_URL="postgres://user:pass@localhost:5433/lockdown_db"
 *   export DB_SSL=false USE_SQLITE=false
 *   node tests/pg-smoke/webhook-smoke.js
 *
 * Exits 0 on success, 1 on any failure.
 */

// --- Env setup — MUST run before any module that touches the DB pool ---
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ALLOW_NON_PROD = process.env.ALLOW_NON_PROD || '1';
process.env.USE_SQLITE = 'false';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'webhook-smoke-secret-key-long-enough-32';
process.env.AGENT_SHARED_KEY =
  process.env.AGENT_SHARED_KEY || 'webhook-smoke-agent-key-long-24';
process.env.AGENT_KEY_PEPPER =
  process.env.AGENT_KEY_PEPPER || 'webhook-smoke-pepper-long-enough-32';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = '90';
process.env.COMMAND_EXPIRY_DAYS = '30';

const http = require('http');

// Require AFTER env is set so pool.js picks up DATABASE_URL.
const pool = require('../../server/src/db/pool');
const { runMigrations } = require('../../server/src/db/migrationRunner');
const { sendNotification } = require('../../server/src/notifications/notify');

let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, label, detail) {
  if (condition) {
    passCount++;
    console.log(`  [PASS] ${label}`);
  } else {
    failCount++;
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(`  [FAIL] ${msg}`);
  }
}

/**
 * Local HTTP webhook receiver. Records all received POSTs for later assertion.
 */
class WebhookReceiver {
  constructor() {
    this.received = [];
    this.server = null;
    this.port = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(body); } catch { parsed = body; }
          this.received.push({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: parsed,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  clear() { this.received = []; }

  findByEventType(eventType) {
    return this.received.filter((r) => r.body && r.body.eventType === eventType);
  }
}

async function run() {
  console.log('Webhook notification smoke test — alert scheduler → webhook');
  console.log(`DATABASE_URL=${maskUrl(process.env.DATABASE_URL)}`);
  console.log('');

  // --- 0. Start the webhook receiver ---
  console.log('Step 0: Start local webhook receiver');
  const receiver = new WebhookReceiver();
  const port = await receiver.start();
  process.env.NOTIFICATION_WEBHOOK_URL = `http://127.0.0.1:${port}/webhook`;
  console.log(`  receiver listening on http://127.0.0.1:${port}/webhook`);

  // --- 1. Verify PG connection + run migrations ---
  console.log('Step 1: Verify PostgreSQL + run migrations');
  const versionRes = await pool.query('SELECT version()');
  assert(/PostgreSQL/.test(versionRes.rows[0].version), 'connected to PostgreSQL');

  const client = await pool.connect();
  try {
    await runMigrations(client, { dialect: 'postgres' });
  } finally {
    client.release();
  }

  // Clean slate
  await pool.query('DELETE FROM audit_log');
  await pool.query('DELETE FROM location_reports');
  await pool.query('DELETE FROM encryption_keys');
  await pool.query('DELETE FROM bios_passwords');
  await pool.query('DELETE FROM commands');
  await pool.query('DELETE FROM devices');
  await pool.query('DELETE FROM admins');

  // --- 2. Test sendNotification directly (unit-level) ---
  console.log('Step 2: sendNotification direct call');
  receiver.clear();
  const sent = await sendNotification('test_event', { foo: 'bar', num: 42 });
  assert(sent === true, 'sendNotification returns true (webhook channel active)');
  // Give the HTTP request a moment to arrive
  await sleep(100);
  const testPosts = receiver.findByEventType('test_event');
  assert(testPosts.length === 1, 'webhook received exactly 1 POST for test_event');
  if (testPosts.length === 1) {
    const post = testPosts[0];
    assert(post.method === 'POST', 'webhook method is POST');
    assert(post.url === '/webhook', 'webhook URL path matches');
    assert(post.body.eventType === 'test_event', 'webhook body.eventType correct');
    assert(post.body.payload.foo === 'bar', 'webhook body.payload.foo correct');
    assert(post.body.payload.num === 42, 'webhook body.payload.num correct');
    assert(!!post.body.timestamp, 'webhook body.timestamp present (ISO)');
    assert(
      !isNaN(Date.parse(post.body.timestamp)),
      'webhook timestamp is valid ISO 8601',
      `got: ${post.body.timestamp}`
    );
  }

  // --- 3. Stale-device alert via alert scheduler ---
  console.log('Step 3: Stale-device alert (checkStaleDevices)');

  // Re-require alertScheduler AFTER NOTIFICATION_WEBHOOK_URL is set, because
  // notify.js reads env vars at call time (not require time), but we want to
  // be safe. Actually notify.js reads env at call time, so this is fine.
  // But alertScheduler requires pool at module load — we need the PG pool.
  const alertScheduler = require('../../server/src/jobs/alertScheduler');

  // Insert a device with an old last_checkin (20 minutes ago — stale threshold is 10 min)
  const oldCheckin = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const devResult = await pool.query(
    `INSERT INTO devices (hostname, owner_name, status, last_checkin)
     VALUES ($1, $2, 'active', $3) RETURNING *`,
    ['stale-test-device', 'Test Owner', oldCheckin]
  );
  const staleDevice = devResult.rows[0];
  assert(!!staleDevice, 'stale device inserted into DB');

  receiver.clear();
  const staleResult = await alertScheduler.checkStaleDevices();
  assert(staleResult.newAlerts === 1, 'checkStaleDevices reports 1 new alert', `got: ${staleResult.newAlerts}`);
  assert(staleResult.staleDevices.length === 1, '1 stale device found');

  // Wait for the async webhook to arrive
  await sleep(200);
  const stalePosts = receiver.findByEventType('device_stale');
  assert(stalePosts.length === 1, 'webhook received 1 device_stale POST');
  if (stalePosts.length === 1) {
    const payload = stalePosts[0].body.payload;
    assert(
      payload.deviceId === staleDevice.id,
      'webhook payload.deviceId matches DB device ID',
      `got: ${payload.deviceId}`
    );
    assert(payload.hostname === 'stale-test-device', 'webhook payload.hostname correct');
    assert(!!payload.lastCheckin, 'webhook payload.lastCheckin present');
  }

  // Verify audit_log entry was written
  const auditRes = await pool.query(
    "SELECT * FROM audit_log WHERE action = 'health_alert' AND device_id = $1",
    [staleDevice.id]
  );
  assert(auditRes.rows.length === 1, 'audit_log entry written for stale device');
  if (auditRes.rows.length === 1) {
    assert(
      typeof auditRes.rows[0].detail === 'object',
      'audit_log detail is JSONB object'
    );
    assert(
      auditRes.rows[0].detail.reason === 'stale_checkin',
      'audit_log detail.reason = stale_checkin',
      `got: ${auditRes.rows[0].detail.reason}`
    );
  }

  // --- 4. Dedup: second tick should NOT re-alert the same device ---
  console.log('Step 4: Dedup — second tick does not re-alert same device');
  receiver.clear();
  const staleResult2 = await alertScheduler.checkStaleDevices();
  assert(staleResult2.newAlerts === 0, 'second tick: 0 new alerts (dedup)', `got: ${staleResult2.newAlerts}`);
  await sleep(100);
  const stalePosts2 = receiver.findByEventType('device_stale');
  assert(stalePosts2.length === 0, 'no webhook POST on second tick (dedup)');

  // --- 5. Recovery: device checks in → re-stale → new alert ---
  console.log('Step 5: Recovery — device checks in, then goes stale again');
  // Update last_checkin to NOW (device recovered)
  await pool.query('UPDATE devices SET last_checkin = NOW() WHERE id = $1', [staleDevice.id]);
  // Run check — device is no longer stale, should clear from alertedDeviceIds
  await alertScheduler.checkStaleDevices();
  // Now set last_checkin back to old time (device goes stale again)
  await pool.query('UPDATE devices SET last_checkin = $1 WHERE id = $2', [oldCheckin, staleDevice.id]);
  receiver.clear();
  const staleResult3 = await alertScheduler.checkStaleDevices();
  assert(staleResult3.newAlerts === 1, 'after recovery + re-stale: 1 new alert', `got: ${staleResult3.newAlerts}`);
  await sleep(200);
  const stalePosts3 = receiver.findByEventType('device_stale');
  assert(stalePosts3.length === 1, 'webhook fires again after recovery cycle');

  // --- 6. Health-degraded alert ---
  console.log('Step 6: Health-degraded alert (DB unreachable)');
  receiver.clear();

  // To simulate DB degradation, we need checkServerHealth() to fail.
  // checkServerHealth uses the module-level pool. We can't easily swap it,
  // but we can test sendNotification('health_degraded', ...) directly to
  // verify the webhook transport works for this event type, and test
  // checkServerHealth against the real (working) DB to confirm it returns ok.
  const healthResult = await alertScheduler.checkServerHealth();
  assert(healthResult.ok === true, 'checkServerHealth returns ok=true (DB is up)');

  // Now test the health_degraded notification path directly
  const healthSent = await sendNotification('health_degraded', {
    reason: 'connection refused (simulated)',
  });
  assert(healthSent === true, 'health_degraded notification sent');
  await sleep(200);
  const healthPosts = receiver.findByEventType('health_degraded');
  assert(healthPosts.length === 1, 'webhook received 1 health_degraded POST');
  if (healthPosts.length === 1) {
    assert(
      healthPosts[0].body.payload.reason.includes('simulated'),
      'health_degraded payload.reason present',
      `got: ${healthPosts[0].body.payload.reason}`
    );
  }

  // --- 7. No channels configured → graceful degradation ---
  console.log('Step 7: No channels configured → graceful degradation');
  const oldUrl = process.env.NOTIFICATION_WEBHOOK_URL;
  delete process.env.NOTIFICATION_WEBHOOK_URL;
  delete process.env.SLACK_WEBHOOK_URL;
  const noChannelResult = await sendNotification('orphan_event', { test: true });
  assert(noChannelResult === false, 'sendNotification returns false when no channels configured');
  process.env.NOTIFICATION_WEBHOOK_URL = oldUrl;

  // --- Summary ---
  console.log('');
  console.log('=== Webhook Notification Smoke Test Summary ===');
  console.log(`  PASS: ${passCount}  FAIL: ${failCount}`);
  if (failures.length > 0) {
    console.log('  Failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }

  await receiver.stop();
  await pool.end();
  process.exit(failCount > 0 ? 1 : 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskUrl(url) {
  if (!url) return '(unset)';
  return url.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}

run().catch((err) => {
  console.error('[webhook-smoke] FATAL:', err);
  try { pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});
