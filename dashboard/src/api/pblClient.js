/**
 * PBL API client — for /v1/* endpoints (PBL firmware + admin management).
 *
 * The PBL endpoints use a different base URL than the agent /api/* endpoints.
 * In serverless mode, both are served by the same Worker, so the base URL
 * is the same minus the /api suffix. In local mode, the Express server
 * doesn't serve PBL endpoints (they're Worker-only), so we use the
 * electronApiUrl or VITE_API_URL directly.
 */

import axios from 'axios';

// PBL base URL: same origin as the main API but without the /api suffix
const electronApiUrl = typeof window !== 'undefined' && window.electronApp?.apiBaseUrl;
const pblBaseURL = electronApiUrl || import.meta.env.VITE_API_URL || '';

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
