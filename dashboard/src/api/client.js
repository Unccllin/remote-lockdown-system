import axios from 'axios';

// When VITE_API_URL is set (e.g. pointing at the Cloudflare Worker),
// use it as the base URL. Otherwise default to same-origin /api (the
// Express server serves both the dashboard and the API).
const baseURL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({ baseURL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      // Only force-redirect to /login when a token was present (expired
      // session). A 401 from the login endpoint itself (wrong credentials)
      // must NOT redirect — the caller's catch handler shows the error toast,
      // and a full-page reload here would wipe it before the user sees it.
      const hadToken = Boolean(localStorage.getItem('token'));
      const isOnLogin = window.location.pathname.startsWith('/login');
      if (hadToken && !isOnLogin) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      } else if (hadToken) {
        // On the login page with a stale token — just clear it, no redirect.
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
    return Promise.reject(err);
  }
);

export default api;
