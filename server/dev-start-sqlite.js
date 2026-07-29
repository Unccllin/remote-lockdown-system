/**
 * Dev startup script — uses SQLite (in-process, via `sqlite3` native module)
 * instead of a real PostgreSQL server.
 *
 * This is the precursor to the Electron admin app, which uses the same
 * SQLite pool. Mounts the same routes as src/index.js (production).
 *
 * Usage: node dev-start-sqlite.js
 *        SQLITE_PATH=/path/to/db.sqlite node dev-start-sqlite.js
 *        SQLITE_PATH=:memory: node dev-start-sqlite.js
 */

// Set env defaults BEFORE requiring anything else
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.AGENT_SHARED_KEY = process.env.AGENT_SHARED_KEY || 'dev-agent-shared-key-not-a-placeholder-24';
process.env.AGENT_KEY_PEPPER = process.env.AGENT_KEY_PEPPER || 'dev-pepper-key-not-a-placeholder-32';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-not-a-placeholder-32';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
process.env.USE_SQLITE = 'true';
// Default to file-based DB (persists between restarts, unlike :memory:)
process.env.SQLITE_PATH = process.env.SQLITE_PATH || './.sqlite-data/lockdown-dev.db';

// Override the pool module to use SQLite
const sqlitePool = require('./src/db/sqlitePool');
require.cache[require.resolve('./src/db/pool')] = {
  exports: sqlitePool,
  id: require.resolve('./src/db/pool'),
  filename: require.resolve('./src/db/pool'),
  loaded: true,
};

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { runMigrations } = require('./src/db/migrationRunner');
const { validateEnv } = require('./src/config/env');

// Validate env in dev mode (relaxed length floors, but still rejects placeholders)
validateEnv({ dev: true });

// Helper: generate a UUID (SQLite doesn't have gen_random_uuid at runtime,
// only in migrations via the translateSql layer)
function uuid() {
  return crypto.randomUUID();
}

async function runMigrationsOnSqlite(pool) {
  console.log('Running migrations on SQLite...');
  await runMigrations(pool, { dialect: 'sqlite' });
  console.log('Migrations complete.');
}

async function seedData(pool) {
  // Check if already seeded
  const adminCheck = await pool.query('SELECT COUNT(*) as count FROM admins');
  if (parseInt(adminCheck.rows[0].count) > 0) {
    console.log('Data already seeded, skipping.');
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
      // SQLite: datetime('now', '-N seconds') instead of NOW() - interval
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

async function main() {
  const pool = sqlitePool;

  try {
    await runMigrationsOnSqlite(pool);
    await seedData(pool);
  } catch (err) {
    console.error('Setup failed:', err.message);
    // Continue anyway — tables might already exist
  }

  // Now start the server
  const express = require('express');
  const helmet = require('helmet');
  const cors = require('cors');
  const rateLimit = require('express-rate-limit');
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

  app.use('/api/auth', require('./src/routes/auth'));
  app.use('/api/devices', require('./src/routes/devices'));
  app.use('/api/agent', require('./src/routes/agent'));
  app.use('/api/audit', require('./src/routes/audit'));
  app.use('/api/setup', require('./src/routes/setup'));
  app.use('/api/installer', require('./src/routes/installer'));
  app.use('/api/admins', require('./src/routes/admins'));
  app.use('/api/health', require('./src/routes/health'));
  app.use('/metrics', require('./src/routes/metrics'));

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`  Server running on http://localhost:${PORT}`);
    console.log(`  Database: SQLite (${process.env.SQLITE_PATH})`);
    console.log(`  Health:   http://localhost:${PORT}/api/health`);
    console.log(`========================================`);
    console.log(`\n  Login: admin / admin123`);
    console.log(`  Dashboard: http://localhost:5173\n`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
