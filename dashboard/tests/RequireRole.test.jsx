import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RequireRole from '../src/components/RequireRole';
import { setupUser } from './setup';

// Mock the current user hook
vi.mock('../src/hooks/useCurrentUser', () => ({
  useCurrentUser: vi.fn(),
  ROLE_HIERARCHY: { viewer: 0, operator: 1, 'super-admin': 2 },
}));

import { useCurrentUser } from '../src/hooks/useCurrentUser';

function renderWithRouter(user, requiredRole) {
  useCurrentUser.mockReturnValue(user);
  return render(
    <MemoryRouter initialEntries={['/protected']}>
      <Routes>
        <Route
          path="/protected"
          element={
            <RequireRole role={requiredRole}>
              <div>Protected Content</div>
            </RequireRole>
          }
        />
        <Route path="/" element={<div>Overview Page</div>} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setupUser('operator');
});

describe('RequireRole', () => {
  it('renders children when user has sufficient role', () => {
    renderWithRouter(
      { id: 'u1', username: 'admin', role: 'super-admin', isSuperAdmin: true },
      'operator'
    );
    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('renders children when user has exactly the required role', () => {
    renderWithRouter(
      { id: 'u1', username: 'op', role: 'operator', isOperator: true },
      'operator'
    );
    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });

  it('redirects to / when user role is below required', () => {
    renderWithRouter(
      { id: 'u1', username: 'viewer', role: 'viewer', isViewer: true },
      'super-admin'
    );
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    expect(screen.getByText('Overview Page')).toBeInTheDocument();
  });

  it('redirects to /login when user is null (not authenticated)', () => {
    renderWithRouter(null, 'operator');
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('allows super-admin to access super-admin-only content', () => {
    renderWithRouter(
      { id: 'u1', username: 'admin', role: 'super-admin', isSuperAdmin: true },
      'super-admin'
    );
    expect(screen.getByText('Protected Content')).toBeInTheDocument();
  });
});
