import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useCurrentUser } from '../src/hooks/useCurrentUser';

beforeEach(() => {
  localStorage.clear();
});

// useCurrentUser uses useLocation() from react-router, so it needs a Router.
function wrapper({ children }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

// Helper: create a fake JWT with a given payload
function makeJWT(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe('useCurrentUser — JWT path (Express server)', () => {
  it('decodes a JWT token and returns the user with role flags', () => {
    localStorage.setItem('token', makeJWT({ id: 'u1', username: 'alice', role: 'operator' }));

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current).toEqual({
      id: 'u1',
      username: 'alice',
      role: 'operator',
      isViewer: false,
      isOperator: true,
      isSuperAdmin: false,
    });
  });

  it('defaults role to viewer when JWT has no role field', () => {
    localStorage.setItem('token', makeJWT({ id: 'u2', username: 'bob' }));

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current.role).toBe('viewer');
    expect(result.current.isViewer).toBe(true);
    expect(result.current.isOperator).toBe(false);
    expect(result.current.isSuperAdmin).toBe(false);
  });

  it('returns null when no token is stored', () => {
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    expect(result.current).toBeNull();
  });
});

describe('useCurrentUser — non-JWT path (Cloudflare Worker)', () => {
  it('falls back to stored user JSON when token is not a JWT', () => {
    localStorage.setItem('token', 'raw-admin-token-not-a-jwt');
    localStorage.setItem('user', JSON.stringify({ username: 'admin', role: 'super-admin' }));

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current).toEqual({
      id: 'admin',
      username: 'admin',
      role: 'super-admin',
      isViewer: false,
      isOperator: true,
      isSuperAdmin: true,
    });
  });

  it('falls back to stored user JSON with custom id', () => {
    localStorage.setItem('token', 'some-bearer-token');
    localStorage.setItem('user', JSON.stringify({ id: 'worker-admin', username: 'admin', role: 'super-admin' }));

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current.id).toBe('worker-admin');
    expect(result.current.isSuperAdmin).toBe(true);
  });

  it('defaults to super-admin when token exists but no user JSON stored', () => {
    localStorage.setItem('token', 'orphan-token-no-user-info');

    const { result } = renderHook(() => useCurrentUser(), { wrapper });

    expect(result.current).toEqual({
      id: 'admin',
      username: 'admin',
      role: 'super-admin',
      isViewer: false,
      isOperator: true,
      isSuperAdmin: true,
    });
  });

  it('returns null when no token and no user stored', () => {
    const { result } = renderHook(() => useCurrentUser(), { wrapper });
    expect(result.current).toBeNull();
  });
});
