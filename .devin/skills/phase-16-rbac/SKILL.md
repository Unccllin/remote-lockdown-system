---
name: phase-16-rbac
description: Role-based access control with viewer, operator, and super-admin roles plus admin management UI
---

# Phase 16 — RBAC / Multi-Admin

## Context

The system supports multiple admins with different permission levels (viewer,
operator, super-admin). Production deployments need role-based access control
for multi-admin scenarios.

## Current State

### Role System
Three hardcoded roles:
1. **viewer** — read-only: view devices, audit log, health, map. Cannot flag stolen, recover, enroll, or manage admins.
2. **operator** — operational: everything viewer can do + flag stolen, recover, enroll devices, download agent installer. Cannot manage admins.
3. **super-admin** — full access: everything operator can do + manage admins, rotate keys, system config.

### Permission Matrix
| Action | viewer | operator | super-admin |
|--------|--------|----------|-------------|
| View devices | Y | Y | Y |
| View audit log | Y | Y | Y |
| View health | Y | Y | Y |
| View map | Y | Y | Y |
| Flag stolen | N | Y | Y |
| Recover device | N | Y | Y |
| Enroll device | N | Y | Y |
| Download installer | N | Y | Y |
| Manage admins | N | N | Y |
| Rotate API keys | N | N | Y |
| Create admin | N | N | Y |

### Database
- `server/src/db/migrations/007_rbac.sql` — PostgreSQL migration (`ALTER TABLE admins ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'`)
- `server/src/db/migrations-sqlite/007_rbac.sql` — SQLite equivalent
- First admin created via setup endpoint gets `super-admin` role

### Server
- `server/src/middleware/auth.js` — `requireAuth` middleware + `requireRole(minRole)` function
  - `ROLE_HIERARCHY = { viewer: 0, operator: 1, 'super-admin': 2 }`
  - `requireRole('operator')` applied to flag-stolen, recover, enroll, installer routes
  - `requireRole('super-admin')` applied to admin management, key rotation routes
  - `requireAuth` only (any role) for view routes (devices, audit, health, map)
- `server/src/routes/admins.js` — admin management routes
  - `GET /api/admins` — list admins (super-admin only)
  - `POST /api/admins` — create admin (super-admin only)
  - `DELETE /api/admins/:id` — delete admin (super-admin only, can't delete self)
  - `PATCH /api/admins/:id` — update role (super-admin only, can't change own role)
- `server/src/routes/setup.js` — sets first admin role to `super-admin`
- `server/src/routes/auth.js` — includes `role` in JWT payload
- `server/src/routes/devices.js` — `requireRole('operator')` on flag-stolen, recover, enroll routes
- `server/src/index.js` — registers admins route
- `server/tests/admins.routes.test.js` — tests for role enforcement, admin CRUD, self-protection rules

### Dashboard
- `dashboard/src/pages/AdminsPage.jsx` — admin management page (super-admin only)
  - List admins, create/delete, change roles
  - Route: `/admins` (super-admin only)
- `dashboard/src/api/admins.js` — API client for admin management
- `dashboard/src/App.jsx` — `/admins` route added
- `dashboard/src/components/DashboardLayout.jsx` — role-based nav items, shows current user role
- `dashboard/tests/AdminsPage.test.jsx` — component tests
- `dashboard/tests/RequireRole.test.jsx` — role guard tests
- `dashboard/tests/useCurrentUser.test.jsx` — current user hook tests

## Verification

```bash
# Run admin route tests (role enforcement, CRUD, self-protection)
cd server && npx jest tests/admins.routes.test.js --verbose

# Run dashboard admin page tests
cd dashboard && npx vitest run tests/AdminsPage.test.jsx tests/RequireRole.test.jsx tests/useCurrentUser.test.jsx

# Verify RBAC migration exists (both PG and SQLite)
ls server/src/db/migrations/007_rbac.sql server/src/db/migrations-sqlite/007_rbac.sql

# Verify requireRole middleware exists
grep -n "requireRole" server/src/middleware/auth.js

# Verify admins route is registered
grep -n "admins" server/src/index.js

# Verify role is in JWT payload
grep -n "role" server/src/routes/auth.js

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify first admin gets super-admin role**: `grep -i "super-admin" server/src/routes/setup.js`
2. **Verify JWT includes role**: `grep -i "role" server/src/routes/auth.js`
3. **Verify super-admin can't demote themselves**: `cd server && npx jest tests/admins.routes.test.js -t "self"`
4. **Verify super-admin can't delete themselves**: `cd server && npx jest tests/admins.routes.test.js -t "delete.*self"`
5. **Verify at least one super-admin always exists**: `grep -i "super-admin\|at least" server/src/routes/admins.js`
6. **Verify role changes require re-login (role in JWT)**: `grep -i "role.*jwt\|jwt.*role\|re-login" server/src/middleware/auth.js server/src/routes/auth.js`
7. **Verify dashboard hides actions based on role**: `grep -i "role\|RequireRole" dashboard/src/components/DashboardLayout.jsx`

## Gotchas

- Roles are hardcoded (not configurable) — three tiers cover all realistic scenarios; configurable RBAC adds complexity without value
- Role is in JWT payload — changing a user's role requires them to get a new token (re-login). Alternative: check role from DB on every request (too slow)
- Super-admin cannot demote themselves or delete themselves — ensures at least one super-admin always exists
- `requireRole` reads `req.admin.role` (set by `requireAuth` from JWT) — avoids a DB query on every request

## Graph Integration

**Phase node**: `P16` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P16` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-DASHBOARD, V-LINT-SERVER, V-LINT-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
