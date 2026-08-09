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
 */
function decodeUser() {
  try {
    const token = localStorage.getItem('token');
    if (!token) return null;
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    const role = decoded.role || 'viewer';
    return {
      id: decoded.id,
      username: decoded.username,
      role,
      isViewer: role === 'viewer',
      isOperator: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.operator,
      isSuperAdmin: ROLE_HIERARCHY[role] >= ROLE_HIERARCHY['super-admin'],
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
