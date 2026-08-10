# Remote Lockdown System - Production Readiness Phases

## Overview

Seventeen phases (P0-P16) covering full production readiness. Each phase has:
- **Skill domain**: `.devin/skills/phase-N-<name>/SKILL.md` — knowledge base agents consult
- **Phase config**: `.devin/orchestration/phases/phase-N.conf` — file ownership, tests, tasks
- **Master orchestrator**: `.devin/orchestration/orchestrator.sh` — manages phase execution
- **Test gates**: phase-specific tests + existing regression suites must pass
- **Graph node**: `.devin/graph/GRAPH-SPEC.yaml` — formal node in the project graph

## Graph Integration

The node graph (`.devin/graph/`) is the center and heart of the project. All
phase transitions, verification gates, and enforcement paths flow through it.

**Mandatory reads at session start:**
1. `.devin/graph/GRAPH-SPEC.yaml` — all nodes, edges, and invariants
2. `.devin/graph/trace.md` — last session's context and next session opening
3. `docs/adr/DEBT-LEDGER.md` — open debt items and close criteria

**Graph invariants enforced by `graph_assert.py`:**
- I1: No phase runs before its dependencies are COMPLETE
- I4: No session close without trace.md status block update
- I5: No code changes before RULE-ZERO is complete
- I6: Orchestrator must know about ALL 17 phases
- I7: Every COMPLETE phase has non-empty artifact reference

**Run `make graph-check` or `python3 .devin/graph/graph_assert.py` to verify.**

## Orchestration Protocol

