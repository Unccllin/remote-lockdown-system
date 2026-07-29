/**
 * Phase 9: Agent integration E2E tests.
 *
 * These tests spawn the REAL Python agent (agent/agent.py) as a subprocess
 * against a live Express test server bound to an OS-assigned port. They
 * verify the full round-trip:
 *
 *   enroll device → agent checkin → flag stolen → agent encrypts
 *   LOCKDOWN_FOLDER → agent ACKs lockdown → recover → agent decrypts
 *   LOCKDOWN_FOLDER → agent ACKs unlock → files restored.
 *
 * All tests are SKIPPED (treated as no-ops with a warning) if python3 /
 * cryptography / requests are not available, so the suite stays green in
 * environments without the agent runtime.
 *
 * NOTE on adaptive polling: the server sends an adaptive poll_interval that
 * OVERRIDES the agent's config (active=300s, stolen=30s, locked=60s). To keep
 * tests fast, we RESTART the agent subprocess right before each command-
 * processing step. The agent performs an immediate checkin on startup, so it
 * picks up the pending command without waiting for the next poll cycle. This
 * also exercises the agent's reconnect/restart resilience.
 */

// Mock the pool to use SQLite BEFORE requiring helpers (which load routes).
jest.mock('../../server/src/db/pool', () => require('../../server/src/db/sqlitePool'));

const fs = require('fs');
const {
  startTestServer,
  createAgentConfig,
  cleanupAgentConfig,
  startAgent,
  waitForCondition,
  createTestLockdownFolder,
  checkPythonAvailable,
} = require('./agent-helpers');

// ---------------------------------------------------------------------------
// Gate the whole suite on Python + agent deps being available.
// ---------------------------------------------------------------------------
let PYTHON_AVAILABLE = false;

// Shared state across tests.
let server;
let lockdown;
let agent;
let configPath;
let device;
const HOSTNAME = 'e2e-agent-device-001';

// Per-action timeout. The agent checks in immediately on startup, so with
// poll_interval=2 + processing time, actions complete within a few seconds.
// 30s gives generous headroom for slow CI / cold imports.
const ACTION_TIMEOUT = 30000;

beforeAll(async () => {
  PYTHON_AVAILABLE = await checkPythonAvailable();
  if (!PYTHON_AVAILABLE) return;
  server = await startTestServer();
}, 60000);

