# Remote Lockdown System - Production Readiness Phases

## Overview

Eight phases covering full production readiness. Each phase has:
- **Skill domain**: `.devin/skills/phase-N-<name>/SKILL.md` — knowledge base agents consult
- **Phase config**: `.devin/orchestration/phases/phase-N.conf` — file ownership, tests, tasks
- **Master orchestrator**: `.devin/orchestration/orchestrator.sh` — manages phase execution
- **Test gates**: phase-specific tests + existing regression suites must pass

## Orchestration Protocol

1. Master orchestrator starts a phase by reading its config
2. Subagents are spawned for each task in the phase
3. Subagents consult the skill domain before/during work
4. If a new task appears mid-phase, a NEW subagent is spawned (existing subagents don't context-switch)
5. Subagents reason about findings, question assumptions, then implement
6. Each phase has file ownership boundaries — agents only edit their phase's files
7. Tests run after each task; if tests fail, loop: review skill domain → fix → re-test
8. Phase completes only when all phase-specific tests AND regression tests pass

## Phases

### Phase 0: Build Foundation & Artifact Verification
- **Goal**: Top-level build orchestration, artifact checking, reproducible builds
- **Files owned**: `scripts/build-all.sh`, `scripts/check-artifacts.sh`, `Makefile`
- **Tests**: `scripts/check-artifacts.sh` validates build outputs exist and are non-empty
- **Skill**: `.devin/skills/phase-0-build-foundation/SKILL.md`

### Phase 1: Secrets & Configuration Management
- **Goal**: Secrets generation, env validation, recovery key tooling
- **Files owned**: `scripts/generate-secrets.sh`, `scripts/generate-recovery-keys.sh`, `scripts/validate-env.sh`
- **Tests**: `scripts/test-secrets.sh` validates secret format, entropy, completeness
- **Skill**: `.devin/skills/phase-1-secrets-config/SKILL.md`

### Phase 2: Platform Service Installers
- **Goal**: systemd unit (Linux), launchd plist (macOS), NSSM enhancement (Windows)
- **Files owned**: `agent/platform/linux/*`, `agent/platform/macos/*`, `agent/platform/windows/*`
- **Tests**: `systemd-analyze verify`, `plutil -lint`, PowerShell syntax check
- **Skill**: `.devin/skills/phase-2-platform-services/SKILL.md`

### Phase 3: Code Hardening & Security Review
- **Goal**: Error handling, input validation, crypto edge cases, security review
- **Files owned**: `server/src/**/*.js`, `agent/*.py` (targeted fixes only)
- **Tests**: Existing suites + new security/edge-case tests must pass
- **Skill**: `.devin/skills/phase-3-hardening/SKILL.md`

### Phase 4: CI/CD Pipeline Enhancement
- **Goal**: Linting, security scanning, dependency caching, dependabot
- **Files owned**: `.github/workflows/*.yml`, `.github/dependabot.yml`
- **Tests**: `actionlint` validation, workflow syntax checks
- **Skill**: `.devin/skills/phase-4-cicd/SKILL.md`

### Phase 5: Code Signing & Auto-Update
- **Goal**: Signing scripts, notarization automation, auto-update verification
- **Files owned**: `scripts/setup-signing.sh`, `docs/CODE_SIGNING.md`, `electron/package.json`
- **Tests**: Signing config validation, auto-update manifest verification
- **Skill**: `.devin/skills/phase-5-signing-autoupdate/SKILL.md`

### Phase 6: Monitoring & Alerting
- **Goal**: Health endpoints, agent heartbeat monitoring, alerting, health dashboard
- **Files owned**: `server/src/routes/health.js`, `dashboard/src/pages/HealthPage.jsx`, `scripts/monitor.sh`
- **Tests**: Health endpoint tests, alerting threshold tests
- **Skill**: `.devin/skills/phase-6-monitoring/SKILL.md`

### Phase 7: E2E Testing & Verification Automation
- **Goal**: Automated E2E test scripts, real-machine test checklist, regression automation
- **Files owned**: `tests/e2e/*.test.js`, `scripts/run-e2e.sh`, `docs/E2E_TEST.md`
- **Tests**: E2E test suite passes, regression suite passes
- **Skill**: `.devin/skills/phase-7-e2e-testing/SKILL.md`

## Execution Order

Phases 0-2 can run in parallel (no file conflicts).
Phase 3 depends on 0-2 (hardening existing code).
Phase 4 depends on 0-3 (CI must test all artifacts).
Phase 5 depends on 4 (signing in CI).
Phase 6 depends on 3 (monitoring hardened code).
Phase 7 depends on 0-6 (E2E tests everything).

```
Phase 0 ─┐
Phase 1 ─┼──→ Phase 3 ──→ Phase 4 ──→ Phase 5 ──→ Phase 7
Phase 2 ─┘                │                          │
                          └──→ Phase 6 ─────────────┘
```
