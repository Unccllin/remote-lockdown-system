import { describe, it, expect } from 'vitest';
import { pblBaseUrl } from '../src/api/pblClient';

/**
 * The PBL endpoints live at the server root (/v1/*), not under /api/*. The client
 * used to take VITE_API_URL verbatim, so `pblApi.get('/v1/admin/key-info')` became
 * `/api/v1/admin/key-info` and the dashboard's "Signing Keys" panel showed
 * "Not found. Check the API endpoint path and method..." (S203).
 */
describe('pblBaseUrl', () => {
  it('strips a trailing /api (the main client base)', () => {
    expect(pblBaseUrl('http://localhost:3001/api')).toBe('http://localhost:3001');
  });

  it('strips /api plus a trailing slash', () => {
    expect(pblBaseUrl('https://lockdown.example.com/api/')).toBe('https://lockdown.example.com');
  });

  it('leaves a base without /api unchanged', () => {
    expect(pblBaseUrl('https://lockdown-serverless.example.workers.dev')).toBe(
      'https://lockdown-serverless.example.workers.dev'
    );
  });

  it('returns empty for an unset base (same origin)', () => {
    expect(pblBaseUrl('')).toBe('');
    expect(pblBaseUrl(undefined)).toBe('');
  });

  it('does not strip a path segment that merely ends in "api"', () => {
    expect(pblBaseUrl('https://example.com/myapi')).toBe('https://example.com/myapi');
  });
});
