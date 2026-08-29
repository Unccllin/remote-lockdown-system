---
name: phase-6-monitoring
description: Health endpoints, agent heartbeat monitoring, dashboard health page, and monitor CLI script
---

# Phase 6 — Monitoring & Alerting

## Context

An anti-theft system is useless if it's silently broken. If the server is down,
agents can't poll for lockdown commands. If agents stop checking in, the admin
doesn't know devices are unmanaged. This phase adds health monitoring and
alerting.

## Current State

### Server
- `server/src/routes/health.js` — health endpoints
  - `GET /health` — liveness probe (200 + `{ status: "ok" }`, no auth, < 10ms)
  - `GET /health/ready` — readiness probe (checks DB, returns 200 or 503, no auth)
  - `GET /health/detailed` — detailed status (admin auth required)
    - DB connection status + latency, agent checkin statistics, command queue depth, retention scheduler status, uptime, memory usage
- `server/src/index.js` — registers health routes (`app.use('/api/health', healthRoutes)`)
- `server/src/jobs/retentionScheduler.js` — scheduled cleanup job (reports status)
- Stale agent checker integrated — detects stale (>2x poll interval), missing (>24h), dead (>72h) agents
- Stale/missing/dead status written to audit_log with `event_type = 'health_alert'`
- `server/tests/health.test.js` — tests covering:
  - `/health` returns 200
  - `/health/ready` returns 200 when DB connected, 503 when disconnected
  - `/health/detailed` requires auth, returns fleet stats

### Dashboard
- `dashboard/src/pages/HealthPage.jsx` — admin-only health page
  - Server status card (uptime, DB latency, memory) with green/yellow/red
  - Fleet status card (active/stale/missing/dead counts with colors)
  - Command queue card
  - Recent alerts list from audit_log
  - Auto-refresh every 30s with countdown timer
  - Route: `/health` (admin only)
- `dashboard/src/api/health.js` — API client (`getHealth()`, `getDetailedHealth()`)
- `dashboard/tests/HealthPage.test.jsx` — component tests

### Monitor Script
- `scripts/monitor.sh` — CLI tool for external monitoring
  - `--url <server-url>` — server to monitor
  - `--interval <seconds>` — check interval (default: 60)
  - `--alert-webhook <url>` — webhook to POST alerts to
  - Checks `/health` and `/health/ready`
  - Reports status to stdout (for cron/systemd timer integration)
  - Exit non-zero on health failure (for alerting integration)

## Verification

```bash
# Run server health tests
cd server && npx jest tests/health.test.js --verbose

# Run dashboard health page tests
cd dashboard && npx vitest run tests/HealthPage.test.jsx

# Verify health routes are registered
grep -n "health" server/src/index.js

# Verify monitor script exists and is executable
ls -la scripts/monitor.sh

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify `/health` requires no auth**: `cd server && npx jest tests/health.test.js -t "liveness"`
2. **Verify `/health/ready` returns 503 when DB disconnected**: `cd server && npx jest tests/health.test.js -t "ready"`
3. **Verify `/health/detailed` requires admin auth**: `cd server && npx jest tests/health.test.js -t "auth"`
4. **Verify stale agent detection writes to audit_log**: `grep -r "health_alert" server/src/`
5. **Verify health page auto-refreshes**: `grep -i "refresh\|interval\|countdown" dashboard/src/pages/HealthPage.jsx`
6. **Verify monitor script exits non-zero on failure**: `grep -i "exit" scripts/monitor.sh`

## Gotchas

- `/health` and `/health/ready` require NO auth (for load balancer probes) — `/health/detailed` requires admin auth (contains sensitive fleet info)
- Stale agent check reuses the `retentionScheduler.js` pattern (setInterval within server process) — no external cron dependency
- Alerts stored in audit_log (not a separate table) — use `event_type = 'health_alert'`
- Prometheus metrics integration is future work (Phase 13 adds the `/metrics` endpoint) — this phase provides basic HTTP health checks only

## Graph Integration

**Phase node**: `P6` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P6` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