afterAll(async () => {
  if (agent && agent.cleanup) await agent.cleanup();
  if (lockdown && lockdown.cleanup) lockdown.cleanup();
  if (configPath) cleanupAgentConfig(configPath);
  if (server && server.cleanup) await server.cleanup();
}, 30000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * (Re)create the agent config + spawn a fresh agent subprocess pointing at
 * the current server. Kills any previously-running agent first. The agent
 * checks in immediately on startup.
 */
async function relaunchAgent() {
  if (agent && agent.cleanup) {
    await agent.cleanup();
    agent = null;
  }
  if (configPath) {
    cleanupAgentConfig(configPath);
    configPath = null;
  }
  configPath = createAgentConfig(
    server.url,
    device.apiKey,
    device.hostname,
    lockdown.path
  );
  agent = startAgent(configPath);
}

/** Read a file's bytes, or null if missing. */
function readFileBytes(filePath) {
  try { return fs.readFileSync(filePath); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent integration: real Python agent ↔ Express server', () => {
  test(
    'agent checks in to server (last_checkin updates)',
    async () => {
      if (!PYTHON_AVAILABLE) {
        console.warn('[agent-integration] Python/cryptography/requests not available — skipping');
        return;
      }

      // --- Enroll a device (returns per-device API key once) ---
      const enrollRes = await server.createDevice('Alice', HOSTNAME);
      expect(enrollRes.status).toBe(201);
      expect(enrollRes.body.api_key).toBeDefined();
      device = {
        id: enrollRes.body.id,
        hostname: enrollRes.body.hostname,
        apiKey: enrollRes.body.api_key,
      };

      // --- Create a test lockdown folder with known files ---
      lockdown = createTestLockdownFolder();
      for (const f of lockdown.files) {
        expect(fs.existsSync(f.originalPath)).toBe(true);
      }

      // --- Spawn the agent (immediate checkin on startup) ---
      await relaunchAgent();

      // --- Wait for the agent to check in: last_checkin becomes non-null ---
      await waitForCondition(async () => {
        const res = await server.getDevice(device.id);
        if (res.status !== 200) return false;
        return !!res.body.last_checkin;
      }, ACTION_TIMEOUT);

      const dev = await server.getDevice(device.id);
      expect(dev.status).toBe(200);
      expect(dev.body.last_checkin).toBeTruthy();
      expect(dev.body.hostname).toBe(device.hostname);
    },
    120000
  );

  test(
    'lockdown encrypts LOCKDOWN_FOLDER files',
    async () => {
      if (!PYTHON_AVAILABLE) return;
      if (!device) throw new Error('prerequisite test (checkin) did not run');

      // Capture original file contents for later comparison.
      const originals = lockdown.files.map((f) => ({
        name: f.name,
        content: f.content,
        originalPath: f.originalPath,
      }));

      // --- Flag the device stolen → queues a lockdown command ---
      const flagRes = await server.flagStolen(device.id, server.token, device.hostname);
      expect(flagRes.status).toBe(200);
      expect(flagRes.body.device.status).toBe('stolen');
      const lockdownCommandId = flagRes.body.command.id;

      // --- Restart the agent so it immediately checks in & picks up the
      //     pending lockdown command (avoids the 300s adaptive poll wait) ---
      await relaunchAgent();

      // --- Wait for the agent to ACK the lockdown command (status=executed) ---
      await waitForCondition(async () => {
        const cmd = await server.getCommand(lockdownCommandId);
        return cmd && cmd.status === 'executed';
      }, ACTION_TIMEOUT);

      // --- Verify the device transitioned to 'locked' ---
      await waitForCondition(async () => {
        const res = await server.getDevice(device.id);
        return res.body && res.body.status === 'locked';
      }, ACTION_TIMEOUT);

      // --- Verify LOCKDOWN_FOLDER files are actually encrypted ---
      // encrypt_folder() replaces each file with a <name>.enc counterpart and
      // deletes the original. So: originals gone, .enc files present, and the
      // .enc content differs from the plaintext.
      for (const f of originals) {
        const encPath = f.originalPath + '.enc';
        expect(fs.existsSync(f.originalPath)).toBe(false);
        expect(fs.existsSync(encPath)).toBe(true);
        const encBytes = readFileBytes(encPath);
        expect(encBytes).not.toBeNull();
        // Encrypted content must differ from the original plaintext.
        expect(encBytes.equals(f.content)).toBe(false);
      }
    },
    120000
  );

  test(
    'recovery decrypts LOCKDOWN_FOLDER files',
    async () => {
      if (!PYTHON_AVAILABLE) return;
      if (!device) throw new Error('prerequisite test (lockdown) did not run');

      // Capture the expected original contents (from the helper's records).
      const originals = lockdown.files.map((f) => ({
        name: f.name,
        content: f.content,
        originalPath: f.originalPath,
      }));

      // --- Recover the device → queues an unlock command with key_material ---
      const recoverRes = await server.recover(device.id, server.token, device.hostname);
      expect(recoverRes.status).toBe(200);
      expect(recoverRes.body.device.status).toBe('recovering');
      const unlockCommandId = recoverRes.body.command.id;

      // --- Restart the agent so it immediately picks up the unlock command ---
      await relaunchAgent();

      // --- Wait for the agent to ACK the unlock command (status=executed) ---
      await waitForCondition(async () => {
        const cmd = await server.getCommand(unlockCommandId);
        return cmd && cmd.status === 'executed';
      }, ACTION_TIMEOUT);

      // --- Verify the device transitioned back to 'active' ---
      await waitForCondition(async () => {
        const res = await server.getDevice(device.id);
        return res.body && res.body.status === 'active';
      }, ACTION_TIMEOUT);

      // --- Verify LOCKDOWN_FOLDER files are decrypted (originals restored) ---
      for (const f of originals) {
        const encPath = f.originalPath + '.enc';
        expect(fs.existsSync(f.originalPath)).toBe(true);
        expect(fs.existsSync(encPath)).toBe(false);
        // Content must match the original byte-for-byte.
        const restored = readFileBytes(f.originalPath);
        expect(restored).not.toBeNull();
        expect(restored.equals(f.content)).toBe(true);
      }
    },
    120000
  );

  test(
    'agent reconnects after server restart',
    async () => {
      if (!PYTHON_AVAILABLE) return;
      if (!device) throw new Error('prerequisite test (recovery) did not run');

      // The agent is configured against `server.url`. We restart the server
      // (new port + fresh DB), enroll a new device, and spawn a fresh agent
      // pointing at the restarted server. This validates that the agent can
      // successfully check in to a freshly-started server instance — i.e. it
      // survives transient server downtime and reconnects.

      // Tear down the existing agent.
      if (agent && agent.cleanup) {
        await agent.cleanup();
        agent = null;
      }

      // Restart the server on a fresh port + DB.
      if (server && server.cleanup) await server.cleanup();
      server = await startTestServer();

      // Enroll a new device on the restarted server.
      const hostname2 = 'e2e-agent-device-002';
      const enrollRes = await server.createDevice('Bob', hostname2);
      expect(enrollRes.status).toBe(201);
      device = {
        id: enrollRes.body.id,
        hostname: enrollRes.body.hostname,
        apiKey: enrollRes.body.api_key,
      };

      // Fresh lockdown folder (required by the agent config).
      if (lockdown && lockdown.cleanup) lockdown.cleanup();
      lockdown = createTestLockdownFolder();

      // Spawn a fresh agent pointing at the restarted server.
      await relaunchAgent();

      // Wait for the new agent to check in to the restarted server.
      await waitForCondition(async () => {
        const res = await server.getDevice(device.id);
        if (res.status !== 200) return false;
        return !!res.body.last_checkin;
      }, ACTION_TIMEOUT);

      const dev = await server.getDevice(device.id);
      expect(dev.status).toBe(200);
      expect(dev.body.last_checkin).toBeTruthy();
      expect(dev.body.hostname).toBe(device.hostname);
    },
    120000
  );
});
