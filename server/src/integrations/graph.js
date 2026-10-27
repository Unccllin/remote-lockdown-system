/**
 * Microsoft Graph (Intune) connector — READ-ONLY device inventory.
 *
 * This is the transport the ownership ADR points at: MeshCentral 1.3.x has no
 * REST API (verified against a real instance in S142 — every /api/* path returns
 * HTML), while Graph is a documented REST surface. Our connector contract,
 * routes and normalized shape are unchanged; only this file knows about Graph.
 *
 * Auth: OAuth2 client credentials (app registration with
 * DeviceManagementManagedDevices.Read.All). The token is cached until shortly
 * before expiry.
 *
 * Read-only by construction: the only request this module can issue after auth
 * is GET deviceManagement/managedDevices.
 *
 * Env:
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET   (required)
 *   GRAPH_SCOPE        (optional, default https://graph.microsoft.com/.default)
 *   INTEGRATIONS_GRAPH=off                                  (force disable)
 */

const logger = require('../logger');
const { ConnectorNotConfigured, ConnectorUpstreamError } = require('./errors');

const TIMEOUT_MS = 10000;
const MAX_PAGES = 20;
const ONLINE_WINDOW_MINUTES = 15;

/** Cached app-only token: { token, expiresAt }. */
let tokenCache = null;

function config() {
  const tenantId = (process.env.GRAPH_TENANT_ID || '').trim();
  const clientId = (process.env.GRAPH_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GRAPH_CLIENT_SECRET || '').trim();
  const scope = (process.env.GRAPH_SCOPE || 'https://graph.microsoft.com/.default').trim();
  const explicitlyOff = (process.env.INTEGRATIONS_GRAPH || '').toLowerCase() === 'off';
  return { tenantId, clientId, clientSecret, scope, explicitlyOff };
}

function isEnabled() {
  return Boolean(config().tenantId) && !config().explicitlyOff;
}

function isConfigured() {
  const cfg = config();
  return (
    isEnabled() && Boolean(cfg.tenantId && cfg.clientId && cfg.clientSecret)
  );
}

async function httpJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      throw new ConnectorUpstreamError(`Graph returned HTTP ${res.status}`);
    }
    if (!contentType.includes('json')) {
      throw new ConnectorUpstreamError('Graph returned a non-JSON response');
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ConnectorUpstreamError) throw err;
    const reason = err.name === 'AbortError' ? 'timed out' : err.message;
    throw new ConnectorUpstreamError(`Graph request failed: ${reason}`, err);
  } finally {
    clearTimeout(timer);
  }
}

/** App-only token, cached until 60s before expiry. */
async function accessToken(cfg) {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: cfg.scope,
    grant_type: 'client_credentials',
  });
  const data = await httpJson(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new ConnectorUpstreamError('Graph token endpoint returned no access_token');
  }
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttl * 1000 };
  return tokenCache.token;
}

/**
 * Normalize one managed device.
 *
 * Graph has no "online" flag, so `online` is derived from the last sync time
 * within ONLINE_WINDOW_MINUTES. That heuristic is ours and documented; the
 * route contract (boolean + lastSeenAt) stays intact.
 */
function normalizeDevice(device) {
  const lastSync = device.lastSyncDateTime ? new Date(device.lastSyncDateTime) : null;
  const lastSeenAt = lastSync && !Number.isNaN(lastSync.getTime()) ? lastSync.toISOString() : null;
  const online =
    lastSeenAt !== null &&
    Date.now() - new Date(lastSeenAt).getTime() <= ONLINE_WINDOW_MINUTES * 60_000;

  return {
    source: 'graph',
    id: String(device.id || ''),
    name: device.deviceName || String(device.id || ''),
    online,
    lastSeenAt,
    platform: device.operatingSystem || null,
    meshId: null, // no group equivalent in this view
  };
}

async function getDevices() {
  const cfg = config();
  if (cfg.explicitlyOff) {
    throw new ConnectorNotConfigured('Graph integration is switched off');
  }
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    throw new ConnectorNotConfigured(
      'Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET'
    );
  }

  const token = await accessToken(cfg);
  const headers = { Authorization: `Bearer ${token}` };
  let url =
    'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices' +
    '?$select=id,deviceName,operatingSystem,lastSyncDateTime&$top=100';

  const devices = [];
  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const data = await httpJson(url, { headers });
    const batch = Array.isArray(data && data.value) ? data.value : [];
    devices.push(...batch.map(normalizeDevice));
    url = data && typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
  }

  devices.sort((a, b) => a.name.localeCompare(b.name));
  logger.info({ count: devices.length }, '[integrations] graph inventory fetched');
  return { devices, fetchedAt: new Date().toISOString() };
}

function status() {
  return {
    id: 'graph',
    name: 'Microsoft Intune (Graph)',
    enabled: isEnabled(),
    configured: isConfigured(),
    mode: 'read-only',
  };
}

module.exports = {
  id: 'graph',
  getDevices,
  status,
  isEnabled,
  isConfigured,
  _normalizeDevice: normalizeDevice,
  _resetTokenCache: () => {
    tokenCache = null;
  },
};
