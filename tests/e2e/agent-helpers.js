/**
 * Phase 9: Agent integration E2E helpers.
 *
 * These helpers spawn the REAL Python agent (agent/agent.py) as a subprocess
 * against a test Express server bound to an OS-assigned port (not supertest
 * in-process). They mirror the bootstrap pattern in tests/e2e/setup.js but
 * bind to a real TCP port so the out-of-process Python agent can reach it.
 *
 * Usage (from a test file):
 *
 *   // Mock the pool BEFORE requiring this module so route handlers resolve
 *   // `../db/pool` to the SQLite pool.
 *   jest.mock('../../server/src/db/pool', () => require('../../server/src/db/sqlitePool'));
 *   const {
 *     startTestServer, createAgentConfig, startAgent,
 *     waitForCondition, createTestLockdownFolder, checkPythonAvailable,
 *   } = require('./agent-helpers');
 *
 * NOTE: this module requires `./setup` (which sets the test env vars at load
 * time) and reuses its `createApp` factory so the route mounting matches the
 * API-level E2E suite exactly.
 */

// ---------------------------------------------------------------------------
// Env setup — MUST run before any module that touches the DB pool.
// Requiring `./setup` sets these (it runs the same env block at module load),
// but we set them here too so this module is self-contained if it is ever
// required before setup.js in a different jest config.
// ---------------------------------------------------------------------------
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.ALLOW_NON_PROD = process.env.ALLOW_NON_PROD || '1';
process.env.USE_SQLITE = process.env.USE_SQLITE || 'true';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'e2e-agent-secret-key-that-is-long-enough-32';
process.env.AGENT_SHARED_KEY =
  process.env.AGENT_SHARED_KEY || 'e2e-agent-shared-key-long-enough-24';
process.env.AGENT_KEY_PEPPER =
  process.env.AGENT_KEY_PEPPER || 'e2e-agent-pepper-key-long-enough-32';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.LOCATION_FIELD_KEY = process.env.LOCATION_FIELD_KEY || 'b'.repeat(64);
process.env.LOCATION_RETENTION_DAYS = process.env.LOCATION_RETENTION_DAYS || '90';
// HMAC is optional in transition — the agent signs requests, but unsigned
// requests from the test helpers are also accepted.
process.env.REQUIRE_HMAC = process.env.REQUIRE_HMAC || 'false';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

// Reuse the route mounting + env bootstrap from the API-level E2E setup.
const { createApp } = require('./setup');
const sqlitePool = require('../../server/src/db/sqlitePool');
const { runMigrations } = require('../../server/src/db/migrationRunner');

const ADMIN_USERNAME = 'e2e-agent-admin';
const ADMIN_PASSWORD = 'e2e-agent-admin-password-123';

// Repo root (this file lives in <repo>/tests/e2e/).
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENT_SCRIPT = path.join(REPO_ROOT, 'agent', 'agent.py');

// ---------------------------------------------------------------------------
// HTTP client — small fetch wrapper against the live test server URL.
// Node 18+ provides a global `fetch`.
// ---------------------------------------------------------------------------

/**
 * Make a JSON HTTP request to the test server.
 * @param {string} url — base URL (e.g. http://localhost:PORT)
 * @param {string} method — GET/POST/PATCH/DELETE
 * @param {string} reqPath — path beginning with /
 * @param {object} [opts] — { body, token, headers }
 * @returns {Promise<{status, body, headers}>}
 */
async function httpJson(url, method, reqPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const fetchOpts = { method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(`${url}${reqPath}`, fetchOpts);
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body, headers: res.headers };
}

// ---------------------------------------------------------------------------
// startTestServer()
// ---------------------------------------------------------------------------

/**
 * Boot a real Express app backed by an isolated SQLite temp DB, bind it to
 * an OS-assigned port (port 0), create the admin account, and log in.
 *
 * @returns {Promise<object>} ctx with:
 *   { url, port, app, server, token, pool, dbPath, admin,
 *     apiRequest, createDevice, getDevice, flagStolen, recover,
 *     getAuditLog, getCommand, cleanup }
 */
