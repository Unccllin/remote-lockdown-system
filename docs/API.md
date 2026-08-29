# API Reference

Complete reference for every REST API endpoint in the Remote Lockdown System server.

## Conventions

- **Base URL**: All API routes are mounted under `/api` (e.g., `http://localhost:3001/api/devices`).
  The Prometheus metrics endpoint is at `/metrics` (outside `/api`).
- **Content-Type**: `application/json` for all request and response bodies, except binary
  downloads (ZIP, EXE, agent binary) which use `application/octet-stream` or `application/zip`.
- **Authentication**: Two schemes are used:
  - **Admin JWT (Bearer)** — `Authorization: Bearer <jwt>` header. Obtained via `POST /api/auth/login`.
    Roles: `viewer` (0) < `operator` (1) < `super-admin` (2).
  - **Agent API Key** — `x-agent-key: <key>` header. Per-device key (hash-looked-up) or legacy
    `AGENT_SHARED_KEY` fallback for devices without a per-device key.
- **HMAC Request Signing**: Agent endpoints (`/api/agent/*`) require HMAC-SHA256 signature
  verification via the `X-Signature` header (computed over the raw request body).
- **Rate Limiting**: Three limiters are applied per route group (see table below). Health and
  metrics endpoints are **not** rate-limited.

### Rate Limiters

| Limiter | Applies To | Limit | Keyed On |
|---------|-----------|-------|----------|
| `authLimiter` | `/api/auth/*`, `/api/setup/*` | 200 req / 15 min | IP address |
| `dashboardLimiter` | `/api/devices`, `/api/audit`, `/api/admins`, `/api/installer`, `/api/hw-test-artifact` | 2000 req / 15 min | IP address |
| `agentLimiter` | `/api/agent/*` | 600 req / 15 min | Device ID or `x-agent-key + hostname` |

### Standard Error Responses

All errors return JSON with an `error` field containing a human-readable message:

```json
{ "error": "Description of what went wrong and how to fix it." }
```

Common status codes: `400` (validation), `401` (unauthenticated), `403` (forbidden/insufficient role),
`404` (not found), `409` (conflict), `500` (internal server error), `503` (service unavailable).

---

## /api/auth — Authentication

### POST /api/auth/login

Authenticate an admin and receive a JWT.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | `authLimiter` (200 req/15min per IP) |

**Request body:**

```json
{
  "username": "admin",
  "password": "secret123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | Yes | Admin username. |
| `password` | string | Yes | Admin password. |

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ token, admin }` | Login successful. |
| 400 | `{ error }` | Missing username or password. |
| 401 | `{ error }` | Invalid credentials. |

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "admin": { "id": "uuid", "username": "admin", "role": "super-admin" }
}
```

The JWT expires after `JWT_EXPIRES_IN` (default 8h).

---

## /api/setup — Initial Setup

### GET /api/setup/status

Check whether the system needs initial setup (no admin exists yet).

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | `authLimiter` |

**Query parameters:** None.

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ needsSetup, adminCount }` | Always returns 200. |

```json
{ "needsSetup": true, "adminCount": 0 }
```

If the database is not initialized, `needsSetup: true` with `error: "Database not initialized"`.

### POST /api/setup/create-admin

Create the initial (first) admin account. **Permanently disabled** once any admin exists.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | `authLimiter` |

**Request body:**

```json
{
  "username": "admin",
  "password": "securepassword"
}
```

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `username` | string | Yes | 3–100 chars, `[a-zA-Z0-9_-]` only. |
| `password` | string | Yes | Minimum 8 characters. |

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 201 | `{ success, message, username }` | Admin created (role: `super-admin`). |
| 400 | `{ error }` | Validation error. |
| 403 | `{ error }` | Setup already completed — endpoint permanently disabled. |
| 409 | `{ error }` | Username already exists. |

---

## /api/devices — Device Management

All endpoints require **admin JWT (Bearer)** auth. Write operations require `operator` or higher.

### GET /api/devices

List all enrolled devices, ordered by enrollment date (newest first).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:** None.

**Response:** `200` — Array of device objects:

```json
[
  {
    "id": "uuid",
    "hostname": "workstation-01",
    "owner_name": "Jane Doe",
    "status": "active",
    "last_checkin": "2026-08-29T10:00:00Z",
    "enrolled_at": "2026-08-20T12:00:00Z",
    "mac_address": "aa:bb:cc:dd:ee:ff",
    "hardware_uuid": "..."
  }
]
```

### GET /api/devices/:id

Get a single device by ID.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `id` — device UUID.

**Responses:** `200` (device object) | `404` (not found).

### POST /api/devices

Enroll a new device. Generates a per-device API key (returned once, never stored).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `hostname` | string | Yes | 1–63 chars, `[a-zA-Z0-9-]`, must start/end alphanumeric. |
| `owner_name` | string | Yes | Non-empty. |

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 201 | `{ ...device, api_key }` | Device enrolled. `api_key` is plaintext — capture now. |
| 400 | `{ error }` | Missing fields or invalid hostname. |
| 409 | `{ error }` | Hostname already registered. |

### PATCH /api/devices/:id

Update a device's `owner_name`.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** `{ "owner_name": "New Name" }` (string, max 200 chars, optional).

**Responses:** `200` (updated device) | `400` (invalid owner_name) | `404` (not found).

### DELETE /api/devices/:id

Delete a device. Blocked if the device has unreleased encryption keys (use `?force=true` to override).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `force` | string | Set to `"true"` to release all keys before deleting. |

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ deleted, forced? }` | Device deleted. |
| 404 | `{ error }` | Device not found. |
| 409 | `{ error, hint }` | Device has unreleased encryption keys. |

### POST /api/devices/:id/flag-stolen

Flag a device as stolen and issue a `lockdown` command.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostname_confirm` | string | Yes | Must match the device's hostname (safety confirmation). |
| `enable_pba` | boolean | No | If `true`, agent sets HP Power-On Password for pre-boot auth. Default: `false`. |

**Responses:** `200` (`{ device, command }`) | `400` (hostname mismatch) | `404` (not found) | `409` (already stolen).

### POST /api/devices/:id/recover

Recover a stolen/locked device — issues an `unlock` command and releases the encryption key.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** `{ "hostname_confirm": "workstation-01" }` (required, must match).

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ device, command, key_released, key_material }` | Recovery initiated. Device status → `recovering`. |
| 400 | `{ error }` | Hostname confirmation mismatch. |
| 404 | `{ error }` | Device not found. |
| 409 | `{ error }` | Device is not in a locked/stolen state. |

### POST /api/devices/:id/rotate-key

Rotate a device's API key. Old key immediately stops working.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** None.

**Response:** `200` — `{ device_id, hostname, api_key }` (plaintext key, shown once).

### POST /api/devices/:id/track

Start covert tracking — issues a `track` command. Only allowed for distressed states (stolen, locked, recovering).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** None.

**Responses:** `200` (`{ device, command }`) | `403` (status not allowed) | `404` (not found) | `409` (already tracking).

### POST /api/devices/:id/locate

One-time location request — issues a `locate` command. Allowed for distressed + tracking states.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** None.

**Responses:** `200` (`{ device, command }`) | `403` (status not allowed) | `404` (not found).

### POST /api/devices/:id/stop-track

Stop covert tracking — issues a `stop_track` command. Only for devices in `tracking` status.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** None.

**Responses:** `200` (`{ device, command }`) | `404` (not found) | `409` (not tracking).

### GET /api/devices/:id/locations

Get location history for a device (decrypted sensitive fields).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:**

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `limit` | integer | 50 | 500 | Number of location reports to return. |

**Response:** `200` — Array of location report objects (newest first).

### GET /api/devices/:id/location/latest

Get the latest known location for a device.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Response:** `200` (location object) | `404` (no location data).

### DELETE /api/devices/:id/release

Release a device from the account (ownership transfer / GDPR erasure). Deletes all associated data;
anonymizes audit log entries. Device must be in `active` status.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`operator`+) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** `{ "hostname_confirm": "workstation-01" }` (required, must match).

**Responses:** `200` (`{ ok, message }`) | `400` (hostname mismatch) | `404` (not found) | `409` (device locked/stolen).

### GET /api/devices/settings/retention

Get data retention settings.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Response:** `200`:

```json
{
  "location_retention_days": 90,
  "command_expiry_days": 30,
  "audit_log_retention_days": 365,
  "min_location_retention": 7,
  "max_location_retention": 180
}
```

### GET /api/devices/:id/pba-credentials

Get decrypted PBA (Pre-Boot Authentication) credentials for a device. Powers the PBA Recovery panel.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Response:** `200` — Object with credential types:

```json
{
  "setup_password": "...",
  "power_on_password": "...",
  "bitlocker_pin": "...",
  "bitlocker_recovery_password": "..."
}
```

`404` if device not found. Access is audit-logged.

---

## /api/agent — Agent Checkin / Commands

All endpoints use **agent API key** auth (`x-agent-key` header) and **HMAC signature** verification
(`X-Signature` header), unless noted otherwise.

### POST /api/agent/checkin

Agent periodic check-in. Returns the next pending command (if any) and an adaptive poll interval.

| | |
|---|---|
| **Auth required** | Yes — Agent API key (`x-agent-key`) |
| **HMAC required** | Yes |
| **Rate limiting** | `agentLimiter` (600 req/15min per device) |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostname` | string | Yes | Device hostname. |
| `mac_address` | string | No | MAC address (populates hardware identity if missing). |
| `hardware_uuid` | string | No | Hardware UUID (populates if missing). |

