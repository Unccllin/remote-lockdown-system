/**
 * E-AUTO-UPDATE: the update path, end to end, with the real agent.
 *
 * Why this exists
 * ---------------
 * Every existing assertion about the update path stopped at a boundary: the
 * server test mocked the pool and never signed with a real key, the agent test
 * mocked `requests` and never spoke HTTP, and the signer test verified bytes that
 * a real response had never carried. So "an update is authenticated" was true in
 * three places and proven in none.
 *
 * This suite runs the whole chain: a live Express server on a real TCP port, the
 * real `agent/agent.py` as a subprocess, a real Ed25519 keypair on disk, and the
 * SHA-256 of the bytes actually served. It answers the question the graph asks of
 * E-AUTO-UPDATE — does a device report how it verifies updates, and does it then
 * accept exactly the release that verifies and refuse everything else?
 *
 * The device is enrolled once and re-provisioned per scenario, because that is
 * what the mode is: a property of the config the agent is running. Re-provisioning
 * it is also the "flip" the operator would see in the dashboard.
 *
 * Hardware is the only thing missing; the evidence level is "emulated".
 */

// Mock the pool to use SQLite BEFORE requiring helpers (which load routes).
jest.mock('../../server/src/db/pool', () => require('../../server/src/db/sqlitePool'));

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  agentEnv,
  startTestServer,
  createAgentConfig,
  cleanupAgentConfig,
  checkPythonAvailable,
} = require('./agent-helpers');

const REPO = path.join(__dirname, '..', '..');
const AGENT_DIR = path.join(REPO, 'agent');
const RELEASE_VERSION = '9.9.9';
const HOSTNAME = 'e2e-update-device';
const ACTION_TIMEOUT = 60000;

let PYTHON = null;
let server = null;
let BINARIES_DIR = null;
let RELEASE_BYTES = null;
let DEVICE = null; // { id, apiKey }

/** Prefer the agent venv (repo convention), fall back to python3. */
function resolvePython() {
  const venv = path.join(AGENT_DIR, '.venv', 'bin', 'python');
  return fs.existsSync(venv) ? venv : 'python3';
}

function opensslAvailable() {
  return spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;
}

/** A throwaway Ed25519 keypair, made the way the release job makes one. */
function makeKeypair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-update-keys-'));
  const priv = path.join(dir, 'update_signing.key');
  const pub = path.join(dir, 'update_signing.pub');
  spawnSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', priv], { encoding: 'utf8' });
  spawnSync('openssl', ['pkey', '-in', priv, '-pubout', '-out', pub], { encoding: 'utf8' });
  return { dir, priv, pub };
}

/** The "released" binary the server hashes and the agent downloads. */
function makeBinariesDir(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-update-bin-'));
  fs.writeFileSync(path.join(dir, 'lockdown-agent'), bytes);
  return dir;
}

/** Point the server at one signed/unsigned release for the duration of a test. */
function configureRelease({ signingKey }) {
  process.env.AGENT_BINARIES_DIR = BINARIES_DIR;
  process.env.AGENT_LATEST_VERSION = RELEASE_VERSION;
  if (signingKey) {
    process.env.UPDATE_SIGNING_KEY = signingKey;
  } else {
    delete process.env.UPDATE_SIGNING_KEY;
  }
}