async function startTestServer() {
  // Fresh temp DB file per server — guarantees test isolation.
  const dbPath = path.join(
    os.tmpdir(),
    `lockdown-agent-e2e-${process.pid}-${Date.now()}-${crypto.randomUUID()}.db`
  );
  process.env.SQLITE_PATH = dbPath;

  // Run migrations against the SQLite pool (sqlite dialect).
  await runMigrations(sqlitePool, { dialect: 'sqlite' });

  const app = createApp();

  // Bind to port 0 → OS assigns a free port. We resolve the actual port
  // from server.address() once listening.
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = addr.port;
  const url = `http://127.0.0.1:${port}`;

  // --- Create the initial admin account via the setup endpoint ---
  const createRes = await httpJson(url, 'POST', '/api/setup/create-admin', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (createRes.status !== 201) {
    server.close();
    throw new Error(`startTestServer: create-admin failed: ${createRes.status} ${JSON.stringify(createRes.body)}`);
  }

  // --- Login to obtain a JWT ---
  const loginRes = await httpJson(url, 'POST', '/api/auth/login', {
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
  });
  if (loginRes.status !== 200) {
    server.close();
    throw new Error(`startTestServer: login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.token;

  // --- Helpers (close over url + token) ---
  const apiRequest = (method, reqPath, data, tok) =>
    httpJson(url, method, reqPath, { body: data, token: tok !== undefined ? tok : token });

  const getDevice = (deviceId, tok) =>
    apiRequest('GET', `/api/devices/${deviceId}`, undefined, tok);

  const createDevice = (ownerName, hostname) =>
    apiRequest('POST', '/api/devices', { hostname, owner_name: ownerName });

  const flagStolen = async (deviceId, tok, hostnameConfirm) => {
    let confirm = hostnameConfirm;
    if (!confirm) {
      const dev = await getDevice(deviceId, tok);
      confirm = dev.body.hostname;
    }
    return apiRequest(
      'POST',
      `/api/devices/${deviceId}/flag-stolen`,
      { hostname_confirm: confirm },
      tok
    );
  };

  const recover = async (deviceId, tok, hostnameConfirm) => {
    let confirm = hostnameConfirm;
    if (!confirm) {
      const dev = await getDevice(deviceId, tok);
      confirm = dev.body.hostname;
    }
    return apiRequest(
      'POST',
      `/api/devices/${deviceId}/recover`,
      { hostname_confirm: confirm },
      tok
    );
  };

  const getAuditLog = (tok, deviceId) => {
    const reqPath = deviceId
      ? `/api/audit?device_id=${encodeURIComponent(deviceId)}&limit=500`
      : '/api/audit?limit=500';
    return apiRequest('GET', reqPath, undefined, tok);
  };

  // Fetch a single command row directly from the DB (the API does not expose
  // a per-command GET). Used to poll command status after flag/recover.
  const getCommand = async (commandId) => {
    const r = await sqlitePool.query('SELECT * FROM commands WHERE id = $1', [commandId]);
    return r.rows[0] || null;
  };

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { await server.close(); } catch (e) { /* ignore */ }
    try { await sqlitePool.end(); } catch (e) { /* ignore */ }
    // Remove the temp DB and SQLite sidecar files (-wal, -shm).
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
  };

  return {
    url,
    port,
    app,
    server,
    token,
    pool: sqlitePool,
    dbPath,
    admin: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    apiRequest,
    createDevice,
    getDevice,
    flagStolen,
    recover,
    getAuditLog,
    getCommand,
    cleanup,
  };
}

// Module-level registry: configPath → temp dir (for cleanup by
// cleanupAgentConfig). Declared here so it is initialized before any
// createAgentConfig() call.
const _configTmpDirs = new Map();

// ---------------------------------------------------------------------------
// createAgentConfig(serverUrl, apiKey, hostname, lockdownFolder)
// ---------------------------------------------------------------------------

/**
 * Write a temp config.ini for the Python agent and return its path.
 *
 * Sets poll_interval=2 (fast for tests), verify_tls=false (http dev mode),
 * and isolates all agent state files (sentinel, pending_ack, recovery_key)
 * inside the lockdown folder's sibling temp dir so the repo isn't polluted.
 *
 * @param {string} serverUrl — e.g. http://127.0.0.1:PORT
 * @param {string} apiKey — per-device API key (plaintext)
 * @param {string} hostname — device hostname
 * @param {string} lockdownFolder — absolute path to the lockdown folder
 * @param {object} [extra] — extra config keys to merge into [agent]
 * @returns {string} absolute path to the written config.ini
 */
function createAgentConfig(serverUrl, apiKey, hostname, lockdownFolder, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cfg-'));
  // Isolate agent runtime state files in the same temp dir so they don't
  // collide with real agent state in the repo's agent/ directory.
  const lockSentinel = path.join(tmpDir, '.locked');
  const pendingAckFile = path.join(tmpDir, '.pending_ack');
  const recoveryKeyFile = path.join(tmpDir, '.recovery_key');

  const lines = [
    '[agent]',
    `server_url = ${serverUrl}`,
    `agent_key = ${apiKey}`,
    `hostname = ${hostname}`,
    'poll_interval = 2',
    `lockdown_folder = ${lockdownFolder}`,
    `lock_sentinel = ${lockSentinel}`,
    'verify_tls = false',
    'boot_lock_enabled = false',
    `pending_ack_file = ${pendingAckFile}`,
    `recovery_key_file = ${recoveryKeyFile}`,
    'recovery_public_key =',
    'server_supports_ack_dedup = true',
  ];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k} = ${v}`);
  }
  const configPath = path.join(tmpDir, 'config.ini');
  fs.writeFileSync(configPath, lines.join('\n') + '\n');
  // Track the temp dir so cleanupAgentConfig() can remove it. We key by the
  // config path (a string) in a module-level map.
  _configTmpDirs.set(configPath, tmpDir);
  return configPath;
}

/**
 * Remove the temp dir created by createAgentConfig() for a given config path.
 * Best-effort — ignores errors if the dir was already removed.
 * @param {string} configPath — path returned by createAgentConfig()
 */
function cleanupAgentConfig(configPath) {
  const tmpDir = _configTmpDirs.get(configPath);
  if (!tmpDir) return;
  _configTmpDirs.delete(configPath);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// startAgent(configPath)
// ---------------------------------------------------------------------------

/**
 * Spawn `python3 agent/agent.py --config <configPath>` as a subprocess.
 *
 * @param {string} configPath — path returned by createAgentConfig()
 * @param {object} [opts] — { env: extra env vars, cwd }
 * @returns {Promise<{process, cleanup, stdout, stderr}>} resolves once the
 *   process has spawned (does NOT wait for it to exit). `cleanup` kills the
 *   process and resolves after exit.
 */
function startAgent(configPath, opts = {}) {
  // Build a clean env for the agent subprocess. We MUST delete (not blank)
  // agent-relevant env vars because the agent's load_config() treats an
  // empty-string env var as "set" (os.environ.get returns '' rather than the
  // fallback), which would override the config file's agent_key with '' and
  // cause the agent to exit with "AGENT_SHARED_KEY is not set".
  const env = { ...process.env };
  delete env.DEVICE_API_KEY;
  delete env.AGENT_SHARED_KEY;
  delete env.DEVICE_HOSTNAME;
  delete env.POLL_INTERVAL;
  delete env.LOCKDOWN_FOLDER;
  delete env.LOCK_SENTINEL;
  delete env.BOOT_LOCK_ENABLED;
  delete env.UEFI_PASSWORD;
  delete env.PENDING_ACK_FILE;
  delete env.RECOVERY_KEY_FILE;
  delete env.RECOVERY_PUBLIC_KEY;
  delete env.SERVER_URL;
  delete env.SERVER_SUPPORTS_ACK_DEDUP;
  Object.assign(env, opts.env || {});

  const child = spawn('python3', [AGENT_SCRIPT, '--config', configPath], {
    env,
    cwd: opts.cwd || REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (d) => stdout.push(d));
  child.stderr.on('data', (d) => stderr.push(d));

  let killed = false;
  const cleanup = () => new Promise((resolve) => {
    if (killed) return resolve();
    killed = true;
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
    try {
      child.kill('SIGTERM');
      // Force-kill after 5s if it hasn't exited.
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }, 5000).unref();
    } catch (e) {
      resolve();
    }
  });

  // Surface a fatal spawn error to the caller via the returned object.
  const spawnError = new Promise((resolve) => {
    child.once('error', (err) => resolve(err));
  });

  return {
    process: child,
    cleanup,
    spawnError,
    getStdout: () => Buffer.concat(stdout).toString('utf8'),
    getStderr: () => Buffer.concat(stderr).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// waitForCondition(checkFn, timeoutMs, intervalMs)
// ---------------------------------------------------------------------------

/**
 * Poll `checkFn` until it returns a truthy value, or reject on timeout.
 *
 * @param {() => Promise<boolean>|boolean} checkFn — async or sync predicate
 * @param {number} [timeoutMs=30000] — max time to wait
 * @param {number} [intervalMs=500] — poll interval
 * @returns {Promise<*>} resolves with the truthy value returned by checkFn
 */
async function waitForCondition(checkFn, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await checkFn();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const msg = lastErr
    ? `waitForCondition timed out after ${timeoutMs}ms (last error: ${lastErr && lastErr.message})`
    : `waitForCondition timed out after ${timeoutMs}ms`;
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// createTestLockdownFolder()
// ---------------------------------------------------------------------------

/**
 * Create a temp lockdown folder with 2-3 test files and return its details.
 *
 * Files: secret.txt (plaintext), data.json (small JSON), notes.md (markdown).
 * The original contents are captured so tests can verify decryption restored
 * them byte-for-byte.
 *
 * @returns {{path, files, cleanup}} where `files` is an array of
 *   { name, content (Buffer), originalPath }.
 */
function createTestLockdownFolder() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockdown-folder-'));
  const files = [
    { name: 'secret.txt', content: Buffer.from('top secret payload — do not leak\n') },
    { name: 'data.json', content: Buffer.from(JSON.stringify({ a: 1, b: 'two', nested: { x: true } }, null, 2)) },
    { name: 'notes.md', content: Buffer.from('# Notes\n\nThese are important notes.\n') },
  ];
  for (const f of files) {
    f.originalPath = path.join(tmpDir, f.name);
    fs.writeFileSync(f.originalPath, f.content);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };

  return { path: tmpDir, files, cleanup };
}

// ---------------------------------------------------------------------------
// checkPythonAvailable()
// ---------------------------------------------------------------------------

/**
 * Check whether python3 + the cryptography + requests modules are available.
 *
 * @returns {Promise<boolean>} true if the agent can run, false otherwise.
 */
async function checkPythonAvailable() {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', 'import cryptography, requests; print("ok")'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      resolve(code === 0 && out.includes('ok'));
    });
  });
}

module.exports = {
  startTestServer,
  createAgentConfig,
  cleanupAgentConfig,
  startAgent,
  waitForCondition,
  createTestLockdownFolder,
  checkPythonAvailable,
  // Re-exported for convenience.
  REPO_ROOT,
  AGENT_SCRIPT,
};
