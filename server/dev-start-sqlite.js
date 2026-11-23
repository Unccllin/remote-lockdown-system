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

// One path for every launch: dbPath.js resolves from the server directory, not
// the cwd, so starting this script from the repo root no longer forks a new
// database at <cwd>/.sqlite-data/ and (worse) seeds a second `admin` into it.
const { resolveDbPath } = require('./src/db/dbPath');
const fs = require('fs');
const resolvedDbPath = resolveDbPath();
// Seeding is only safe on a database this run is creating. An existing-but-empty
// DB is a state worth preserving, not an invitation to mint another super-admin.
const isFreshDatabase = resolvedDbPath === ':memory:' || !fs.existsSync(resolvedDbPath);
process.env.SQLITE_PATH = resolvedDbPath;

// Override the pool module to use SQLite
const sqlitePool = require('./src/db/sqlitePool');
require.cache[require.resolve('./src/db/pool')] = {
  exports: sqlitePool,
  id: require.resolve('./src/db/pool'),
  filename: require.resolve('./src/db/pool'),
  loaded: true,
};

const { runMigrations } = require('./src/db/migrationRunner');
const { seedData } = require('./src/db/seedDevData');
const { validateEnv } = require('./src/config/env');

// Validate env in dev mode (relaxed length floors, but still rejects placeholders)
validateEnv({ dev: true });

async function runMigrationsOnSqlite(pool) {
  console.log('Running migrations on SQLite...');
  await runMigrations(pool, { dialect: 'sqlite' });
  console.log('Migrations complete.');
}

async function main() {
  const pool = sqlitePool;

  try {
    await runMigrationsOnSqlite(pool);
    await seedData(pool, { isFreshDatabase });
  } catch (err) {
    console.error('Setup failed:', err.message);
    // Continue anyway — tables might already exist
  }

  // Now start the server
  const express = require('express');
  const fs = require('fs');
  const path = require('path');
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
  // Rate limit — configurable for load testing (set RATE_LIMIT_MAX=0 to disable)
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '200', 10);
  if (rateLimitMax > 0) {
    app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: rateLimitMax }));
  }

  app.use('/api/auth', require('./src/routes/auth'));
  app.use('/api/devices', require('./src/routes/devices'));
  app.use('/api/agent', require('./src/routes/agent'));
  app.use('/api/audit', require('./src/routes/audit'));
  app.use('/api/setup', require('./src/routes/setup'));
  app.use('/api/installer', require('./src/routes/installer'));
  app.use('/api/admins', require('./src/routes/admins'));
  app.use('/api/health', require('./src/routes/health'));
  app.use('/metrics', require('./src/routes/metrics'));

  // Serve the built dashboard when it exists. The production entry (src/index.js) has done
  // this since the prod-stack bug where the image built dashboard/dist and served none of it;
  // this scaffold did not, so `npm run dev`-style demos could exercise the API but never the
  // UI, and the two entries disagreed about what "the server" serves (S300). Same cache rules
  // as src/index.js: hashed assets immutable, index.html never cached.
  const dashboardDistPath = path.join(__dirname, '..', 'dashboard', 'dist');
  if (fs.existsSync(dashboardDistPath)) {
    const indexPath = path.resolve(dashboardDistPath, 'index.html');
    app.use(express.static(dashboardDistPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/metrics') return next();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(indexPath);
    });
    console.log('  Dashboard: served from dashboard/dist');
  }

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const PORT = process.env.PORT || 3001;
  app.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`  Server running on http://localhost:${PORT}`);
    console.log(`  Database: SQLite (${process.env.SQLITE_PATH})`);
    console.log(`  Fresh:    ${isFreshDatabase ? 'yes (created and seeded this run)' : 'no (existing data kept)'}`);
    console.log(`  Health:   http://localhost:${PORT}/api/health`);
    console.log(`========================================`);

    // "Which database, and who can log into it" should be answerable in one
    // glance — that question was the whole problem with admins scattered across
    // several files.
    try {
      const admins = await pool.query('SELECT username, role FROM admins ORDER BY created_at');
      if (admins.rows.length) {
        console.log(`\n  Admin accounts (${admins.rows.length}):`);
        for (const admin of admins.rows) console.log(`    - ${admin.username} (${admin.role})`);
      } else {
        console.log('\n  Admin accounts: none — create one via POST /api/setup/create-admin');
      }
    } catch (err) {
      console.log(`\n  Admin accounts: unavailable (${err.message})`);
    }

    if (isFreshDatabase) console.log(`\n  Seeded login: admin / admin123`);
    console.log(`  Dashboard: http://localhost:5173\n`);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