**Response:** `200`:

```json
{
  "device_id": "uuid",
  "status": "stolen",
  "poll_interval": 30,
  "command": {
    "id": 42,
    "type": "lockdown",
    "command_uuid": "abc-123",
    "key_material": null,
    "bios_password": null,
    "power_on_password": null,
    "enable_pba": false,
    "bitlocker_pin": null,
    "bitlocker_recovery_password": null
  }
}
```

`command` is `null` when no pending commands. `poll_interval` is adaptive based on device status
(stolen/tracking/recovering: 30s, locked: 60s, active: 300s).

`400` if hostname missing. `401` if key invalid. `404` if device not registered.

### POST /api/agent/command-ack

Acknowledge command execution. Supports idempotent retries via `command_uuid`.

| | |
|---|---|
| **Auth required** | Yes — Agent API key |
| **HMAC required** | Yes |
| **Rate limiting** | `agentLimiter` |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostname` | string | Yes | Device hostname. |
| `command_id` | integer | Yes | Command ID to acknowledge. |
| `result_status` | string | Yes | One of: `executed`, `failed`, `not_now`. |
| `command_uuid` | string | No | Client-side idempotency key. |
| `key_material` | string | No | Base64-encoded encryption key (stored encrypted at rest). |
| `bios_password` | string | No | BIOS Setup password (stored encrypted). |
| `power_on_password` | string | No | HP Power-On password (stored encrypted). |
| `bitlocker_pin` | string | No | BitLocker TPM+PIN (stored encrypted). |
| `bitlocker_recovery_password` | string | No | 48-digit BitLocker recovery password (stored encrypted). |
| `mac_address` | string | No | MAC address. |
| `hardware_uuid` | string | No | Hardware UUID. |
| `boot_lock_status` | string | No | Boot lock result status. |
| `boot_lock_detail` | object | No | Detailed boot lock enforcement results. |
| `encryption_blocked_files` | array | No | Files that could not be encrypted. |
| `lock_session_context` | object | No | Lock session context info. |

**Response:** `200` — `{ ok: true }` or `{ ok: true, deduplicated: true }` (idempotent retry).

`400` if required fields missing or invalid `result_status`. `404` if device not registered.

### POST /api/agent/deadman-report

Deadman switch report — the agent self-locked after failing to reach the server for the grace period.

| | |
|---|---|
| **Auth required** | Yes — Agent API key |
| **HMAC required** | Yes |
| **Rate limiting** | `agentLimiter` |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostname` | string | Yes | Device hostname. |
| `key_material` | string | Yes | Base64-encoded encryption key. |
| `mac_address` | string | No | MAC address. |
| `hardware_uuid` | string | No | Hardware UUID. |

