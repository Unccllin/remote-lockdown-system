import api from './client';

/**
 * Re-arm approvals (ADR-011, D-226).
 *
 * `POST /api/rearm` is unauthenticated by necessity — the firmware bootstrap that calls it carries no
 * device secret — so the decision to re-key a flagged device is made here, by a super-admin. These are
 * the endpoints that decision goes through; approving is single-use and expires after 15 minutes, so
 * the technician at the machine has to retry within that window.
 *
 * Both backends expose the same routes (Express and the Worker), so this works in either mode.
 */

export function listRearmRequests() {
  return api.get('/admin/rearm-requests');
}

export function approveRearmRequest(deviceId) {
  return api.post(`/admin/rearm-requests/${encodeURIComponent(deviceId)}/approve`);
}

export function denyRearmRequest(deviceId) {
  return api.post(`/admin/rearm-requests/${encodeURIComponent(deviceId)}/deny`);
}
