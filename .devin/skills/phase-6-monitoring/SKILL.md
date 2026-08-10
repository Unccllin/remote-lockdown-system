# Skill Domain: Phase 6 — Monitoring & Alerting

## Context

An anti-theft system is useless if it's silently broken. If the server is down,
agents can't poll for lockdown commands. If agents stop checking in, the admin
doesn't know devices are unmanaged. This phase adds health monitoring and
alerting.

## Current State

### Server
- No `/health` endpoint
- No `/ready` endpoint
- No metrics endpoint
- `server/src/index.js` starts Express but doesn't expose health status
- `server/src/jobs/retentionScheduler.js` — scheduled cleanup job (could report status)

### Dashboard
- No health/monitoring page
- No system status indicators
- Pages: Login, Setup, Overview, Devices, DeviceDetail, Enroll, Audit, Map

### Agent
- Agent polls server every 30s
- No heartbeat monitoring on server side (server knows last_checkin but doesn't alert)
- Dead man's switch exists in agent code but server doesn't alert when switch triggers

## Research Findings

### Health Endpoint Design
1. **`GET /health`** — liveness probe (is the process running?)
   - Returns 200 + `{ status: "ok" }` if process is up
   - No auth required (for load balancer checks)
   - Should be fast (< 10ms)

2. **`GET /health/ready`** — readiness probe (can the server handle requests?)
   - Returns 200 if: DB connected, migrations applied, env vars valid
   - Returns 503 if: DB disconnected, missing critical config
   - No auth required (for Kubernetes/docker readiness)

3. **`GET /health/detailed`** — detailed status (auth required)
   - DB connection status + latency
   - Agent checkin statistics (active devices, stale devices, missing devices)
   - Command queue depth
   - Retention scheduler status
   - Uptime, memory usage

### Agent Heartbeat Monitoring
- Server already tracks `last_checkin` per device
- Need a scheduled job that checks for stale agents:
  - **Stale**: last_checkin > 2x poll_interval (default: 60s)
  - **Missing**: last_checkin > 24h
  - **Dead**: last_checkin > 72h (dead man's switch should have triggered)
- Write stale/missing/dead status to audit_log
- Expose via `/health/detailed` and dashboard

### Alerting
- **Simple approach**: Dashboard shows alerts (no external notification)
  - Red badge on stale/missing devices
  - Banner if server health degraded
  - Health page with all alerts
- **Advanced approach**: Webhook/email notifications
  - POST to configured webhook when device goes stale
  - Email admin when server health degraded
  - This phase: implement simple (dashboard alerts). Advanced is future work.

### Dashboard Health Page
- `HealthPage.jsx` — admin-only page showing:
  - Server status (uptime, DB latency, memory)
  - Agent fleet status (active/stale/missing/dead counts)
  - Command queue depth
  - Recent alerts from audit_log
  - Auto-refresh every 30s

### Monitor Script
- `scripts/monitor.sh` — CLI tool for external monitoring
  - `--url <server-url>` — server to monitor
  - `--interval <seconds>` — check interval (default: 60)
  - `--alert-webhook <url>` — webhook to POST alerts to
  - Checks `/health` and `/health/ready`
  - Reports status to stdout (for cron/systemd timer integration)
  - Exit non-zero on health failure (for alerting integration)

## Reasoning Questions

1. **Should health endpoints require auth?**
   - Answer: `/health` and `/health/ready` — no auth (for load balancer probes). `/health/detailed` — admin auth (contains sensitive fleet info).

2. **Should the stale agent check be a cron job or a setInterval?**
   - Answer: Reuse the existing `retentionScheduler.js` pattern — setInterval within the server process. Adding external cron creates a new dependency. The server is already running and can check periodically.

3. **Should alerts be stored in audit_log or a separate table?**
   - Answer: audit_log. It already has the right structure (timestamp, event_type, details). Adding a separate table creates fragmentation. Use `event_type = 'health_alert'`.

4. **Should the monitor script support Prometheus metrics?**
   - Answer: Not in this phase. Prometheus requires a metrics endpoint with specific format (OpenMetrics). That's a separate monitoring system integration. This phase provides basic HTTP health checks. Document that Prometheus integration is future work.

5. **Should the health page auto-refresh or require manual refresh?**
   - Answer: Auto-refresh every 30s with a visible countdown. Manual refresh button also available. Auto-refresh gives admins a live view without interaction.

## Implementation Guidelines

### server/src/routes/health.js
- `GET /health` — liveness (200 + `{status:"ok"}`)
- `GET /health/ready` — readiness (check DB, return 200 or 503)
- `GET /health/detailed` — admin auth required, returns full status
- DB check: `SELECT 1` with timeout
- Agent stats: query devices for checkin status counts
- Queue depth: count pending commands

### server/src/middleware/health.js (optional — or just routes)
- Could be a simple middleware that sets `res.locals.startTime` for latency measurement
- Or skip middleware and just use routes

### dashboard/src/pages/HealthPage.jsx
- Fetches `/api/health/detailed`
- Shows server status card (green/yellow/red)
- Shows fleet status card (active/stale/missing/dead counts with colors)
- Shows command queue card
- Shows recent alerts list
- Auto-refresh with countdown timer
- Route: `/health` (admin only)

### dashboard/src/api/health.js
- `getHealth()` — calls `/api/health`
- `getDetailedHealth()` — calls `/api/health/detailed` (with auth header)

### scripts/monitor.sh
- Accepts `--url`, `--interval`, `--alert-webhook`
- Loops: curl `/health/ready`, parse response, log status
- On failure: POST to webhook (if configured), exit non-zero
- Can run as systemd timer or cron job

### server/tests/health.test.js
- Test `/health` returns 200
- Test `/health/ready` returns 200 when DB is connected
- Test `/health/ready` returns 503 when DB is disconnected
- Test `/health/detailed` requires auth
- Test `/health/detailed` returns fleet stats

### server/src/index.js (edit to register health routes)
- Add `app.use('/api/health', healthRoutes)`
- Add stale agent checker to retentionScheduler or new scheduler

## File Boundaries
- CREATE: `server/src/routes/health.js`, `dashboard/src/pages/HealthPage.jsx`, `dashboard/src/api/health.js`, `scripts/monitor.sh`, `server/tests/health.test.js`
- EDIT: `server/src/index.js` (register health routes only — minimal change)
- EDIT: `dashboard/src/App.jsx` (add health route only — minimal change)
- DO NOT EDIT: existing routes, middleware, or dashboard pages

## Graph Integration

**Phase node**: `P6` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P6` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-SERVER,V-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

