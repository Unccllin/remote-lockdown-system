require('express-async-errors');
require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv(); // CC2/CC11: fail fast on bad config before anything else loads
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const devicesRoutes = require('./routes/devices');
const agentRoutes = require('./routes/agent');
const auditRoutes = require('./routes/audit');
const installerRoutes = require('./routes/installer');
const setupRoutes = require('./routes/setup');
const healthRoutes = require('./routes/health');
const metricsRoutes = require('./routes/metrics');
const adminsRoutes = require('./routes/admins');
const { startAlertScheduler } = require('./jobs/alertScheduler');

const app = express();

// Trust proxy headers (X-Forwarded-For, X-Forwarded-Proto) when running behind
// a reverse proxy (Caddy, Nginx, etc.). Without this, express-rate-limit can't
// identify clients correctly and throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
// 'loopback' trusts only localhost proxies (safe for single-proxy deployments).
// For multi-proxy setups, use a specific number (e.g. 1) or CIDR range.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use(helmet());

// CORS: only enable when CORS_ORIGIN is explicitly set (e.g., dev with Vite
// on port 5173). In production the dashboard is served from the same origin,
// so CORS is unnecessary and is omitted for a tighter security posture.
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN }));
}

// Phase 0: capture raw body for HMAC signature verification.
// express.json() parses the body but we also need the raw bytes to compute
// the SHA-256 hash for HMAC. The verify hook runs before parsing — we stash
// the raw body on req.rawBody.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

// Per-route rate limiters — different endpoints have different threat models:
//
//   authLimiter:      /api/auth/* — strict (200 req/15min per IP)
//                     Protects login from brute-force / credential stuffing.
//                     A human admin logs in once; automated attempts get blocked.
//
//   dashboardLimiter: /api/devices, /api/audit, /api/admins, /api/installer
//                     — moderate (2000 req/15min per IP)
//                     Read-heavy dashboard endpoints accessed by admins and
//                     monitoring tools. 2000/15min = ~2 req/s sustained, enough
//                     for a dashboard auto-refreshing every 5s + manual browsing.
//
//   agentLimiter:     /api/agent/* — per-device (600 req/15min per device)
//                     Agents poll every 30s; 600/15min = 40/min headroom for
//                     retries + command acks. Keyed on device ID or shared-key
//                     + hostname to give each device its own bucket.
//
// Health endpoints (/api/health, /metrics) are not rate-limited — they're
// used by Docker/Caddy health checks and Prometheus scraping, which need
// reliable access regardless of traffic patterns.

// Strict limiter for auth endpoints (brute-force protection).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  message: { error: 'Too many login attempts — please try again later' },
});

// Moderate limiter for dashboard/API endpoints (read-heavy, admin-paced).
const dashboardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  message: { error: 'Too many requests — please slow down' },
});

// Per-device limiter for agent endpoints.
// When devices share a legacy AGENT_SHARED_KEY, the key alone would collapse
// all devices into one rate-limit bucket. To prevent that, we also include
// the hostname from the request body (available because express.json() runs
// before route-level middleware) in the key when a shared key is used.
const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600, // 600 req / 15 min per device (40/min — enough for 30s polling + retries)
  keyGenerator: (req) => {
    // Prefer per-device ID (set by agentAuth middleware on later routes)
    if (req.device?.id) return req.device.id;
    // Pre-auth: use x-agent-key + hostname to distinguish devices sharing a key
    const agentKey = req.headers['x-agent-key'] || req.ip;
    const hostname = req.body?.hostname;
    return hostname ? `${agentKey}:${hostname}` : agentKey;
  },
  standardHeaders: true,
  message: { error: 'Too many agent requests — rate limited per device' },
});

// Apply limiters per route group.
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/setup', authLimiter, setupRoutes); // setup is one-time, keep strict
app.use('/api/devices', dashboardLimiter, devicesRoutes);
app.use('/api/agent', agentLimiter, agentRoutes);
app.use('/api/audit', dashboardLimiter, auditRoutes);
app.use('/api/installer', dashboardLimiter, installerRoutes);
app.use('/api/health', healthRoutes); // No rate limit — health checks
app.use('/metrics', metricsRoutes);    // No rate limit — Prometheus scraping
app.use('/api/admins', dashboardLimiter, adminsRoutes);

