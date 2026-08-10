# Skill Domain: Phase 16 — RBAC / Multi-Admin

## Context
Currently the system supports a single admin account. Production deployments need multiple admins with different permission levels (viewer, operator, super-admin).

## Current State
- server/src/middleware/auth.js — `requireAuth` middleware, sets `req.admin` from JWT
- server/src/routes/setup.js — creates first admin account
- server/src/routes/auth.js — login endpoint
- `admins` table exists in migrations (001_base.sql)
- No role/permission system
- No admin management UI

## Research Findings
### Role Design
Three roles:
1. **viewer** — read-only: view devices, audit log, health, map. Cannot flag stolen, recover, enroll, or manage admins.
2. **operator** — operational: everything viewer can do + flag stolen, recover, enroll devices, download agent installer. Cannot manage admins.
3. **super-admin** — full access: everything operator can do + manage admins, rotate keys, system config.

### Permission Matrix
| Action | viewer | operator | super-admin |
|--------|--------|----------|-------------|
| View devices | ✓ | ✓ | ✓ |
| View audit log | ✓ | ✓ | ✓ |
| View health | ✓ | ✓ | ✓ |
| View map | ✓ | ✓ | ✓ |
| Flag stolen | ✗ | ✓ | ✓ |
| Recover device | ✗ | ✓ | ✓ |
| Enroll device | ✗ | ✓ | ✓ |
| Download installer | ✗ | ✓ | ✓ |
| Manage admins | ✗ | ✗ | ✓ |
| Rotate API keys | ✗ | ✗ | ✓ |
| Create admin | ✗ | ✗ | ✓ |

### Database Changes
- Add `role` column to `admins` table (default: 'viewer')
- First admin created via setup endpoint gets 'super-admin' role
- New migration: `007_rbac.sql`

### API Changes
- `requireRole(role)` middleware — checks `req.admin.role`
- Apply to routes:
  - `requireRole('operator')` — flag stolen, recover, enroll, installer
  - `requireRole('super-admin')` — admin management, key rotation
  - `requireAuth` only (any role) — view devices, audit, health, map

### Admin Management
- `GET /api/admins` — list admins (super-admin only)
- `POST /api/admins` — create admin (super-admin only)
- `DELETE /api/admins/:id` — delete admin (super-admin only, can't delete self)
- `PATCH /api/admins/:id` — update role (super-admin only)

### Dashboard Changes
- Admin management page (super-admin only)
- Hide/disable actions based on role
- Show current user's role in UI

## Reasoning Questions
1. **Should roles be hardcoded or configurable?**
   - Answer: Hardcoded three roles. Configurable RBAC (arbitrary permissions) adds complexity without value for this use case. Three tiers cover all realistic scenarios.

2. **Should the first admin always be super-admin?**
   - Answer: Yes. The setup endpoint creates the first admin with super-admin role. Subsequent admins are created by super-admin with chosen roles.

3. **Should JWT include the role?**
   - Answer: Yes. Include `role` in JWT payload. The `requireRole` middleware reads it from `req.admin.role` (set by `requireAuth` from JWT). This avoids a DB query on every request.

4. **Should role changes require re-login?**
   - Answer: Yes. Role is in JWT, so changing a user's role requires them to get a new token (re-login). Document this. Alternative: check role from DB on every request — too slow.

5. **Can a super-admin demote themselves?**
   - Answer: No. Prevent super-admin from changing their own role or deleting themselves. Ensure at least one super-admin always exists.

## Implementation Guidelines
### server/src/db/migrations/007_rbac.sql
```sql
ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer';
-- First admin gets super-admin in setup route
```
Also create SQLite equivalent in migrations-sqlite/

### server/src/middleware/auth.js (edit)
Add `requireRole(minRole)` function:
```js
const ROLE_HIERARCHY = { viewer: 0, operator: 1, 'super-admin': 2 };
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({error: 'Unauthorized'});
    if (ROLE_HIERARCHY[req.admin.role] < ROLE_HIERARCHY[minRole])
      return res.status(403).json({error: 'Insufficient permissions'});
    next();
  };
}
```

### server/src/routes/admins.js (new)
- GET / — list admins (super-admin)
- POST / — create admin (super-admin)
- DELETE /:id — delete admin (super-admin, can't delete self)
- PATCH /:id — update role (super-admin, can't change own role)

### server/src/routes/setup.js (edit)
- Set first admin role to 'super-admin'

### server/src/routes/auth.js (edit)
- Include `role` in JWT payload

### server/src/routes/devices.js (edit)
- Add `requireRole('operator')` to flag-stolen, recover, enroll routes

### dashboard/src/pages/AdminsPage.jsx (new)
- List admins, create/delete, change roles
- Route: /admins (super-admin only)

### dashboard/src/api/admins.js (new)
- API client for admin management

### dashboard/src/App.jsx (edit)
- Add /admins route

### dashboard/src/components/DashboardLayout.jsx (edit)
- Show role-based nav items
- Show current user role

### server/tests/admins.routes.test.js (new)
- Test role enforcement
- Test admin CRUD
- Test self-protection rules

## File Boundaries
- CREATE: `server/src/routes/admins.js`, `server/src/db/migrations/007_rbac.sql`, `server/src/db/migrations-sqlite/007_rbac.sql`, `server/tests/admins.routes.test.js`, `dashboard/src/pages/AdminsPage.jsx`, `dashboard/src/api/admins.js`
- EDIT: `server/src/middleware/auth.js` (add requireRole), `server/src/routes/setup.js` (set super-admin), `server/src/routes/auth.js` (role in JWT), `server/src/routes/devices.js` (add role middleware), `server/src/index.js` (register admins route), `dashboard/src/App.jsx` (add route), `dashboard/src/components/DashboardLayout.jsx` (role-based nav)
- DO NOT REWRITE: existing route logic, auth flow

## Graph Integration

**Phase node**: `P16` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P16` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-SERVER,V-DASHBOARD,V-LINT-SERVER,V-LINT-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

