/**
 * server-starter.js — starts the Express server in-process within Electron.
 *
 * This module is loaded by the Electron main process. It:
 *   1. Sets environment variables (dev defaults if not set)
 *   2. Overrides the DB pool to use SQLite (sqlitePool.js)
 *   3. Runs database migrations
 *   4. Starts the Express server on the configured port
 *   5. Serves the built dashboard from dashboard/dist/
 *
 * The server uses the same route modules as the standalone server,
 * so behavior is identical between dev, production, and Electron modes.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// --- Module resolution ---
// The Electron app lives in electron/ but needs to require modules from
// server/node_modules (express, helmet, cors, etc.). We use Module.createRequire
// to create a require function rooted at the server directory, so all module
// resolution happens as if we were running from inside the server directory.
const serverDir = path.join(__dirname, '..', 'server');
const Module = require('module');
const requireFromServer = Module.createRequire
  ? Module.createRequire(path.join(serverDir, 'package.json'))
  : require; // fallback for older Node.js

// --- Environment setup ---
// In production, these are set by the first-run setup. In dev, use defaults.
function setupEnv(isDev) {
  process.env.NODE_ENV = isDev ? 'development' : 'production';

  // Security keys — in production these are generated on first run and
  // stored in the user data directory. In dev, use fixed defaults.
  if (isDev) {
    process.env.AGENT_SHARED_KEY = process.env.AGENT_SHARED_KEY || 'dev-agent-shared-key-not-a-placeholder-24';
    process.env.AGENT_KEY_PEPPER = process.env.AGENT_KEY_PEPPER || 'dev-pepper-key-not-a-placeholder-32';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-not-a-placeholder-32';
    process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
    process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
    process.env.ALLOW_NON_PROD = '1';
  }

  process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
  process.env.USE_SQLITE = 'true';

  // SQLite database path — store in Electron's userData directory
  // (set by main.js before requiring this module)
  if (!process.env.SQLITE_PATH) {
    throw new Error('SQLITE_PATH must be set before starting server');
  }

  // User data directory — used by installer.js for caching cross-platform
  // agent binaries downloaded from GitHub Releases
  // Derive from SQLITE_PATH (both are in userData directory)
  if (!process.env.USER_DATA_DIR) {
    process.env.USER_DATA_DIR = path.dirname(path.dirname(process.env.SQLITE_PATH));
  }

  // Server port — use 0 to let the OS pick an available port
  process.env.PORT = process.env.PORT || '0';
}

// --- Database setup ---
async function setupDatabase() {
  const sqlitePool = require('../server/src/db/sqlitePool');
  const { runMigrations } = require('../server/src/db/migrationRunner');

  // Override the pool module so all route modules use SQLite
  const poolPath = require.resolve('../server/src/db/pool');
  require.cache[poolPath] = {
    exports: sqlitePool,
    id: poolPath,
    filename: poolPath,
    loaded: true,
  };

  console.log('[server-starter] Running SQLite migrations...');
  await runMigrations(sqlitePool, { dialect: 'sqlite' });
  console.log('[server-starter] Migrations complete.');

  return sqlitePool;
}

// --- Seed initial admin (first run only) ---
async function seedInitialAdmin(pool, username, password) {
  const bcrypt = requireFromServer('bcryptjs');
  const adminCheck = await pool.query('SELECT COUNT(*) as count FROM admins');
  if (parseInt(adminCheck.rows[0].count) > 0) {
    return false; // already seeded
  }

  const hash = bcrypt.hashSync(password, 10);
  await pool.query(
    'INSERT INTO admins (id, username, password_hash) VALUES ($1, $2, $3)',
    [crypto.randomUUID(), username, hash]
  );
  console.log(`[server-starter] Created initial admin: ${username}`);
  return true;
}

// --- Express server ---
async function startServer(options = {}) {
  const { isDev = false, dashboardDistPath = null } = options;

  setupEnv(isDev);
  const pool = await setupDatabase();

  // Seed initial admin if requested
  if (options.initialAdmin) {
    await seedInitialAdmin(pool, options.initialAdmin.username, options.initialAdmin.password);
  }

  const express = requireFromServer('express');
  const helmet = requireFromServer('helmet');
  const cors = requireFromServer('cors');
  const rateLimit = requireFromServer('express-rate-limit');
  const app = express();

  // Security middleware
  // Note: helmet is relaxed for Electron (same-origin, no external requests)
  app.use(helmet({
    contentSecurityPolicy: false, // Electron manages CSP separately
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(express.json());
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));

  // API routes
  app.use('/api/auth', require('../server/src/routes/auth'));
  app.use('/api/devices', require('../server/src/routes/devices'));
  app.use('/api/agent', require('../server/src/routes/agent'));
  app.use('/api/audit', require('../server/src/routes/audit'));
  app.use('/api/setup', require('../server/src/routes/setup'));
  app.use('/api/installer', require('../server/src/routes/installer'));

  // Health check
  app.get('/api/health', async (req, res) => {
    if (req.headers['x-agent-key']) {
      return res.status(400).json({ error: 'Health endpoint is not for agent use' });
    }
    try {
      await pool.query('SELECT 1');
      res.json({
        status: 'ok',
        db: 'sqlite',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        status: 'degraded',
        db: 'disconnected',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Serve built dashboard (production mode)
  if (dashboardDistPath && fs.existsSync(dashboardDistPath)) {
    const indexPath = path.resolve(dashboardDistPath, 'index.html');
    app.use(express.static(dashboardDistPath));
    // SPA fallback: serve index.html for any non-API route
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(indexPath);
    });
  }

  // Error handler
  app.use((err, req, res, _next) => {
    console.error('[server-starter] Express error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start listening — port 0 means OS picks an available port
  const port = parseInt(process.env.PORT || '0');
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const actualPort = server.address().port;
      console.log(`[server-starter] Server running on http://localhost:${actualPort}`);
      resolve({ server, port: actualPort, pool });
    });
    server.on('error', reject);
  });
}

module.exports = { startServer, setupEnv, setupDatabase };
