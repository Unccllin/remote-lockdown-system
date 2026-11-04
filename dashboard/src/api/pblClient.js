/**
 * PBL API client — for /v1/* endpoints (PBL firmware + admin management).
 *
 * The PBL endpoints live at the SERVER ROOT (/v1/*), not under /api/*, and both
 * backends serve them: the Express server mounts `/v1` (server/src/index.js) and
 * the Worker answers the same paths. So the base is the configured API URL with
 * its trailing `/api` removed.
 *
 * This is the bug that made the dashboard's "Signing Keys" panel 404 with
 * "Available routes are under /api/...": the base was used verbatim, so
 * `/v1/admin/key-info` became `/api/v1/admin/key-info`, which matches no route.
 * The comment above the code had always said "without the /api suffix" — only the
 * code disagreed with it.
 */

import axios from 'axios';

/**
 * Strip a trailing `/api` (and any trailing slash) from a base URL.
 * A base with no /api suffix is returned unchanged; an empty base stays empty so
 * the client resolves against the current origin.
 */
export function pblBaseUrl(raw) {
  if (!raw) return '';
  return raw.replace(/\/api\/?$/, '').replace(/\/$/, '');
}

const electronApiUrl = typeof window !== 'undefined' && window.electronApp?.apiBaseUrl;
const pblBaseURL = pblBaseUrl(electronApiUrl || import.meta.env.VITE_API_URL || '');

const pblApi = axios.create({ baseURL: pblBaseURL });

pblApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// PBL device management API methods
export const pblDevices = {
  list: () => pblApi.get('/v1/devices'),
  get: (id) => pblApi.get(`/v1/devices/${id}`),
  lock: (id) => pblApi.post(`/v1/devices/${id}/lock`),
  unlock: (id) => pblApi.post(`/v1/devices/${id}/unlock`),
  track: (id) => pblApi.post(`/v1/devices/${id}/track`),
  stopTrack: (id) => pblApi.post(`/v1/devices/${id}/stop-track`),
  delete: (id) => pblApi.delete(`/v1/devices/${id}`),
  // D-206: PBL ↔ agent device identity mapping
  getAgentMapping: (id) => pblApi.get(`/v1/devices/${id}/agent-mapping`),
  linkAgentMapping: (id, agentDeviceId) =>
    pblApi.post(`/v1/devices/${id}/agent-mapping`, { agent_device_id: agentDeviceId }),
  unlinkAgentMapping: (id) => pblApi.delete(`/v1/devices/${id}/agent-mapping`),
};

// D-209: PBL policy management API methods
export const pblPolicy = {
  // GET /v1/policy — list all policy versions (admin only)
  list: () => pblApi.get('/v1/policy'),
  // GET /v1/policy/:version — returns COSE_Sign1 blob (binary)
  get: (version) => pblApi.get(`/v1/policy/${version}`, { responseType: 'arraybuffer' }),
  // POST /v1/policy — stores a pre-signed policy blob (super-admin only)
  store: (blob, version) => pblApi.post('/v1/policy', blob, {
    headers: { 'Content-Type': 'application/cbor' },
    params: version ? { version } : undefined,
  }),
  // POST /v1/policy/create — form-based policy creation (super-admin only)
  // Accepts JSON with policy fields, server encodes CBOR + signs + stores
  create: (fields) => pblApi.post('/v1/policy/create', fields, {
    headers: { 'Content-Type': 'application/json' },
  }),
};

// D-209: PBL admin key info API methods
export const pblAdmin = {
  getKeyInfo: () => pblApi.get('/v1/admin/key-info'),
};

export default pblApi;
