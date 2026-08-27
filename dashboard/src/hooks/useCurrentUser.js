import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Role hierarchy — higher values inherit all permissions of lower ones.
 * Mirrors the server-side ROLE_HIERARCHY in server/src/middleware/auth.js.
 */
const ROLE_HIERARCHY = { viewer: 0, operator: 1, 'super-admin': 2 };

/**
 * Decode the JWT payload from localStorage to get the current user's
 * id, username, and role. Returns null if the token is missing or invalid.
 *
 * This consolidates the duplicated getCurrentUser() functions that were
 * previously in DashboardLayout.jsx and AdminsPage.jsx.
 *
 * When the token is not a JWT (e.g. a raw admin token from the Cloudflare
 * Worker), falls back to treating the bearer as a super-admin — the Worker
 * only has one admin role.
 */
function decodeUser() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;

    // Try JWT decode first (Express server path)
    const parts = token.split('.');
    if (parts.length === 3) {
      const decoded = JSON.parse(atob(parts[1]));
      const role = decoded.role || 'viewer';
      return {
        id: decoded.id,
        username: decoded.username,
        role,
        isViewer: role === 'viewer',
        isOperator: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.operator,
        isSuperAdmin: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY['super-admin'],
      };
    }

    // Not a JWT — treat as a raw bearer token (Worker auth).
    // The Worker's /auth/login returns { user: { username: 'admin', role: 'super-admin' } }
    // Store that user info alongside the token so we can recover it here.
    const userJson = localStorage.getItem('user');
    if (userJson) {
      const u = JSON.parse(userJson);
      const role = u.role || 'super-admin';
      return {
        id: u.id || 'admin',
        username: u.username || 'admin',
        role,
        isViewer: role === 'viewer',
        isOperator: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.operator,
        isSuperAdmin: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY['super-admin'],
      };
    }

    // Token exists but no user info — assume super-admin (Worker single-admin mode)
    return {
      id: 'admin',
      username: 'admin',
      role: 'super-admin',
      isViewer: false,
      isOperator: true,
      isSuperAdmin: true,
    };
  } catch {
    return null;
  }
}

/**
 * Hook that provides the current authenticated user's identity and role.
 *
 * Returns an object with:
 *   - id, username, role          — raw JWT claims
 *   - isViewer                    — true if role is exactly 'viewer'
 *   - isOperator                  — true if role is operator or higher
 *   - isSuperAdmin                — true if role is super-admin
 *
 * Returns null if no valid token is present (fail closed — callers should
 * treat null as "no access" and hide restricted UI).
 *
 * The user is re-decoded on every route change to stay in sync if the
 * token is replaced (e.g. after login or role change + re-login).
 */
export function useCurrentUser() {
  const [user, setUser] = useState(decodeUser);
  const location = useLocation();

  useEffect(() => {
    setUser(decodeUser());
  }, [location.pathname]);

  return user;
}

export { ROLE_HIERARCHY };
