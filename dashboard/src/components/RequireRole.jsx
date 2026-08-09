import { Navigate } from 'react-router-dom';
import { useCurrentUser, ROLE_HIERARCHY } from '../hooks/useCurrentUser';

/**
 * Route guard component that restricts access to users with a minimum role.
 *
 * Usage in App.jsx:
 *   <Route path="admins" element={
 *     <RequireRole role="super-admin"><AdminsPage /></RequireRole>
 *   } />
 *
 * If the user is not authenticated (no token), redirects to /login.
 * If the user's role is below the required level, redirects to / (overview).
 *
 * This is a UX guard — the server enforces authorization independently
 * via the requireRole() middleware on every API endpoint.
 */
export default function RequireRole({ role, children }) {
  const user = useCurrentUser();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const userLevel = ROLE_HIERARCHY[user.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[role] ?? 99;

  if (userLevel < requiredLevel) {
    return <Navigate to="/" replace />;
  }

  return children;
}
