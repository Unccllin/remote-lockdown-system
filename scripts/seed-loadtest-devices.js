/**
 * seed-loadtest-devices.js — Bulk-insert devices for k6 load testing.
 *
 * Inserts N devices with hostnames matching the k6 script pattern
 * (load-test-device-XXXXX) directly into the SQLite DB, without
 * api_key_hash so they authenticate via the AGENT_SHARED_KEY fallback.
 *
 * Usage:
 *   node scripts/seed-loadtest-devices.js [--count N] [--commands]
 *
 * Options:
 *   --count N         Number of devices to insert (default 200)
 *   --commands        Also enqueue a pending 'lockdown' command for each device
 *   --db PATH         SQLite DB path (default: server/.sqlite-data/lockdown-loadtest.db)
 *   --hmac-secret S   Give each device a per-device API key derived from S, so the
 *                     k6 scripts can sign requests with HMAC. Must equal the
 *                     scripts' K6_HMAC_SECRET. Default is no key (devices fall
 *                     back to the shared AGENT_SHARED_KEY) — see
 *                     tests/load/lib/sign.js for the derivation.
 *
 * With --hmac-secret the server must also run with REQUIRE_HMAC=true, and
 * AGENT_KEY_PEPPER must be set here (it is the pepper the server hashes keys
 * with, so the stored hash is only valid for that pepper).
 */
const path = require('path');
const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

async function main() {
  const args = process.argv.slice(2);
  let count = 200;
  let enqueueCommands = false;
  let hmacSecret = null;
  let dbPath = path.join(__dirname, '..', 'server', '.sqlite-data', 'lockdown-loadtest.db');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) { count = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--commands') { enqueueCommands = true; }
    else if (args[i] === '--hmac-secret' && args[i + 1]) { hmacSecret = args[i + 1]; i++; }
    else if (args[i] === '--db' && args[i + 1]) { dbPath = args[i + 1]; i++; }
  }

  // Set env before requiring sqlitePool
  process.env.SQLITE_PATH = dbPath;
  process.env.USE_SQLITE = 'true';

  const pool = require('../server/src/db/sqlitePool');
  // Use the server's own key hashing so the pepper logic cannot drift.
  const { hashApiKey } = require('../server/src/db/apiKey');

  console.log(`Seeding ${count} load-test devices into ${dbPath}...`);

  // Check if devices already exist
  const existing = await pool.query(
    "SELECT COUNT(*) as cnt FROM devices WHERE hostname LIKE 'load-test-device-%'"
  );
  const existingCount = existing.rows[0].cnt;
  if (existingCount > 0) {
    console.log(`Found ${existingCount} existing load-test devices. Deleting them first...`);
    // Delete related commands first (FK constraint)
    await pool.query(
      "DELETE FROM commands WHERE device_id IN (SELECT id FROM devices WHERE hostname LIKE 'load-test-device-%')"
    );
    await pool.query("DELETE FROM devices WHERE hostname LIKE 'load-test-device-%'");
  }

  // Bulk-insert devices
  let inserted = 0;
  const batchSize = 50;
  for (let batch = 0; batch < count; batch += batchSize) {
    const batchEnd = Math.min(batch + batchSize, count);
    for (let i = batch; i < batchEnd; i++) {
      const vuId = i + 1; // k6 VU IDs start at 1
      const idx = String(vuId).padStart(5, '0');
      const hostname = `load-test-device-${idx}`;
      // Match k6-baseline.js checkinPayload(vuId) exactly:
      const mac = `02:00:00:${String((vuId >> 16) & 0xff).padStart(2, '0')}:${String((vuId >> 8) & 0xff).padStart(2, '0')}:${String(vuId & 0xff).padStart(2, '0')}`;
      const hwuuid = `00000000-0000-4000-8000-${String(vuId).padStart(12, '0')}`;
      // Derived per-device key (see tests/load/lib/sign.js — the k6 side
      // computes the same string). Only the hash is stored, exactly as a real
      // enrollment would: HMAC-SHA256(AGENT_KEY_PEPPER, key).
      let apiKeyHash = null;
      if (hmacSecret) {
        const apiKey = crypto.createHmac('sha256', hmacSecret).update(hostname).digest('base64');
        apiKeyHash = hashApiKey(apiKey);
      }
      await pool.query(
        'INSERT INTO devices (id, hostname, mac_address, hardware_uuid, owner_name, status, api_key_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), hostname, mac, hwuuid, 'Load Test', 'active', apiKeyHash]
      );
      inserted++;
    }
  }
  console.log(`Inserted ${inserted} devices.`);

  // Optionally enqueue lockdown commands
  if (enqueueCommands) {
    console.log('Enqueuing pending lockdown commands for each device...');
    const devices = await pool.query(
      "SELECT id FROM devices WHERE hostname LIKE 'load-test-device-%'"
    );
    let cmdCount = 0;
    for (const dev of devices.rows) {
      await pool.query(
        `INSERT INTO commands (id, device_id, command_type, status, created_at)
         VALUES (?, ?, 'lockdown', 'pending', datetime('now'))`,
        [uuid(), dev.id]
      );
      cmdCount++;
    }
    console.log(`Enqueued ${cmdCount} pending lockdown commands.`);
  }

  // Verify
  const finalCount = await pool.query(
    "SELECT COUNT(*) as cnt FROM devices WHERE hostname LIKE 'load-test-device-%'"
  );
  console.log(`Verification: ${finalCount.rows[0].cnt} load-test devices in DB.`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
