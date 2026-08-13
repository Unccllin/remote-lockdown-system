# current-state.md — Compact Session State

> **Purpose**: This is the primary file agents read at session start. It
> contains the latest session's status, open items, and next session opening.
> For full session history, read `.devin/graph/trace.md`.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` and
> `assert_current_state_updated()` enforce that this file is updated at every
> session end with a status block.

---

## Latest session: 2026-08-13 (production hardening) — Production readiness gaps addressed

### Fog cleared
- Fixed D-009/D-010 status discrepancy: GRAPH-SPEC.yaml had them as OPEN
  while DEBT-LEDGER.md had them CLOSED. Updated GRAPH-SPEC.yaml to CLOSED
  with commit_ref and artifact_ref matching the debt ledger.
- Added automated backup scheduling to docker-compose.prod.yml: a `backup`
  service that runs backup.sh on a cron schedule (default 2 AM daily) with
  configurable retention (default 30 days). Runs an initial backup on
  startup so you don't wait until 2 AM.
- Added backup retention policy to backup.sh: new `--retain-days` option
  that prunes old backup files from the output directory.
- Added Prometheus + Grafana monitoring stack to docker-compose.prod.yml
  (optional, enabled via `--profile monitoring`). Includes:
  - monitoring/prometheus.yml — scrapes server /metrics every 15s
  - monitoring/grafana/provisioning/ — auto-provisioned datasource + dashboard
  - monitoring/grafana/dashboards/lockdown-overview.json — 6-panel dashboard
    (total devices, pending commands, stale devices, uptime, command/checkin
    rates, DB query p50/p95 latency)
- Documented notification channel configuration in .env.prod.example:
  webhook, Slack, and SMTP email with all env vars documented.
- Added notification env vars to docker-compose.prod.yml server service.
- Wrote docs/DR_RUNBOOK.md: 5 disaster recovery scenarios with exact
  commands (server crash, DB corruption, full server loss, Caddy/TLS
  failure, encryption key compromise), RTO/RPO targets, post-recovery
  checklist.
- Wrote docs/RBAC_ACCESS_MATRIX.md: complete endpoint-by-endpoint matrix
  of viewer/operator/super-admin access for all API routes + dashboard
  features.

### Fog remaining
- Code signing certificates not configured (requires purchasing
  Azure Trusted Signing for Windows + Apple Developer ID for macOS).
- E-HP-UEFI not verified on real HP hardware (requires physical HP machine).
- No centralized logging (ELK/Loki/CloudWatch) — left as infrastructure
  choice for the deployer.
- No secrets management (Vault/cloud secrets) — left as infrastructure
  choice for the deployer.

### Debt items closed
None — this is production hardening, not debt closure.

### Debt items still open
None — all 19 debt items (D-001 through D-019) remain CLOSED.

### Blockers
None — CI is fully green. All 753 tests pass. Docker validation passes.

### Next session opening
All addressable production readiness gaps have been resolved. The
remaining gaps require external resources: code signing certificates
(must purchase), real HP hardware (must physically access), centralized
logging/secrets management (deployer infrastructure choice). 753 tests
passing (368 server + 344 agent + 41 dashboard). Tree clean.

---

## Open wayfinder tickets

| Ticket | Title | Status | Blocks |
|--------|-------|--------|--------|
| Q1 | Goodhart's Law defense design | CLOSED | — |
| T1 | Archive + trace restructure | CLOSED | — |
| T2 | Clean-state + Goodhart + attribution | CLOSED | — |
| T3 | Error messages with fix instructions | CLOSED | — |

Map: `docs/wayfinder/harness-engineering-map.md`

---

## Open debt items

None. All 19 debt items (D-001 through D-019) are CLOSED.
See `docs/adr/DEBT-LEDGER.md` for the full ledger.

---

## Quick reference

- **Graph spec**: `.devin/graph/GRAPH-SPEC.yaml`
- **Full trace history**: `.devin/graph/trace.md` (3300+ lines — read on demand)
- **Debt ledger**: `docs/adr/DEBT-LEDGER.md`
- **Graph ADR**: `docs/adr/GRAPH-SPEC.md`
- **Verification**: `make graph-check` (runs `graph_assert.py` — all invariants)
- **Clean state**: `make clean-state` (runs 5-condition checklist from L12)
- **Test counts**: 344 agent + 368 server + 41 dashboard = 753 total