**Response:** `200` — `{ ok: true }` (or `{ ok: true, deduplicated: true }` on retry).

### POST /api/agent/location

Submit a location report (called periodically in tracking mode). Sensitive fields encrypted at rest.

| | |
|---|---|
| **Auth required** | Yes — Agent API key |
| **HMAC required** | Yes |
| **Rate limiting** | `agentLimiter` |

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hostname` | string | Yes | Device hostname. |
| `location` | object | Yes | Location data object. |
| `location.latitude` | number | No | Latitude. |
| `location.longitude` | number | No | Longitude. |
| `location.accuracy_meters` | number | No | GPS accuracy. |
| `location.source` | string | No | Location source (e.g., `ip`, `gps`). Default: `ip`. |
| `location.city` | string | No | City name. |
| `location.region` | string | No | Region/state. |
| `location.country` | string | No | Country. |
| `location.ip` | string | No | IP address. |
| `location.wifi_count` | integer | No | Number of WiFi access points. |
| `mac_address` | string | No | MAC address. |
| `hardware_uuid` | string | No | Hardware UUID. |

**Response:** `200` — `{ ok: true }`.

### GET /api/agent/update

Check if a newer agent binary version is available.

| | |
|---|---|
| **Auth required** | Yes — Agent API key |
| **HMAC required** | No (transition period) |
| **Rate limiting** | `agentLimiter` |

**Query parameters / headers:**

| Source | Param | Default | Description |
|--------|-------|---------|-------------|
| Header | `x-agent-version` | `0.0.0` | Current agent version. |
| Header | `x-agent-platform` | `linux` | Agent platform (`win` or `linux`). |
| Query | `version` | — | Fallback for version. |
| Query | `platform` | — | Fallback for platform. |

**Response:** `200`:

```json
{
  "update_available": true,
  "latest_version": "1.0.0",
  "current_version": "0.9.0",
  "sha256": "abc123...",
  "size": 10485760,
  "download_url": "/api/agent/download?platform=linux",
  "built_at": "2026-08-20T10:00:00Z"
}
```

### GET /api/agent/download

Download the agent binary for auto-update.

| | |
|---|---|
| **Auth required** | Yes — Agent API key |
| **HMAC required** | No |
| **Rate limiting** | `agentLimiter` |

**Query parameters:** `platform` — `win` or `linux` (default: `linux`).

**Response:** `200` — Binary file (`application/octet-stream`). `404` if binary not available.

### POST /api/agent/uninstall-auth

Issue a short-lived (5-minute) uninstall token for tamper protection removal.

| | |
|---|---|
| **Auth required** | Yes — Agent API key **or** admin Bearer JWT (`ADMIN_TOKEN`) |
| **HMAC required** | No |
| **Rate limiting** | `agentLimiter` |

**Request body:** None.

**Response:** `200`:

```json
{
  "uninstall_token": "hexstring...",
  "expires_in": 300,
  "issued_at": "2026-08-29T10:00:00Z"
}
```

`401` if not authenticated.

### POST /api/agent/uninstall-auth/verify

Verify an uninstall token (validates against current and previous 5-minute windows).

| | |
|---|---|
| **Auth required** | Yes — Agent API key **or** admin Bearer JWT (`ADMIN_TOKEN`) |
| **HMAC required** | No |
| **Rate limiting** | `agentLimiter` |

**Request body:** `{ "uninstall_token": "hexstring..." }` (required).

**Response:** `200` — `{ authorized: true/false, verified: true/false }`.

---

## /api/audit — Audit Log

### GET /api/audit

Query the audit log with optional device filter and pagination.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:**

| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `device_id` | string | — | UUID/hex (16–36 chars) | Filter by device ID. |
| `limit` | integer | 100 | 1–1000 | Number of entries. |
| `offset` | integer | 0 | ≥ 0 | Pagination offset. |

**Response:** `200` — Array of audit log entries (newest first):

```json
[
  {
    "id": "uuid",
    "device_id": "uuid",
    "admin_id": "uuid",
    "action": "flag_stolen",
    "detail": { "command_id": 42, "enable_pba": false },
    "timestamp": "2026-08-29T10:00:00Z",
    "hostname": "workstation-01",
    "admin_username": "admin"
  }
]
```

`400` if `device_id` format is invalid.

---

## /api/installer — Installer Downloads

All endpoints require **admin JWT (Bearer)** auth.

### GET /api/installer/:deviceId

Generate and download a ZIP installer package for a device (agent binary + config + install script).

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `deviceId` — device UUID.

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `platform` | string | `win` | Target platform: `win` or `linux`. |

**Responses:**

| Status | Content-Type | Description |
|--------|-------------|-------------|
| 200 | `application/zip` | ZIP file download. |
| 404 | `application/json` | Device not found. |
| 503 | `application/json` | Agent binary not found for platform. |

The ZIP contains: agent binary, watchdog binary, `config.json`, `install.ps1`/`install.sh`, `README.txt`.
A new API key is generated and embedded in the config (old key is invalidated).

### GET /api/installer/:deviceId/nsis

Generate and download an NSIS `.exe` installer for a Windows device.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `deviceId` — device UUID.

**Responses:**

| Status | Content-Type | Description |
|--------|-------------|-------------|
| 200 | `application/vnd.microsoft.portable-executable` | NSIS EXE installer. |
| 404 | `application/json` | Device not found. |
| 503 | `application/json` | NSIS not installed or binary not found. |
| 500 | `application/json` | NSIS compilation failed. |

### GET /api/installer/agent-version

Get the current version and checksum of the bundled agent binary.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:** `platform` — `win` or `linux` (default: server platform).

**Response:** `200`:

```json
{
  "version": "1.0.0",
  "sha256": "abc123...",
  "size": 10485760,
  "built_at": "2026-08-20T10:00:00Z",
  "platform": "linux",
  "source": "local"
}
```

If no binary is available: `{ version: null, available: false }`.

---

## /api/health — Health Checks

No rate limiting. Health endpoints are for infrastructure monitoring (Docker/Caddy/K8s probes).

### GET /api/health

Extended health check — DB probe + scheduler status. Rejects agent-key probing.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | None |

**Response:** `200` (healthy) or `503` (degraded):

```json
{
  "status": "ok",
  "db": "connected",
  "scheduler": "running",
  "timestamp": "2026-08-29T10:00:00Z"
}
```

`400` if `x-agent-key` header is present (not for agent use).

### GET /api/health/ (liveness)

Liveness probe — returns 200 if the process is up. Does NOT touch the DB.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | None |

**Response:** `200`:

```json
{ "status": "ok", "timestamp": "2026-08-29T10:00:00Z" }
```

### GET /api/health/ready

Readiness probe — returns 200 if DB is connected, 503 if not.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | None |

**Response:** `200` (ready) or `503` (degraded):

```json
{
  "status": "ok",
  "db": "connected",
  "dbLatencyMs": 3,
  "timestamp": "2026-08-29T10:00:00Z"
}
```

### GET /api/health/detailed

Full system status — server uptime, memory, DB, fleet checkin stats, command queue depth, recent alerts.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | None |

**Response:** `200`:

```json
{
  "status": "ok",
  "timestamp": "...",
  "server": {
    "uptimeSeconds": 3600,
    "memory": { "rssMb": 120, "heapUsedMb": 45, "heapTotalMb": 80 }
  },
  "db": { "connected": true, "latencyMs": 3, "error": null },
  "fleet": { "active": 5, "stale": 2, "missing": 1, "dead": 0, "never": 0, "total": 8 },
  "queueDepth": 3,
  "recentAlerts": []
}
```

---

## /api/admins — Admin Management

All endpoints require **Bearer JWT** auth with `super-admin` role.

### GET /api/admins

List all admin accounts.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Response:** `200` — Array of admin objects (no password hashes):

```json
[
  { "id": "uuid", "username": "admin", "role": "super-admin", "created_at": "..." }
]
```

### POST /api/admins

Create a new admin account.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:**

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `username` | string | Yes | 3–100 chars, `[a-zA-Z0-9_-]` only. |
| `password` | string | Yes | Minimum 8 characters. |
| `role` | string | Yes | One of: `viewer`, `operator`, `super-admin`. |

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 201 | `{ id, username, role, created_at }` | Admin created. |
| 400 | `{ error }` | Validation error. |
| 409 | `{ error }` | Username already exists. |

### DELETE /api/admins/:id

Delete an admin account. Cannot delete self or the last super-admin.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `id` — admin UUID.

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ deleted: "uuid" }` | Admin deleted. |
| 403 | `{ error }` | Cannot delete self or last super-admin. |
| 404 | `{ error }` | Admin not found. |

