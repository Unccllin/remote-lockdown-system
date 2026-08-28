import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock axios to capture the create() config and interceptors
const mockInterceptors = {
  request: { use: vi.fn() },
  response: { use: vi.fn() },
};
const mockInstance = {
  interceptors: mockInterceptors,
  defaults: { baseURL: '/api' },
};
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => mockInstance),
  },
}));

import axios from 'axios';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  delete window.electronApp;
});

describe('api client', () => {
  it('creates axios instance with VITE_API_URL when set', async () => {
    // The .env file sets VITE_API_URL — the client should use it.
    // import.meta.env.VITE_API_URL is already populated by Vite.
    vi.resetModules();
    await import('../src/api/client');

    const expectedBase = import.meta.env.VITE_API_URL || '/api';
    expect(axios.create).toHaveBeenCalledWith({ baseURL: expectedBase });
  });

  it('creates axios instance with /api when VITE_API_URL is not set', async () => {
    // Stub the env var to be empty, then re-import
    vi.stubEnv('VITE_API_URL', '');
    vi.resetModules();
    await import('../src/api/client');

    expect(axios.create).toHaveBeenCalledWith({ baseURL: '/api' });
    vi.unstubAllEnvs();
  });

  it('uses window.electronApp.apiBaseUrl when set (Electron serverless mode)', async () => {
    // Simulate Electron preload injecting the API URL
    const workerUrl = 'https://lockdown-serverless.example.workers.dev/api';
    window.electronApp = { apiBaseUrl: workerUrl };
    vi.stubEnv('VITE_API_URL', 'https://should-be-overridden.example.com/api');
    vi.resetModules();
    await import('../src/api/client');

    expect(axios.create).toHaveBeenCalledWith({ baseURL: workerUrl });
    vi.unstubAllEnvs();
    delete window.electronApp;
  });

  it('falls back to VITE_API_URL when electronApp.apiBaseUrl is null (Electron local mode)', async () => {
    window.electronApp = { apiBaseUrl: null };
    vi.stubEnv('VITE_API_URL', 'https://worker.example.com/api');
    vi.resetModules();
    await import('../src/api/client');

    expect(axios.create).toHaveBeenCalledWith({ baseURL: 'https://worker.example.com/api' });
    vi.unstubAllEnvs();
    delete window.electronApp;
  });

  it('falls back to /api when neither electronApp nor VITE_API_URL is set', async () => {
    window.electronApp = { apiBaseUrl: null };
    vi.stubEnv('VITE_API_URL', '');
    vi.resetModules();
    await import('../src/api/client');

    expect(axios.create).toHaveBeenCalledWith({ baseURL: '/api' });
    vi.unstubAllEnvs();
    delete window.electronApp;
  });

  it('registers request and response interceptors', async () => {
    vi.resetModules();
    await import('../src/api/client');

    expect(mockInterceptors.request.use).toHaveBeenCalledTimes(1);
    expect(mockInterceptors.response.use).toHaveBeenCalledTimes(1);
  });

  it('response interceptor clears both token and user on 401 when token was present', async () => {
    vi.resetModules();
    await import('../src/api/client');

    // The response interceptor is the second argument to response.use
    const errorHandler = mockInterceptors.response.use.mock.calls[0][1];

    // Set up localStorage with a stale token and user
    localStorage.setItem('token', 'stale-jwt-token');
    localStorage.setItem('user', JSON.stringify({ username: 'admin' }));

    // Simulate a 401 response — the interceptor should reject
    const err = {
      response: { status: 401 },
      config: { headers: {} },
    };

    // Mock window.location
    const originalLocation = window.location;
    delete window.location;
    window.location = { href: '', pathname: '/devices' };

    await expect(errorHandler(err)).rejects.toBeDefined();

    // Both token and user should be cleared
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();

    // Restore
    window.location = originalLocation;
  });
});
