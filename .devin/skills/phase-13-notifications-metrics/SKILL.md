# Skill Domain: Phase 13 — Notifications, Metrics & Alerting

## Context
Phase 6 added basic health endpoints and dashboard alerts. This phase adds:
1. Webhook/email notifications for critical events (stale agents, lockdown, health degradation)
2. Prometheus-compatible metrics endpoint for external monitoring

## Current State
- server/src/routes/health.js — health endpoints (liveness, readiness, detailed)
- dashboard/src/pages/HealthPage.jsx — health dashboard
- server/src/jobs/retentionScheduler.js — scheduled cleanup job
- No notification system (alerts only visible in dashboard)
- No Prometheus metrics endpoint

## Research Findings
### Notification System
- Events that should trigger notifications:
  1. Device goes stale (no checkin > 2x poll interval)
  2. Device flagged as stolen
  3. Lockdown confirmed by agent
  4. Recovery completed
  5. Server health degraded (DB down)
  6. Dead man's switch triggered

- Notification channels:
  1. Webhook (generic HTTP POST with JSON payload)
  2. Email (via SMTP or transactional email service)
  3. Slack incoming webhook (specialized webhook format)

- Config via env vars:
  - `NOTIFICATION_WEBHOOK_URL` — generic webhook
  - `NOTIFICATION_EMAIL_*` — SMTP config (host, port, user, pass, from, to)
  - `SLACK_WEBHOOK_URL` — Slack-specific

### Prometheus Metrics
- Endpoint: `GET /metrics` (no auth, standard Prometheus scrape target)
- Format: OpenMetrics/Prometheus text format
- Metrics to expose:
  - `lockdown_devices_total{status="active|stolen|locked|recovering"}` — gauge
  - `lockdown_commands_pending_total` — gauge
  - `lockdown_commands_completed_total` — counter
  - `lockdown_agent_checkins_total` — counter
  - `lockdown_db_query_duration_seconds` — histogram
  - `lockdown_uptime_seconds` — gauge
  - `lockdown_stale_devices_total` — gauge
  - `lockdown_health_status{component="db|server"}` — gauge (0/1)

- Use `prom-client` npm package (standard Prometheus client for Node.js)

### Alert Scheduler
- Reuse the retentionScheduler pattern
- New `alertScheduler.js` that runs every 60s
- Checks for stale devices, writes to audit_log with `event_type='health_alert'`
- Fires notifications via notification module

## Reasoning Questions
1. **Should notifications be sync or async?**
   - Answer: Async. Notifications should not block the request. Use `setImmediate` or a simple queue. Don't add a heavy queue dependency — a simple async fire-and-forget with error logging is sufficient.

2. **Should we use prom-client or hand-roll the metrics?**
   - Answer: `prom-client`. It handles proper formatting, registry, and standard metrics (process, GC). It's the standard for Node.js Prometheus integration.

3. **Should email notifications require extra dependencies?**
   - Answer: Use `nodemailer` for SMTP. It's the standard Node.js email library. Add as optional dependency — notifications degrade gracefully if not configured.

4. **Should metrics endpoint require auth?**
   - Answer: No. Prometheus scrapes endpoints without auth. Standard practice. Put it on a separate path `/metrics` (not `/api/metrics`) to keep it outside the API auth layer.

## Implementation Guidelines
### server/src/routes/metrics.js
- `GET /metrics` — Prometheus text format
- Use prom-client Registry
- Register custom metrics (device counts, command counts, etc.)
- Collect metrics on each request (gauge queries)

### server/src/notifications/notify.js
- `sendNotification(eventType, payload)` — async, fire-and-forget
- Checks configured channels (webhook, email, Slack)
- Webhook: HTTP POST with JSON `{eventType, timestamp, payload}`
- Email: nodemailer with template
- Slack: formatted message to Slack webhook
- Logs errors but never throws

### server/src/jobs/alertScheduler.js
- Runs every 60s
- Queries for stale devices (>2x poll interval)
- Creates audit_log entries for new stale devices
- Fires notifications for new alerts

### server/src/index.js (minimal edit)
- Register metrics route: `app.use('/metrics', metricsRoutes)` (outside auth)
- Start alertScheduler

### server/tests/notifications.test.js
- Test notification module with mock webhook
- Test alert scheduler detects stale devices
- Test metrics endpoint returns valid Prometheus format

## File Boundaries
- CREATE: `server/src/routes/metrics.js`, `server/src/notifications/notify.js`, `server/src/jobs/alertScheduler.js`, `server/tests/notifications.test.js`, `server/tests/metrics.test.js`
- EDIT: `server/src/index.js` (register metrics route + start scheduler — 3 lines)
- EDIT: `server/package.json` (add `prom-client` and `nodemailer` deps)
- DO NOT EDIT: existing routes, health.js, dashboard pages
