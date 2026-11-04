import api from './client';

/**
 * Read-only device inventory.
 *
 * These are OUR endpoints (`/api/integrations`, `/api/integrations/:id/devices`),
 * not an upstream's: the server's connector registry normalizes whatever
 * management source is configured into one shape, so this module never names a
 * vendor and the UI never has to know which one answered.
 *
 * The surface is deliberately read-only. Lockdown/unlock/policy changes go
 * through our own command queue and audit log, never through a third-party API
 * (docs/adr/INTEGRATION-OWNERSHIP.md).
 */

/**
 * Status of each configured source.
 * Shape: [{ id, name, enabled, configured, mode }] — `name` is the upstream's and
 * is not rendered; the UI speaks in our terms.
 */
export async function getInventoryStatus() {
  const { data } = await api.get('/integrations');
  return data.integrations || [];
}

/**
 * Normalized inventory from one source.
 * Shape: { source, readOnly, fetchedAt, devices: [{ id, name, online, lastSeenAt,
 * platform }] }
 *
 * Throws an axios error whose `response.data.code` is one of
 * NOT_CONFIGURED (503) / UPSTREAM_ERROR (502), which callers render as a
 * degraded notice rather than a failure of the page.
 */
export async function getInventoryDevices(sourceId) {
  const { data } = await api.get(`/integrations/${encodeURIComponent(sourceId)}/devices`);
  return data;
}