### PATCH /api/admins/:id

Update an admin's role. Cannot change own role or demote the last super-admin.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (`super-admin`) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `id` — admin UUID.

**Request body:** `{ "role": "operator" }` (required — one of `viewer`, `operator`, `super-admin`).

**Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 200 | `{ id, username, role, created_at }` | Role updated. |
| 400 | `{ error }` | Missing or invalid role. |
| 403 | `{ error }` | Cannot change own role or demote last super-admin. |
| 404 | `{ error }` | Admin not found. |

---

## /api/hw-test-artifact — Hardware Test Artifacts

All endpoints require **admin JWT (Bearer)** auth.

### POST /api/hw-test-artifact

Upload a hardware test artifact from the hw_test_harness v2.0. Accepts CTRF or legacy JSON format.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Request body:** Full artifact JSON object. Must be either:

- **CTRF format**: `{ results: { tool, summary, tests, extra: { environment } } }`
- **Legacy format**: `{ harness_version, summary, environment, results }`

The `summary` object must contain: `tests`/`total`, `passed`, `failed`, `skipped`, `errors`.

**Response:** `201`:

```json
{
  "id": 1,
  "device_id": "uuid",
  "hostname": "workstation-01",
  "summary": { "total": 10, "passed": 8, "failed": 1, "skipped": 1, "errors": 0 }
}
```

