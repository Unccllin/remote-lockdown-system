---
name: phase-7-e2e-testing
description: API-level E2E tests for the full lockdown and recovery flow via HTTP
---

# Phase 7 — E2E Testing & Verification Automation

## Context

The system has unit tests for each component. This phase adds automated
end-to-end tests that verify the full lockdown → recovery flow via HTTP API
calls (no browser, no agent binary). `docs/E2E_TEST.md` documents the manual
E2E test procedure; this phase automates it.

## Current State

### E2E Test Infrastructure
- `tests/e2e/setup.js` — starts Express with SQLite temp DB, provides API helpers
  - `api()`, `createDevice()`, `agentCheckin()`, `flagStolen()`, `recover()`
  - Creates admin account, gets JWT
  - Clean up: stops server, deletes temp DB
- `tests/e2e/lockdown-flow.test.js` — full lockdown flow test (steps 1-11)
  - Admin creation → login → device enrollment → agent checkin → flag stolen →
    agent receives command → agent ACKs lockdown → key stored on server →
    verify state at each step via API + DB queries
  - Verifies audit log entries at each step
  - Tests device status transitions (active → stolen → active)
- `tests/e2e/recovery-flow.test.js` — full recovery flow test
  - Recover releases key, agent decrypts, files restored
  - Audit log records recovery
  - Edge case: recover without prior lockdown (should fail)
  - Edge case: double-recover (idempotent or fails gracefully)
- `scripts/run-e2e.sh` — E2E test runner
  - `--suite <all|lockdown|recovery>` — which tests to run
  - `--agent-integration` — include agent integration tests (requires Python)
  - `--verbose` — show full output
  - Starts test server, runs tests, reports results
  - Exit 0 if all pass, 1 if any fail

### Lockdown Flow Verification (11 steps)
1. Admin creation: `POST /api/setup/create-admin` → 201
2. Login: `POST /api/auth/login` → 200, JWT returned
3. Device enrollment: `POST /api/devices` → 201, `status=active`
4. Agent checkin: `POST /api/agent/checkin` → 200, `last_checkin` updated
5. Flag stolen: `POST /api/devices/:id/flag-stolen` → 200, lockdown command queued
6. Agent receives command: `GET /api/agent/checkin` → returns lockdown command
7. Agent ACKs lockdown: `POST /api/agent/command/:id/ack` → 200
8. Verify encryption key stored: `GET /api/devices/:id`
9. Recover: `POST /api/devices/:id/recover` → 200, unlock command queued
10. Agent ACKs unlock: `POST /api/agent/command/:id/ack` → 200
11. Verify device active: `GET /api/devices/:id` → `status=active`

### Documentation
- `docs/E2E_TEST.md` — updated with Automated E2E Tests section, `scripts/run-e2e.sh` usage, local testing instructions, CI integration

## Verification

```bash
# Run API-level E2E tests (lockdown + recovery + agent-integration)
make test-e2e

# Run specific E2E suite
scripts/run-e2e.sh --suite lockdown --verbose
scripts/run-e2e.sh --suite recovery --verbose

# Run with agent integration (requires Python)
scripts/run-e2e.sh --agent-integration --verbose

# Full verification sweep (includes E2E)
make full-verify
```

## Regression checks

1. **Verify E2E tests clean up after themselves**: `grep -c "afterEach\|afterAll\|cleanup" tests/e2e/setup.js`
2. **Verify E2E tests verify audit log entries**: `grep -c "audit" tests/e2e/lockdown-flow.test.js`
3. **Verify failure scenarios are tested**: `grep -c "crash\|wrong key\|offline\|server down" tests/e2e/*.test.js`
4. **Verify run-e2e.sh is standalone and CI-ready**: `scripts/run-e2e.sh --suite all --verbose; echo $?`
5. **Verify E2E tests use supertest (already a dev dependency)**: `grep "supertest" tests/e2e/setup.js`

## Gotchas

- E2E tests use SQLite temp file (not PostgreSQL) — PostgreSQL compatibility is tested separately in Phase 11
- Test DB is created and destroyed per test (`beforeEach`/`afterEach`) — no test artifacts should persist
- Agent integration tests (Phase 9) require Python + cryptography — API-level E2E tests do not
- Lock screen is NOT tested in E2E (requires root/display access) — verified manually per docs/E2E_TEST.md

## Graph Integration

**Phase node**: `P7` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P7` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-AGENT, V-DASHBOARD

**Enforcement paths touched by this phase**: E-ENCRYPT, E-ACK, E-RECOVERY

**Debt items related to this phase**: D-003 (CLOSED — hardware test harness built and verified on Azure Windows VM)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
