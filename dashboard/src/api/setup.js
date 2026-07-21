/**
 * Setup API client — first-run admin creation.
 */
import api from './client';

export const setupApi = {
  getStatus: () => api.get('/setup/status'),
  createAdmin: (username, password) =>
    api.post('/setup/create-admin', { username, password }),
};
