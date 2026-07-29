import api from './client';

/**
 * Phase 16: Admin management API client.
 * All endpoints require super-admin role (enforced server-side).
 */

export function listAdmins() {
  return api.get('/admins');
}

export function createAdmin(data) {
  // data: { username, password, role }
  return api.post('/admins', data);
}

export function deleteAdmin(id) {
  return api.delete(`/admins/${id}`);
}

export function updateAdminRole(id, role) {
  return api.patch(`/admins/${id}`, { role });
}
