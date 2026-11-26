/**
 * Setup API client — first-run admin creation.
 */
import api from './client';

export const setupApi = {
  getStatus: () => api.get('/setup/status'),
  // The setup token is the deployment's ADMIN_TOKEN. It is what stops the first visitor to a fresh
  // deployment from making themselves super-admin (review S1), so it travels in a header rather
  // than the body: bodies end up in logs more often than headers do.
  createAdmin: (username, password, setupToken) =>
    api.post(
      '/setup/create-admin',
      { username, password },
      { headers: { 'X-Setup-Token': setupToken } },
    ),
};
