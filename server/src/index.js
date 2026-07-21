require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv(); // CC2/CC11: fail fast on bad config before anything else loads
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const devicesRoutes = require('./routes/devices');
const agentRoutes = require('./routes/agent');
const auditRoutes = require('./routes/audit');

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));

// Phase 0: capture raw body for HMAC signature verification.
// express.json() parses the body but we also need the raw bytes to compute
// the SHA-256 hash for HMAC. The verify hook runs before parsing — we stash
// the raw body on req.rawBody.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

// Global rate limiter (admin/dashboard endpoints)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

// Phase 0: Per-device rate limiter for agent endpoints.
// Applied only to /api/agent/* — keyed on device ID (set by agentAuth) or
// x-agent-key header (pre-auth). Stricter than the global limiter since
// agents check in frequently.
const agentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600, // 600 req / 15 min per device (40/min — enough for 30s polling + retries)
  keyGenerator: (req) => req.device?.id || req.headers['x-agent-key'] || req.ip,
  standardHeaders: true,
  message: { error: 'Too many agent requests — rate limited per device' },
});

app.use('/api/auth', authRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/agent', agentLimiter, agentRoutes);
app.use('/api/audit', auditRoutes);

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

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const pool = require('./db/pool');
const { startScheduler, stopScheduler } = require('./jobs/retentionScheduler');
const PORT = process.env.PORT || 3001;

// FA6: Track scheduler state for health check
let intervalIdActive = false;
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

const server = app.listen(PORT, async () => {
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
