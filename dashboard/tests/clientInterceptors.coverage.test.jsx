import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Covers api/client.js's interceptors and utils/time.jsx.
 *
 * Both were largely uncovered, and the client's 401 handling is real behaviour worth pinning:
 * a 401 with a stored token must clear it and redirect, while a 401 on the login page must NOT
 * redirect (that would wipe the error toast the user needs to see).
 */
const handlers = { request: null, responseOk: null, responseErr: null };

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      interceptors: {
        request: { use: (fn) => { handlers.request = fn; } },
        response: { use: (ok, err) => { handlers.responseOk = ok; handlers.responseErr = err; } },
      },
    })),
  },
}));

let client;
let time;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  client = (await import('../src/api/client')).default;
  time = await import('../src/utils/time');
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('api/client interceptors', () => {
  it('attaches the bearer token when one is stored', () => {
    localStorage.setItem('token', 'abc123');
    const config = { headers: {} };
    const out = handlers.request(config);
    expect(out.headers.Authorization).toBe('Bearer abc123');
  });

  it('leaves the header alone when no token is stored', () => {
    const config = { headers: {} };
    handlers.request(config);
    expect(config.headers.Authorization).toBeUndefined();
  });

  it('passes successful responses through untouched', () => {
    const res = { data: 'ok' };
    expect(handlers.responseOk(res)).toBe(res);
  });

  it('clears credentials and redirects on a 401 with a stored token', () => {
    localStorage.setItem('token', 'stale');
    localStorage.setItem('user', '{"name":"x"}');
    // jsdom cannot navigate; stub the setter so the assertion is on intent, not on jsdom.
    delete window.location;
    window.location = { pathname: '/devices', href: '' };

    const err = { response: { status: 401 } };
    expect(handlers.responseErr(err)).rejects.toBe(err);
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(window.location.href).toBe('/login');
  });

  it('does not redirect on a 401 from the login page', () => {
    localStorage.setItem('token', 'stale');
    delete window.location;
    window.location = { pathname: '/login', href: '' };

    const err = { response: { status: 401 } };
    expect(handlers.responseErr(err)).rejects.toBe(err);
    expect(localStorage.getItem('token')).toBeNull();
    expect(window.location.href).toBe('');
  });

  it('ignores non-401 errors', () => {
    localStorage.setItem('token', 'keep');
    const err = { response: { status: 500 } };
    expect(handlers.responseErr(err)).rejects.toBe(err);
    expect(localStorage.getItem('token')).toBe('keep');
  });

  it('exports the created instance', () => {
    expect(client).toBeTruthy();
  });
});

describe('utils/time', () => {
  it('formats a valid timestamp and falls back on nonsense', () => {
    const out = time.safeFromNow(new Date().toISOString(), 'n/a');
    expect(typeof out).toBe('string');
    expect(out).not.toBe('n/a');
    // Invalid input must never throw or render "Invalid Date".
    expect(time.safeFromNow('not-a-date', 'n/a')).toBe('n/a');
    expect(time.safeFormat('not-a-date', 'PP', 'n/a')).toBe('n/a');
  });

  it('uses the default fallback when none is supplied', () => {
    expect(time.safeFromNow(null)).toBe('—');
  });
});