1. Master orchestrator starts a phase by reading its config
2. **Graph enforcement**: `graph_check_phase()` asserts phase deps via `graph_assert.py` (I1)
3. **RULE-ZERO gate**: `rule_zero_check()` verifies trace.md has a RULE-ZERO entry (I5)
4. Subagents are spawned for each task in the phase
5. Subagents consult the skill domain before/during work
6. If a new task appears mid-phase, a NEW subagent is spawned (existing subagents don't context-switch)
7. Subagents reason about findings, question assumptions, then implement
8. Each phase has file ownership boundaries — agents only edit their phase's files
9. Tests run after each task; if tests fail, loop: review skill domain → fix → re-test
10. Phase completes only when all phase-specific tests AND regression tests pass
11. **Session-end trace**: `write_session_end()` appends status block to trace.md (I4)

## Phases

### Phase 0: Build Foundation & Artifact Verification
- **Goal**: Top-level build orchestration, artifact checking, reproducible builds
- **Files owned**: `scripts/build-all.sh`, `scripts/check-artifacts.sh`, `Makefile`
- **Tests**: `scripts/check-artifacts.sh` validates build outputs exist and are non-empty
- **Skill**: `.devin/skills/phase-0-build-foundation/SKILL.md`
- **Graph node**: `P0` — deps: none

### Phase 1: Secrets & Configuration Management
- **Goal**: Secrets generation, env validation, recovery key tooling
- **Files owned**: `scripts/generate-secrets.sh`, `scripts/generate-recovery-keys.sh`, `scripts/validate-env.sh`
- **Tests**: `scripts/test-secrets.sh` validates secret format, entropy, completeness
- **Skill**: `.devin/skills/phase-1-secrets-config/SKILL.md`
- **Graph node**: `P1` — deps: none

### Phase 2: Platform Service Installers
- **Goal**: systemd unit (Linux), launchd plist (macOS), NSSM enhancement (Windows)
- **Files owned**: `agent/platform/linux/*`, `agent/platform/macos/*`, `agent/platform/windows/*`
- **Tests**: `systemd-analyze verify`, `plutil -lint`, PowerShell syntax check
- **Skill**: `.devin/skills/phase-2-platform-services/SKILL.md`
- **Graph node**: `P2` — deps: none

### Phase 3: Code Hardening & Security Review
- **Goal**: Error handling, input validation, crypto edge cases, security review
- **Files owned**: `server/src/**/*.js`, `agent/*.py` (targeted fixes only)
- **Tests**: Existing suites + new security/edge-case tests must pass
- **Skill**: `.devin/skills/phase-3-hardening/SKILL.md`
- **Graph node**: `P3` — deps: P0, P1, P2

### Phase 4: CI/CD Pipeline Enhancement
- **Goal**: Linting, security scanning, dependency caching, dependabot
- **Files owned**: `.github/workflows/*.yml`, `.github/dependabot.yml`
- **Tests**: `actionlint` validation, workflow syntax checks
- **Skill**: `.devin/skills/phase-4-cicd/SKILL.md`
- **Graph node**: `P4` — deps: P0, P1, P2, P3

### Phase 5: Code Signing & Auto-Update
- **Goal**: Signing scripts, notarization automation, auto-update verification
- **Files owned**: `scripts/setup-signing.sh`, `docs/CODE_SIGNING.md`, `electron/package.json`
- **Tests**: Signing config validation, auto-update manifest verification
- **Skill**: `.devin/skills/phase-5-signing-autoupdate/SKILL.md`
- **Graph node**: `P5` — deps: P4

### Phase 6: Monitoring & Alerting
- **Goal**: Health endpoints, agent heartbeat monitoring, alerting, health dashboard
- **Files owned**: `server/src/routes/health.js`, `dashboard/src/pages/HealthPage.jsx`, `scripts/monitor.sh`
- **Tests**: Health endpoint tests, alerting threshold tests
- **Skill**: `.devin/skills/phase-6-monitoring/SKILL.md`
- **Graph node**: `P6` — deps: P3

### Phase 7: E2E Testing & Verification Automation
- **Goal**: Automated E2E test scripts, real-machine test checklist, regression automation
- **Files owned**: `tests/e2e/*.test.js`, `scripts/run-e2e.sh`, `docs/E2E_TEST.md`
- **Tests**: E2E test suite passes, regression suite passes
- **Skill**: `.devin/skills/phase-7-e2e-testing/SKILL.md`
- **Graph node**: `P7` — deps: P0, P1, P2, P3, P4, P5, P6

### Phase 8: Dependency Installation & SAST
- **Goal**: Dependency management, CodeQL SAST, lint workflows, pip-audit
- **Files owned**: `server/package.json`, `dashboard/package.json`, `agent/requirements-dev.txt`, `.github/workflows/codeql.yml`, `.github/workflows/lint.yml`
- **Tests**: eslint clean, ruff clean, pip-audit passes
- **Skill**: `.devin/skills/phase-8-deps-sast/SKILL.md`
- **Graph node**: `P8` — deps: P4

### Phase 9: Agent Integration E2E
- **Goal**: Agent checkin/ACK/location E2E flows, agent-helpers.js, agent-integration.test.js
- **Files owned**: `tests/e2e/agent-helpers.js`, `tests/e2e/agent-integration.test.js`, `scripts/run-e2e.sh`
- **Tests**: agent-integration.test.js passes, run-e2e.sh includes agent-integration flag
- **Skill**: `.devin/skills/phase-9-agent-e2e/SKILL.md`
- **Graph node**: `P9` — deps: P7

### Phase 10: Dashboard E2E (Playwright)
- **Goal**: Playwright E2E suite for auth + device flows, headless Chromium
- **Files owned**: `dashboard/playwright.config.js`, `dashboard/e2e/*.js`, `dashboard/package.json`
- **Tests**: Playwright config valid, E2E specs pass
- **Skill**: `.devin/skills/phase-10-dashboard-e2e/SKILL.md`
- **Graph node**: `P10` — deps: P7

### Phase 11: PostgreSQL Path Testing
- **Goal**: PostgreSQL compatibility testing, DB_SSL env var, dual-path (SQLite + PG)
- **Files owned**: `server/tests/postgres-compat.test.js`
- **Tests**: postgres-compat.test.js passes
- **Skill**: `.devin/skills/phase-11-postgres/SKILL.md`
- **Graph node**: `P11` — deps: P7

### Phase 12: Docker Compose Validation
- **Goal**: Docker Compose prod stack validation, Caddyfile, Dockerfile.server
- **Files owned**: `scripts/validate-docker.sh`, `docker-compose.test.yml`, `docs/DEPLOYMENT.md`
- **Tests**: validate-docker.sh passes, compose config validation
- **Skill**: `.devin/skills/phase-12-docker/SKILL.md`
- **Graph node**: `P12` — deps: P11

### Phase 13: Notifications, Metrics & Alerting
- **Goal**: Email/webhook/Slack notifications, metrics endpoint, alert scheduler, retention
- **Files owned**: `server/src/routes/metrics.js`, `server/src/notifications/notify.js`, `server/src/jobs/alertScheduler.js`
- **Tests**: notifications.test.js, metrics.test.js pass
- **Skill**: `.devin/skills/phase-13-notifications-metrics/SKILL.md`
- **Graph node**: `P13` — deps: P6

### Phase 14: Backup & Restore
- **Goal**: Backup script (pg_dump + sqlite3), restore script, encrypted backup option
- **Files owned**: `scripts/backup.sh`, `scripts/restore.sh`, `docs/BACKUP.md`
- **Tests**: backup.sh + restore.sh syntax valid, dry-run verified
- **Skill**: `.devin/skills/phase-14-backup-restore/SKILL.md`
- **Graph node**: `P14` — deps: P11

### Phase 15: Load Testing
- **Goal**: k6 load tests (baseline, lockdown spike, mixed), run-load-test.sh
- **Files owned**: `tests/load/k6-*.js`, `scripts/run-load-test.sh`, `docs/LOAD_TESTING.md`
- **Tests**: k6 scripts syntax valid, run-load-test.sh passes
- **Skill**: `.devin/skills/phase-15-load-testing/SKILL.md`
- **Graph node**: `P15` — deps: P13

### Phase 16: RBAC / Multi-Admin
- **Goal**: 3 roles (viewer, operator, super-admin), admins route, 007_rbac.sql migration
- **Files owned**: `server/src/routes/admins.js`, `server/src/db/migrations/007_rbac.sql`, `dashboard/src/pages/AdminsPage.jsx`
- **Tests**: admins.routes.test.js pass, RBAC permission matrix tests pass
- **Skill**: `.devin/skills/phase-16-rbac/SKILL.md`
- **Graph node**: `P16` — deps: P3

## Execution Order

The graph is the source of truth for phase dependencies. The orchestrator
enforces I1 (no phase runs before its deps are COMPLETE) via `graph_assert.py`.

```
Phase 0 ─┐
Phase 1 ─┼──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 7 ──→ Phase 9
Phase 2 ─┘    │     │                                  │           │
              │     └──→ Phase 8                       │           ├──→ Phase 10
              │                                        │           │
              ├──→ Phase 6 ──→ Phase 13 ──→ Phase 15   │           │
              │                          │             │           │
              └──→ Phase 16              └──→ ...      │           │
                                                    Phase 11 ─────┤
                                                      │           │
                                                      ├──→ Phase 12
                                                      │
                                                      └──→ Phase 14
```

Phases 0-2 can run in parallel (no file conflicts).
Phase 3 depends on 0-2 (hardening existing code).
Phase 4 depends on 0-3 (CI must test all artifacts).
Phase 5 depends on 4 (signing in CI).
Phase 6 depends on 3 (monitoring hardened code).
Phase 7 depends on 0-6 (E2E tests everything).
Phase 8 depends on 4 (SAST in CI).
Phase 9-10 depend on 7 (E2E extensions).
Phase 11 depends on 7 (Postgres compat).
Phase 12 depends on 11 (Docker uses PG).
Phase 13 depends on 6 (notifications on monitoring).
Phase 14 depends on 11 (backup uses PG).
Phase 15 depends on 13 (load test on notifications).
Phase 16 depends on 3 (RBAC on hardened code).