`400` if invalid format or missing summary. `503` if the `hw_test_artifacts` table doesn't exist.

### GET /api/hw-test-artifact

List recent hardware test artifacts, optionally filtered by device.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Query parameters:**

| Param | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `device_id` | string | — | UUID/hex (16–36 chars) | Filter by device ID. |
| `limit` | integer | 20 | 1–100 | Number of artifacts. |

**Response:** `200` — Array of artifact metadata (without full JSON):

```json
[
  {
    "id": 1,
    "device_id": "uuid",
    "admin_id": "uuid",
    "hostname": "workstation-01",
    "harness_version": "2.0",
    "agent_hash": "abc123...",
    "total_tests": 10,
    "passed": 8,
    "failed": 1,
    "skipped": 1,
    "errors": 0,
    "created_at": "2026-08-29T10:00:00Z"
  }
]
```

### GET /api/hw-test-artifact/:id

Get a specific artifact including the full JSON payload.

| | |
|---|---|
| **Auth required** | Yes — Bearer JWT (any role) |
| **Rate limiting** | `dashboardLimiter` |

**Path parameters:** `id` — numeric artifact ID.

**Response:** `200` — Full artifact row including `artifact_json` (parsed object). `404` if not found.

---

## /metrics — Prometheus Metrics

### GET /metrics

Prometheus text-format metrics endpoint for external scraping.

| | |
|---|---|
| **Auth required** | No |
| **Rate limiting** | None |

**Response:** `200` — `text/plain; version=0.0.4` (Prometheus exposition format).

Custom metrics exposed:

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `lockdown_devices_total` | Gauge | `status` | Device count by status. |
| `lockdown_commands_pending_total` | Gauge | — | Pending command count. |
| `lockdown_commands_completed_total` | Counter | — | Total completed commands. |
| `lockdown_agent_checkins_total` | Counter | — | Total agent checkins. |
| `lockdown_stale_devices_total` | Gauge | — | Devices with stale checkin (>10 min). |
| `lockdown_uptime_seconds` | Gauge | — | Server uptime in seconds. |
| `lockdown_db_query_duration_seconds` | Histogram | — | DB query latency. |

Also includes prom-client default metrics (process, GC).
