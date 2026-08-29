---
name: phase-13-notifications-metrics
description: Webhook/email notifications, Prometheus metrics endpoint, and alert scheduler
---

# Phase 13 — Notifications, Metrics & Alerting

## Context

Phase 6 added basic health endpoints and dashboard alerts. This phase adds:
1. Webhook/email notifications for critical events (stale agents, lockdown, health degradation)
2. Prometheus-compatible metrics endpoint for external monitoring

## Current State

### Notification System
- `server/src/notifications/notify.js` — async notification module
  - `sendNotification(eventType, payload)` — async, fire-and-forget
  - Checks configured channels (webhook, email, Slack)
  - Webhook: HTTP POST with JSON `{eventType, timestamp, payload}`
  - Email: nodemailer with template
  - Slack: formatted message to Slack webhook
  - Logs errors but never throws
- Config via env vars:
  - `NOTIFICATION_WEBHOOK_URL` — generic webhook
  - `NOTIFICATION_EMAIL_*` — SMTP config (host, port, user, pass, from, to)
  - `SLACK_WEBHOOK_URL` — Slack-specific
- Notifications degrade gracefully if not configured

### Events That Trigger Notifications
1. Device goes stale (no checkin > 2x poll interval)
2. Device flagged as stolen
3. Lockdown confirmed by agent
4. Recovery completed
5. Server health degraded (DB down)
6. Dead man's switch triggered

### Prometheus Metrics
- `server/src/routes/metrics.js` — Prometheus metrics endpoint
  - `GET /metrics` (no auth, standard Prometheus scrape target, outside API auth layer)
  - Uses `prom-client` Registry
  - Custom metrics:
    - `lockdown_devices_total{status="active|stolen|locked|recovering"}` — gauge
    - `lockdown_commands_pending_total` — gauge
    - `lockdown_commands_completed_total` — counter
    - `lockdown_agent_checkins_total` — counter
    - `lockdown_db_query_duration_seconds` — histogram
    - `lockdown_uptime_seconds` — gauge
    - `lockdown_stale_devices_total` — gauge
    - `lockdown_health_status{component="db|server"}` — gauge (0/1)
  - Collects metrics on each request (gauge queries)

### Alert Scheduler
- `server/src/jobs/alertScheduler.js` — runs every 60s
  - Queries for stale devices (>2x poll interval)
  - Creates audit_log entries for new stale devices (`event_type='health_alert'`)
  - Fires notifications for new alerts
  - Reuses the retentionScheduler pattern

### Server Integration
- `server/src/index.js` — registers metrics route (`app.use('/metrics', metricsRoutes)`, outside auth) + starts alertScheduler

### Tests
- `server/tests/notifications.test.js` — tests notification module with mock webhook, alert scheduler detects stale devices
- `server/tests/metrics.test.js` — tests metrics endpoint returns valid Prometheus format

## Verification

```bash
# Run notification tests
cd server && npx jest tests/notifications.test.js --verbose

# Run metrics tests
cd server && npx jest tests/metrics.test.js --verbose

# Verify metrics route is registered (outside auth)
grep -n "metrics" server/src/index.js

# Verify notification module exists
ls server/src/notifications/notify.js

# Verify alert scheduler exists
ls server/src/jobs/alertScheduler.js

# Verify prom-client is a dependency
grep "prom-client" server/package.json

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify notifications are async (fire-and-forget)**: `grep -i "setImmediate\|async\|fire" server/src/notifications/notify.js`
2. **Verify metrics endpoint requires NO auth**: `grep -i "metrics" server/src/index.js` (should be outside auth middleware)
3. **Verify alert scheduler runs every 60s**: `grep -i "60000\|60.*sec\|interval" server/src/jobs/alertScheduler.js`
4. **Verify notifications degrade gracefully if not configured**: `grep -i "not configured\|graceful\|skip" server/src/notifications/notify.js`
5. **Verify metrics are in Prometheus text format**: `cd server && npx jest tests/metrics.test.js -t "prometheus"`

## Gotchas

- Notifications are async (fire-and-forget) — use `setImmediate` or simple queue, not a heavy queue dependency
- `/metrics` endpoint is on a separate path (not `/api/metrics`) to keep it outside the API auth layer — Prometheus scrapes without auth
- `prom-client` handles proper formatting, registry, and standard metrics (process, GC) — don't hand-roll
- `nodemailer` is an optional dependency — notifications degrade gracefully if not configured
- Alert scheduler reuses the `retentionScheduler.js` pattern (setInterval within server process)

## Graph Integration

**Phase node**: `P13` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P13` node
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
