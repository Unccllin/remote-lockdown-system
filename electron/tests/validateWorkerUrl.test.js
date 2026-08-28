const { validateWorkerUrl } = require('../setup-wizard');

// Mock global fetch for Worker URL validation tests
const originalFetch = global.fetch;

function mockFetch(responses) {
  // responses: { url: { ok, json, status } | 'error' | 'timeout' }
  global.fetch = jest.fn((url, options) => {
    const match = responses[url];
    if (match === 'error') {
      return Promise.reject(new Error('Network error'));
    }
    if (match === 'timeout') {
      // Simulate abort by throwing AbortError
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });
    }
    return Promise.resolve({
      ok: match.ok !== false,
      status: match.status || 200,
      json: () => Promise.resolve(match.json || {}),
    });
  });
}

function restoreFetch() {
  global.fetch = originalFetch;
}

afterEach(() => {
  restoreFetch();
  jest.restoreAllMocks();
});

describe('validateWorkerUrl', () => {
  it('returns ok when /health returns serverless: true', async () => {
    mockFetch({
      'https://worker.example.com/health': {
        ok: true,
        json: { status: 'ok', serverless: true },
      },
    });

    const result = await validateWorkerUrl('https://worker.example.com');
    expect(result.ok).toBe(true);
  });

  it('returns ok when /api/health returns serverless: true (with /api suffix)', async () => {
    mockFetch({
      'https://worker.example.com/health': { ok: false, status: 404 },
      'https://worker.example.com/api/health': {
        ok: true,
        json: { status: 'ok', serverless: true },
      },
    });

    const result = await validateWorkerUrl('https://worker.example.com/api');
    expect(result.ok).toBe(true);
  });

  it('returns error when URL is empty', async () => {
    const result = await validateWorkerUrl('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('required');
  });

  it('returns error when URL is not http/https', async () => {
    const result = await validateWorkerUrl('ftp://worker.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http or https');
  });

  it('returns error for invalid URL format', async () => {
    const result = await validateWorkerUrl('not-a-url');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid URL');
  });

  it('returns error when /health responds but is not serverless', async () => {
    mockFetch({
      'https://express.example.com/health': {
        ok: true,
        json: { status: 'ok', uptimeSeconds: 42 },
      },
    });

    const result = await validateWorkerUrl('https://express.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not appear to be a serverless Worker');
  });

  it('returns error when all candidate URLs are unreachable', async () => {
    mockFetch({
      'https://down.example.com/health': 'error',
      'https://down.example.com/api/health': 'error',
    });

    const result = await validateWorkerUrl('https://down.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not reach');
  });

  it('returns error when /health returns non-OK status', async () => {
    mockFetch({
      'https://broken.example.com/health': { ok: false, status: 500 },
      'https://broken.example.com/api/health': { ok: false, status: 500 },
    });

    const result = await validateWorkerUrl('https://broken.example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not reach');
  });

  it('trims whitespace from URL', async () => {
    mockFetch({
      'https://worker.example.com/health': {
        ok: true,
        json: { status: 'ok', serverless: true },
      },
    });

    const result = await validateWorkerUrl('  https://worker.example.com  ');
    expect(result.ok).toBe(true);
  });

  it('handles URL with trailing slash', async () => {
    mockFetch({
      'https://worker.example.com/health': {
        ok: true,
        json: { status: 'ok', serverless: true },
      },
    });

    const result = await validateWorkerUrl('https://worker.example.com/');
    expect(result.ok).toBe(true);
  });
});