/** Provision the enrolled device with a given pin (or none). */
function provision(pinKey) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-update-state-'));
  const configPath = createAgentConfig(
    server.url,
    DEVICE.apiKey,
    HOSTNAME,
    stateDir,
    { update_public_key: pinKey || '' }
  );
  return {
    configPath,
    stateDir,
    cleanup: () => {
      cleanupAgentConfig(configPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * Run one-shot agent code: check in (so the server records the verification
 * mode), then check for an update. Real module, real HTTP, real verification.
 *
 * Async `spawn`, NOT `spawnSync`: the test server runs in this same Node process,
 * so a synchronous spawn would block the event loop and the server could never
 * answer the agent — the agent would time out with no check-in recorded, which
 * looks exactly like a broken server.
 */
function runAgentUpdate(configPath, stateDir) {
  const script = `
import json, logging, sys
logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format="%(levelname)s %(name)s: %(message)s")
sys.path.insert(0, ${JSON.stringify(AGENT_DIR)})
import agent

cfg = agent.load_config(${JSON.stringify(configPath)})
agent.checkin(cfg)
agent.check_for_update(cfg)

pending = agent.UPDATE_PENDING_FILE
downloaded = agent.UPDATE_DOWNLOAD_FILE
signal = json.loads(pending.read_text()) if pending.exists() else None
print("@@RESULT@@" + json.dumps({
    "mode": agent.update_verification_mode(cfg),
    "pending": signal,
    "download_exists": downloaded.exists(),
    "download_size": downloaded.stat().st_size if downloaded.exists() else 0,
}))
`;

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-c', script], {
      cwd: AGENT_DIR,
      // Shared env rule: an inherited AGENT_SHARED_KEY would override the device
      // key from the config file and every check-in would be a 401.
      env: agentEnv({ LOCKDOWN_STATE_DIR: stateDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      // Optional catch binding: the process may already have exited.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`agent run exceeded ${ACTION_TIMEOUT}ms\nSTDERR:\n${stderr}`));
    }, ACTION_TIMEOUT);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
      if (!line) {
        reject(new Error(
          `agent run produced no result (exit ${code})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
        ));
        return;
      }
      resolve(JSON.parse(line.slice('@@RESULT@@'.length)));
    });
  });
}

/**
 * One agent run against one release, for one pinning state.
 * Returns the agent's own view plus the server's view of the device.
 */
async function runScenario({ signingKey, pinKey }) {
  configureRelease({ signingKey });
  const device = provision(pinKey);
  try {
    const result = await runAgentUpdate(device.configPath, device.stateDir);
    const serverView = await server.getDevice(DEVICE.id);
    return { ...result, storedMode: serverView.body.update_verification };
  } finally {
    device.cleanup();
  }
}

beforeAll(async () => {
  PYTHON = resolvePython();
  if (!(await checkPythonAvailable()) || !opensslAvailable()) {
    PYTHON = null; // every test becomes a no-op, like the sibling agent suite
    return;
  }
  RELEASE_BYTES = Buffer.from('PBL-E2E-RELEASE-BYTES-v9.9.9');
  BINARIES_DIR = makeBinariesDir(RELEASE_BYTES);
  server = await startTestServer();

  // One device for the suite. get_hardware_uuid() falls back to a host-stable
  // value where DMI is unreadable, and devices.hardware_uuid is UNIQUE, so two
  // devices on the same host collide on check-in; one device re-provisioned is
  // also the truer model (the mode is a property of the agent's config).
  const created = await server.createDevice('E2E Update', HOSTNAME);
  if (created.status !== 201) {
    throw new Error(`enrol failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  DEVICE = { id: created.body.id, apiKey: created.body.api_key };
}, 60000);

afterAll(async () => {
  delete process.env.AGENT_BINARIES_DIR;
  delete process.env.AGENT_LATEST_VERSION;
  delete process.env.UPDATE_SIGNING_KEY;
  if (BINARIES_DIR) fs.rmSync(BINARIES_DIR, { recursive: true, force: true });
  if (server) await server.cleanup();
}, 30000);

describe('Agent auto-update, end to end (E-AUTO-UPDATE)', () => {
  let keys;

  beforeEach(() => {
    if (PYTHON) keys = makeKeypair();
  });

  afterEach(() => {
    if (keys) fs.rmSync(keys.dir, { recursive: true, force: true });
    keys = null;
  });

  test(
    'a pinned device reports "signature" and applies the signed release',
    async () => {
      if (!PYTHON) return;
      const result = await runScenario({ signingKey: keys.priv, pinKey: keys.pub });

      // The mode the dashboard shows, derived from the pinned key…
      expect(result.mode).toBe('signature');
      // …and the value the server recorded from the real check-in.
      expect(result.storedMode).toBe('signature');

      // The update reached the pending slot, verified against the signature,
      // over the bytes the server actually hashed and served.
      expect(result.pending).not.toBeNull();
      expect(result.pending.version).toBe(RELEASE_VERSION);
      expect(result.pending.signature_verified).toBe(true);
      expect(result.download_size).toBe(RELEASE_BYTES.length);
      expect(result.pending.sha256).toBe(
        crypto.createHash('sha256').update(RELEASE_BYTES).digest('hex')
      );
    },
    ACTION_TIMEOUT
  );

  test(
    'the same device refuses a release the server publishes unsigned',
    async () => {
      if (!PYTHON) return;
      const result = await runScenario({ signingKey: null, pinKey: keys.pub });

      expect(result.mode).toBe('signature');
      expect(result.pending).toBeNull();
      expect(result.download_exists).toBe(false);
    },
    ACTION_TIMEOUT
  );

  test(
    'the same device refuses a release signed by a key it does not trust',
    async () => {
      if (!PYTHON) return;
      const agentKeys = makeKeypair();
      try {
        // Right binary, right hash, right version, a valid Ed25519 signature over
        // exactly that payload — minted by a key this device does not trust.
        const result = await runScenario({ signingKey: agentKeys.priv, pinKey: keys.pub });

        expect(result.mode).toBe('signature');
        expect(result.pending).toBeNull();
        expect(result.download_exists).toBe(false);
      } finally {
        fs.rmSync(agentKeys.dir, { recursive: true, force: true });
      }
    },
    ACTION_TIMEOUT
  );

  test(
    'unpinning the same device flips it to "sha256-only", still applying updates',
    async () => {
      if (!PYTHON) return;
      const result = await runScenario({ signingKey: keys.priv, pinKey: null });

      // The state this feature exists to eliminate: it works, unauthenticated,
      // and says so at check-in.
      expect(result.mode).toBe('sha256-only');
      expect(result.storedMode).toBe('sha256-only');

      expect(result.pending).not.toBeNull();
      // Crucially not true: nothing established who produced these bytes.
      expect(result.pending.signature_verified).toBe(false);
    },
    ACTION_TIMEOUT
  );
});
