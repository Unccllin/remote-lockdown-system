import api from './client';

/**
 * Liveness probe — no auth required.
 * @returns {Promise<{ status: string, timestamp: string }>}
 */
export function getHealth() {
  return api.get('/health');
}

/**
 * Detailed health status — admin auth required (auth header injected by
 * the shared axios client interceptor).
 * @returns {Promise<object>} detailed health payload
 */
export function getDetailedHealth() {
  return api.get('/health/detailed');
}
