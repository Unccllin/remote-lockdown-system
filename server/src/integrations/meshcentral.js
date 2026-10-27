/**
 * MeshCentral connector — READ-ONLY inventory, owned by us.
 *
 * Design rules come from docs/adr/INTEGRATION-OWNERSHIP.md:
 *
 *   1. This is a connector inside OUR server, not a MeshCentral plugin. No
 *      MeshCentral code or client library is used — a plain `fetch` against
 *      their public REST API.
 *   2. MeshCentral is optional. Everything here is inert unless
 *      MESHCENTRAL_URL is configured, and a failure degrades one endpoint
 *      instead of breaking the service.
 *   3. Read-only, by construction: this module can only issue GET requests for
 *      inventory. Lockdown/unlock/policy actions are never proxied upstream —
 *      those go through our own command queue and audit log.
 *   4. Output is OUR normalized shape, not theirs. If we swap the upstream for
 *      Tactical RMM or Intune, the route contract does not change.
 *
 * MeshCentral REST used (both GET, both read-only):
 *   POST {url}/login            {username,password} -> {token}
 *   GET  {url}/api/nodes?auth=  -> { nodes: { <nodeid>: {...} } }
 */

const logger = require('../logger');

const TIMEOUT_MS = 8000;

/**
 * Build MeshCentral's authentication header.
 *
 * Verified against a real server (S142): authentication is NOT a JSON POST to
 * /login — that endpoint serves the web UI and answers with HTML. MeshCentral's
 * own CLI (meshctrl.js) sends:
 *
 *     x-meshauth: base64(username),base64(password)[,base64(2FA code)]
 *
 * A first implementation used POST /login and failed against the real server
 * with "Unexpected token '<'" — the mock-based tests could not have caught it.
 */
function authHeader(user, pass, twoFactor) {
  const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');
  const parts = [b64(user), b64(pass)];
  if (twoFactor) parts.push(b64(twoFactor));
  return parts.join(',');
}

/** Raised for configuration problems, as opposed to upstream failures. */
class ConnectorNotConfigured extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectorNotConfigured';
    this.code = 'NOT_CONFIGURED';
  }
}

/** Raised when the upstream is configured but unusable right now. */
class ConnectorUpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ConnectorUpstreamError';
    this.code = 'UPSTREAM_ERROR';
    this.cause = cause;
  }
}

function config() {
  const url = (process.env.MESHCENTRAL_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.MESHCENTRAL_TOKEN || '').trim();
  const user = (process.env.MESHCENTRAL_USER || '').trim();
  const pass = process.env.MESHCENTRAL_PASS || '';
  const twoFactor = (process.env.MESHCENTRAL_2FA || '').trim();
  const explicitlyOff = (process.env.INTEGRATIONS_MESHCENTRAL || '').toLowerCase() === 'off';
  return { url, token, user, pass, twoFactor, explicitlyOff };
}

/** Is the connector switched on? Off unless a URL is configured. */
function isEnabled() {
  const cfg = config();
  return Boolean(cfg.url) && !cfg.explicitlyOff;
}

/** Does the connector have usable credentials (token, or user+pass)? */
function isConfigured() {
  const cfg = config();
  return isEnabled() && Boolean(cfg.token || (cfg.user && cfg.pass));
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    // MeshCentral 1.3.1 has no REST API: unknown paths are handed to the web
    // UI, which answers 404 with HTML. Saying so beats "Unexpected token '<'".
    if (contentType.includes('text/html')) {
      throw new ConnectorUpstreamError(
        `MeshCentral answered with HTML (HTTP ${res.status}) — this deployment has no REST API at that path. MeshCentral 1.3.x is WebSocket-only (see docs/adr/INTEGRATION-OWNERSHIP.md).`
      );
    }
    if (!res.ok) {
      throw new ConnectorUpstreamError(`MeshCentral returned HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ConnectorUpstreamError) throw err;
    // Never include the URL query (it can carry the auth token) in the message.
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    throw new ConnectorUpstreamError(`MeshCentral request failed: ${reason}`, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the node inventory using whatever credentials are configured.
 *
 * Two supported shapes:
 *   - user + password (+ optional 2FA): `x-meshauth` header. VERIFIED against a
 *     real MeshCentral instance.
 *   - a MeshCentral login token: `?login=<token>` query. Accepted by the web
 *     layer for single-sign-on; not yet exercised against a real server, so
 *     treat it as best-effort and prefer credentials.
 */
async function fetchNodes(cfg) {
  if (cfg.token) {
    return request(`${cfg.url}/api/nodes?login=${encodeURIComponent(cfg.token)}`);
  }
  return request(`${cfg.url}/api/nodes`, {
    headers: { 'x-meshauth': authHeader(cfg.user, cfg.pass, cfg.twoFactor) },
  });
}

/**
 * Normalize one MeshCentral node into our inventory shape.
 *
 * Their `conn` is 0 or 1; `lastconnecttime` is seconds since epoch (they omit it
 * for nodes that never connected, so treat absence as null rather than 1970).
 */
function normalizeNode(nodeId, node) {
  const online = node.conn === 1;
  const last = Number(node.lastconnecttime);
  return {
    source: 'meshcentral',
    id: String(nodeId),
    name: node.name || node.rname || String(nodeId),
    online,
    lastSeenAt: Number.isFinite(last) && last > 0 ? new Date(last * 1000).toISOString() : null,
    platform: node.osdesc || null,
    meshId: node.meshid || null,
  };
}

/**
 * Fetch the device inventory.
 *
 * @returns {Promise<{devices: Array<object>, fetchedAt: string}>}
 * @throws {ConnectorNotConfigured} when the connector is off or lacks credentials
 * @throws {ConnectorUpstreamError} when the upstream is unreachable or malformed
 */
async function getDevices() {
  const cfg = config();
  if (cfg.explicitlyOff) {
    throw new ConnectorNotConfigured('MeshCentral integration is switched off');
  }
  if (!cfg.url) {
    throw new ConnectorNotConfigured('MESHCENTRAL_URL is not set');
  }
  if (!cfg.token && !(cfg.user && cfg.pass)) {
    throw new ConnectorNotConfigured(
      'Set MESHCENTRAL_TOKEN, or MESHCENTRAL_USER and MESHCENTRAL_PASS'
    );
  }

  const data = await fetchNodes(cfg);
  const nodes = data && data.nodes;
  if (!nodes || typeof nodes !== 'object') {
    throw new ConnectorUpstreamError('MeshCentral /api/nodes returned no node map');
  }

  const devices = Object.entries(nodes).map(([id, node]) => normalizeNode(id, node || {}));
  devices.sort((a, b) => a.name.localeCompare(b.name));

  logger.info({ count: devices.length }, '[integrations] meshcentral inventory fetched');
  return { devices, fetchedAt: new Date().toISOString() };
}

/** Status for the integrations listing — cheap, no upstream call. */
function status() {
  return {
    id: 'meshcentral',
    name: 'MeshCentral',
    enabled: isEnabled(),
    configured: isConfigured(),
    mode: 'read-only',
  };
}

module.exports = {
  getDevices,
  status,
  isEnabled,
  isConfigured,
  ConnectorNotConfigured,
  ConnectorUpstreamError,
  _normalizeNode: normalizeNode, // exported for tests
};