app.get('/api/health', async (req, res) => {
  // FA6: Extended health check — DB probe + scheduler status
  // Reject agent-key probing: this endpoint is for infrastructure monitoring,
  // not for agents to probe. No x-agent-key header expected.
  if (req.headers['x-agent-key']) {
    return res.status(400).json({ error: 'Health endpoint is not for agent use' });
  }

  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      scheduler: intervalIdActive ? 'running' : 'stopped',
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

// --- Static dashboard serving + SPA fallback ---
// Serves the built Vite SPA from the same Express process as the API.
// This merges frontend + backend into one origin, eliminating CORS config
// and ensuring the dashboard loads even when the DB is down (static files
// are filesystem-based, independent of DB state — the React app handles
// API failures via error toasts).
//
// Path resolution: from server/src/ this reaches repo-root/dashboard/dist.
// In the Docker image (WORKDIR /app) it resolves to /app/dashboard/dist.
const dashboardDistPath = path.join(__dirname, '../../dashboard/dist');

if (fs.existsSync(dashboardDistPath)) {
  const indexPath = path.resolve(dashboardDistPath, 'index.html');

  // Hashed assets (assets/*) get immutable 1-year caching — filenames change
  // on content change, so stale caches never serve wrong content.
  // index.html is never cached so users always get the latest asset hashes.
  app.use(express.static(dashboardDistPath, {
    index: false, // don't auto-serve index.html — SPA fallback handles it
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA fallback: serve index.html for any non-API, non-metrics route.
  // This supports client-side routing (react-router) — e.g., /devices/123
  // loads index.html which boots React and renders the right page.
  // Excludes /api/* (returns 404 JSON above) and /metrics (Prometheus endpoint).
  // index.html is never cached so users always get the latest asset hashes.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/metrics') return next();
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(indexPath);
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[startup] dashboard/dist not found — dashboard will not be served.');
  console.warn(`[startup] looked for: ${dashboardDistPath}`);
}

// 404 JSON for unmatched API routes — prevents API clients from receiving
// index.html (the SPA fallback) for non-existent endpoints.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  // DB unique constraint violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Conflict — resource already exists' });
  }
  // Custom status code (e.g., from err.status or err.statusCode)
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  // Log and return generic 500 (no stack traces leaked to client)
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const pool = require('./db/pool');
const { startScheduler, stopScheduler } = require('./jobs/retentionScheduler');
const PORT = process.env.PORT || 3001;

// FA6: Track scheduler state for health check
let intervalIdActive = false;
let server = null; // Hoisted from startServer() so gracefulShutdown() can access it
const _origStart = startScheduler;
const _origStop = stopScheduler;

// Wrap startScheduler to track state
function startSchedulerTracked(intervalMs) {
  _origStart(intervalMs);
  intervalIdActive = true;
}

// Wrap stopScheduler to track state
async function stopSchedulerTracked(timeoutMs) {
  intervalIdActive = false;
  await _origStop(timeoutMs);
}

// FA5: Start the retention scheduler
startSchedulerTracked();
// Phase 13: Start the alert scheduler (stale-device + health-degradation checks)
startAlertScheduler();

// Run database migrations before starting the server.
// In Electron mode, server-starter.js handles this separately (SQLite).
// In cloud/Docker mode, this ensures the schema is initialized on first boot
// and updated on subsequent deploys — no manual migration step needed.
const { runMigrations } = require('./db/migrationRunner');
const migrationDialect = process.env.USE_SQLITE === 'true' ? 'sqlite' : 'pg';

runMigrations(pool, { dialect: migrationDialect })
  .then(() => {
    console.log('Migrations complete.');
    startServer();
  })
  .catch((err) => {
    console.error('Migration failed — server will start anyway (API may be degraded):', err.message);
    startServer();
  });

function startServer() {
server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DB mode: ${process.env.DATABASE_URL ? 'DATABASE_URL (cloud)' : 'individual vars (local)'}`);
  console.log(`DATABASE_URL prefix: ${process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 30) : 'NOT SET'}`);
  try {
    await pool.query('SELECT 1');
    console.log('DB connection: OK');
  } catch (err) {
    console.error('DB connection FAILED:', err.message);
    console.error('DB error code:', err.code);
    console.error('DB error detail:', JSON.stringify(err));
  }
});
} // end startServer()

// FA6: Graceful shutdown — 503 → stop scheduler → server.close → pool.end → hard exit
// 10s total budget to prevent hanging on stuck connections.
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return; // Prevent double-shutdown
  shuttingDown = true;

  console.log(`\n[${signal}] Starting graceful shutdown...`);
  const shutdownStart = Date.now();
  const HARD_EXIT_BUDGET_MS = 10000;

  // 0. Mark as shutting down (health check returns 503)
  intervalIdActive = false;

  // 1. Stop the retention scheduler (no new runs)
  console.log('[shutdown] Stopping retention scheduler...');
  const schedulerBudget = Math.max(1000, HARD_EXIT_BUDGET_MS - (Date.now() - shutdownStart));
  await stopSchedulerTracked(schedulerBudget);

  // 2. Close HTTP server (stop accepting new connections)
  console.log('[shutdown] Closing HTTP server...');
  const closePromise = new Promise((resolve) => {
    server.close(() => {
      console.log('[shutdown] HTTP server closed');
      resolve();
    });
  });

  const remainingBudget = HARD_EXIT_BUDGET_MS - (Date.now() - shutdownStart);
  await Promise.race([
    closePromise,
    new Promise((resolve) => setTimeout(resolve, Math.max(500, remainingBudget))),
  ]);

  // 3. Close the DB pool
  console.log('[shutdown] Closing DB pool...');
  try {
    await Promise.race([
      pool.end(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    console.log('[shutdown] DB pool closed');
  } catch (err) {
    console.error('[shutdown] Error closing DB pool:', err.message);
  }

  console.log(`[shutdown] Graceful shutdown complete in ${Date.now() - shutdownStart}ms`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
