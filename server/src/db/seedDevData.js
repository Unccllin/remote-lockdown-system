/**
 * Dev seeding for the SQLite development database.
 *
 * Extracted from `dev-start-sqlite.js` so the seed/refusal guard can be
 * regression-tested without booting a long-lived server. The behaviour is
 * identical to the previous inline copy; only the module boundary moved.
 *
 * The guard that matters: an existing database with no admin accounts is NOT
 * seeded with a demo super-admin (well-known password). See seedData().
 */

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

async function seedData(pool, { isFreshDatabase: fresh = true } = {}) {
  // Check if already seeded
  const adminCheck = await pool.query('SELECT COUNT(*) as count FROM admins');
  const existingAdmins = parseInt(adminCheck.rows[0].count, 10);
  if (existingAdmins > 0) {
    console.log(`Data already seeded, skipping (${existingAdmins} admin account${existingAdmins === 1 ? '' : 's'} present).`);
    return;
  }

  // An existing database with no admins means something outside a clean first run
  // made it: an interrupted setup, a schema-only restore, a manual `touch`. Seeding
  // it hands out a super-admin with a well-known password, on a database nobody
  // asked to reset. Refuse, and point at the supported ways forward instead.
  if (!fresh) {
    console.warn('Not seeding: this database already existed and has no admin accounts.');
    console.warn('  Create the first admin via POST /api/setup/create-admin,');
    console.warn(`  or delete ${process.env.SQLITE_PATH} to get a fresh demo seed.`);
    return;
  }

  console.log('Seeding demo data...');

  // Create admin user (super-admin role)
  const hash = bcrypt.hashSync('admin123', 10);
  await pool.query(
    'INSERT INTO admins (id, username, password_hash, role) VALUES ($1, $2, $3, $4)',
    [uuid(), 'admin', hash, 'super-admin']
  );

  // Create demo devices
  const devices = [
    { hostname: 'LAPTOP-ALPHA', owner_name: 'Alice Chen', status: 'active' },
    { hostname: 'LAPTOP-BRAVO', owner_name: 'Bob Martinez', status: 'active' },
    { hostname: 'LAPTOP-CHARLIE', owner_name: 'Charlie Kim', status: 'tracking' },
    { hostname: 'LAPTOP-DELTA', owner_name: 'Diana Patel', status: 'stolen' },
    { hostname: 'LAPTOP-ECHO', owner_name: 'Eric Wong', status: 'locked' },
  ];

  for (const d of devices) {
    await pool.query(
      'INSERT INTO devices (id, hostname, owner_name, status) VALUES ($1, $2, $3, $4)',
      [uuid(), d.hostname, d.owner_name, d.status]
    );
  }

  // Add location history for tracking device
  const trackingDev = await pool.query("SELECT * FROM devices WHERE hostname = 'LAPTOP-CHARLIE'");
  if (trackingDev.rows[0]) {
    const devId = trackingDev.rows[0].id;
    const locations = [
      { lat: 37.7749, lng: -122.4194, city: 'San Francisco', region: 'CA', country: 'US', source: 'wifi', acc: 15, ago: 3600 },
      { lat: 37.7849, lng: -122.4094, city: 'San Francisco', region: 'CA', country: 'US', source: 'wifi', acc: 10, ago: 1800 },
      { lat: 37.7649, lng: -122.4294, city: 'San Francisco', region: 'CA', country: 'US', source: 'wifi', acc: 20, ago: 300 },
    ];
    for (const loc of locations) {
      await pool.query(
        `INSERT INTO location_reports (id, device_id, latitude, longitude, accuracy_meters, source, city, region, country, reported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, datetime('now', '-' || $10 || ' seconds'))`,
        [uuid(), devId, loc.lat, loc.lng, loc.acc, loc.source, loc.city, loc.region, loc.country, String(loc.ago)]
      );
    }
  }

  // Add audit log entries
  const auditDev = await pool.query("SELECT * FROM devices WHERE hostname = 'LAPTOP-DELTA'");
  const adminRes = await pool.query("SELECT * FROM admins WHERE username = 'admin'");
  if (auditDev.rows[0] && adminRes.rows[0]) {
    await pool.query(
      'INSERT INTO audit_log (id, device_id, admin_id, action, detail) VALUES ($1, $2, $3, $4, $5)',
      [uuid(), auditDev.rows[0].id, adminRes.rows[0].id, 'flag_stolen', JSON.stringify({ reason: 'Reported stolen by IT' })]
    );
  }

  console.log('Demo data seeded:');
  console.log('  Admin login: admin / admin123');
  console.log('  5 devices (active, tracking, stolen, locked)');
  console.log('  Location history for tracking device');
}

module.exports = { seedData };
