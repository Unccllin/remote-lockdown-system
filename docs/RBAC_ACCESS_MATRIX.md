# RBAC Access Matrix

The Remote Lockdown System has three admin roles with increasing
privilege. This matrix documents which role can access which API endpoint
and dashboard feature.

## Role hierarchy

| Role | Level | Description |
|------|-------|-------------|
| `viewer` | 0 | Read-only access to devices, audit log, locations |
| `operator` | 1 | Can manage devices: enroll, flag stolen, recover, track, locate |
| `super-admin` | 2 | Full access: admin management, PBA credentials, key rotation, all operator actions |

Role hierarchy is enforced by `requireRole(minRole)` middleware in
`server/src/middleware/auth.js`. A higher role inherits all permissions
of lower roles.

## API endpoint matrix

### Authentication (no auth required)

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `/api/auth/login` | POST | None | Returns JWT with role |
| `/api/setup/status` | GET | None | Check if initial setup needed |
| `/api/setup/create-admin` | POST | None | Only works if no admins exist |
| `/api/health` | GET | None | Liveness probe |
| `/api/health/ready` | GET | None | Readiness probe |
| `/metrics` | GET | None | Prometheus endpoint (no auth by design) |

### Devices

| Endpoint | Method | Min Role | Notes |
|----------|--------|----------|-------|
| `/api/devices` | GET | viewer | List all devices |
| `/api/devices/:id` | GET | viewer | View device details |
| `/api/devices` | POST | operator | Enroll a new device |
| `/api/devices/:id` | PATCH | operator | Update device metadata |
| `/api/devices/:id` | DELETE | operator | Delete device (blocked if unreleased keys) |
| `/api/devices/:id/flag-stolen` | POST | operator | Flag device as stolen, queue lockdown |
| `/api/devices/:id/recover` | POST | operator | Recover device, release key |
| `/api/devices/:id/track` | POST | operator | Start covert tracking |
| `/api/devices/:id/locate` | POST | operator | Request immediate location |
| `/api/devices/:id/stop-track` | POST | operator | Stop tracking |
| `/api/devices/:id/locations` | GET | viewer | Location history |
| `/api/devices/:id/location/latest` | GET | viewer | Latest location |
| `/api/devices/:id/release` | DELETE | operator | Release encryption key manually |
| `/api/devices/:id/rotate-key` | POST | super-admin | Rotate device API key |
| `/api/devices/:id/pba-credentials` | GET | super-admin | Retrieve PBA credentials |
| `/api/devices/settings/retention` | GET | viewer | Location retention settings |

### Admins (all require super-admin)

| Endpoint | Method | Min Role | Notes |
|----------|--------|----------|-------|
| `/api/admins` | GET | super-admin | List all admins |
| `/api/admins` | POST | super-admin | Create new admin |
| `/api/admins/:id` | DELETE | super-admin | Delete admin (can't delete self or last super-admin) |
| `/api/admins/:id` | PATCH | super-admin | Update admin role/password |

### Audit

| Endpoint | Method | Min Role | Notes |
|----------|--------|----------|-------|
| `/api/audit` | GET | viewer | View audit log (all roles can see) |

### Health (detailed)

| Endpoint | Method | Min Role | Notes |
|----------|--------|----------|-------|
| `/api/health/detailed` | GET | viewer | Fleet stats, queue depth, stale devices |

### Installer

| Endpoint | Method | Min Role | Notes |
|----------|--------|----------|-------|
| `/api/installer/:deviceId` | GET | viewer | Download agent installer |
| `/api/installer/:deviceId/nsis` | GET | viewer | Download NSIS installer |
| `/api/installer/agent-version` | GET | viewer | Check available agent version |

### Agent (machine auth, not admin auth)

| Endpoint | Method | Auth | Notes |
|----------|--------|------|-------|
| `/api/agent/checkin` | POST | Agent API key + HMAC | Agent polls for commands |
| `/api/agent/command-ack` | POST | Agent API key + HMAC | Agent confirms command execution |
| `/api/agent/deadman-report` | POST | Agent API key + HMAC | Agent reports deadman key |
| `/api/agent/location` | POST | Agent API key + HMAC | Agent reports location |
| `/api/agent/update` | GET | Agent API key | Check for agent binary updates |
| `/api/agent/download` | GET | Agent API key | Download agent binary |

## Dashboard feature matrix

| Feature | viewer | operator | super-admin |
|---------|--------|----------|-------------|
| View device list | Yes | Yes | Yes |
| View device details | Yes | Yes | Yes |
| View audit log | Yes | Yes | Yes |
| View health page | Yes | Yes | Yes |
| View location history | Yes | Yes | Yes |
| Enroll device | No | Yes | Yes |
| Flag device as stolen | No | Yes | Yes |
| Recover device | No | Yes | Yes |
| Start/stop tracking | No | Yes | Yes |
| Request location | No | Yes | Yes |
| Delete device | No | Yes | Yes |
| PBA Recovery panel | No | No | Yes |
| Rotate device API key | No | No | Yes |
| Manage admins | No | No | Yes |
| Create/modify admin roles | No | No | Yes |

## Security notes

- The PBA Recovery panel is gated behind `super-admin` because it exposes
  BIOS passwords and BitLocker recovery keys — the most sensitive credentials
  in the system. Operators can see the "PBA Active" badge (informational) but
  cannot retrieve the actual credentials.
- Device deletion is blocked by a database trigger if the device has
  unreleased encryption keys (must recover first or force-delete).
- Admin self-deletion is blocked. The last super-admin cannot be deleted
  or demoted (prevents lockout).
- Agent endpoints use per-device API key authentication + HMAC signature
  verification, separate from the admin JWT auth system.
