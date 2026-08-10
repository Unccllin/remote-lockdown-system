# Skill Domain: Phase 7 — E2E Testing & Verification Automation

## Context

The system has unit tests for each component but no automated end-to-end tests
that verify the full lockdown → recovery flow. `docs/E2E_TEST.md` documents a
manual E2E test procedure. This phase automates it.

## Current State

### Existing Tests
- `server/tests/e2e.lockdown.test.js` — server-side E2E test (mock DB, tests API flow)
- `server/tests/*.test.js` — unit tests for each route
- `agent/tests/test_agent.py` — agent unit tests
- `dashboard/tests/*.test.jsx` — component tests

### E2E Test Docs (docs/E2E_TEST.md)
Manual steps:
1. Install server + dashboard
2. Create admin account
3. Enroll a device
4. Install agent on device
5. Verify agent checks in
6. Flag device as stolen
7. Verify lockdown (folder encrypted, lock screen applied)
8. Track device (location reporting)
9. Recover device
10. Verify unlock (folder decrypted, lock screen removed)
11. Release device

### Gaps
- No automated E2E test that runs the full flow
- No test that verifies agent + server integration (only mocked tests)
- No test that verifies dashboard + server integration
- No test runner script for E2E tests

## Research Findings

### E2E Test Strategy
1. **API-level E2E**: Test the full flow via HTTP API calls (no browser, no agent binary)
   - Start server with test DB (SQLite in-memory or temp file)
   - Create admin → enroll device → simulate agent checkin → flag stolen → simulate agent lockdown ACK → recover → simulate agent unlock ACK
   - Verify state at each step via API + DB queries
   - Fast, reliable, no external dependencies

2. **Agent integration E2E**: Test agent + server together
   - Start server with test DB
   - Start agent with test config (pointing to test server, test LOCKDOWN_FOLDER)
   - Verify agent checks in
   - Flag stolen via API → verify agent encrypts folder
   - Recover via API → verify agent decrypts folder
   - Slower, requires Python + Node running together

3. **Dashboard E2E**: Test UI + server together
   - Start server
   - Use Playwright/Cypress to drive the dashboard
   - Login → enroll device → flag stolen → recover
   - Slowest, most flaky

### Recommended Approach
- **Phase 7a**: API-level E2E (fast, reliable, covers the critical flow)
- **Phase 7b**: Agent integration E2E (medium speed, covers agent behavior)
- **Phase 7c**: Dashboard E2E (future work — requires Playwright setup)

This phase implements 7a and 7b. Dashboard E2E is documented as future work.

### Test Infrastructure
- Server E2E tests use `supertest` (already a dev dependency)
- Agent E2E tests use `subprocess` to launch agent
- Test DB: SQLite temp file (already supported by server)
- Test LOCKDOWN_FOLDER: temp directory with test files
- Test agent config: generated from template with test values

### Lockdown Flow Verification
For each step, verify:
1. **Admin creation**: `POST /api/setup/create-admin` → 201, admin exists in DB
2. **Login**: `POST /api/auth/login` → 200, JWT token returned
3. **Device enrollment**: `POST /api/devices` → 201, device exists with `status=active`
4. **Agent checkin**: `POST /api/agent/checkin` → 200, `last_checkin` updated
5. **Flag stolen**: `POST /api/devices/:id/flag-stolen` → 200, `status=stolen`, lockdown command queued
6. **Agent receives command**: `GET /api/agent/checkin` → returns lockdown command
7. **Agent ACKs lockdown**: `POST /api/agent/command/:id/ack` → 200, command status=completed
8. **Verify encryption key stored**: `GET /api/devices/:id` → encryption key exists on server
9. **Recover**: `POST /api/devices/:id/recover` → 200, unlock command queued, key released
10. **Agent ACKs unlock**: `POST /api/agent/command/:id/ack` → 200, command status=completed
11. **Verify device active**: `GET /api/devices/:id` → `status=active`

### Recovery Flow Verification
1. Flag stolen → lockdown
2. Verify LOCKDOWN_FOLDER files are encrypted (can't read original content)
3. Recover → unlock
4. Verify LOCKDOWN_FOLDER files are decrypted (can read original content)

## Reasoning Questions

1. **Should E2E tests use a real agent binary or the Python script?**
   - Answer: Python script (`python agent.py`). Building a binary for each test run is slow and platform-specific. The Python script tests the same code path. Binary-specific testing happens in CI (release.yml).

2. **Should E2E tests clean up after themselves?**
   - Answer: Yes. Use `beforeEach`/`afterEach` to create and destroy temp DB, temp LOCKDOWN_FOLDER, and stop agent subprocess. No test artifacts should persist.

3. **Should E2E tests run in CI?**
   - Answer: Yes. Add an `e2e` job to ci.yml that runs `scripts/run-e2e.sh`. But this is Phase 4's territory — coordinate. For now, `run-e2e.sh` should be standalone and CI-ready.

4. **Should we test failure scenarios (agent crash, server down, wrong key)?**
   - Answer: Yes. The lockdown E2E test should include:
   - Agent can't reach server → offline queue works
   - Server releases wrong key → agent handles gracefully
   - Agent crashes mid-lockdown → state is recoverable
   - These are important edge cases for an anti-theft system.

5. **Should the E2E test verify the audit log?**
   - Answer: Yes. After each step, verify the audit log has the expected entry. The audit log is the forensic record — if it's wrong, the system's legal value is compromised.

## Implementation Guidelines

### tests/e2e/setup.js
- Start server with test DB (SQLite temp file)
- Create admin account, get JWT
- Provide helper functions: `api()`, `createDevice()`, `agentCheckin()`, `flagStolen()`, `recover()`
- Clean up: stop server, delete temp DB

### tests/e2e/lockdown-flow.test.js
- Full lockdown flow test (steps 1-11 above)
- Verify each step's response and DB state
- Verify audit log entries
- Test: agent receives lockdown command, ACKs, key stored on server
- Test: LOCKDOWN_FOLDER files are encrypted after lockdown
- Test: device status transitions (active → stolen → active)

### tests/e2e/recovery-flow.test.js
- Full recovery flow test
- Test: recover releases key, agent decrypts, files restored
- Test: audit log records recovery
- Test: device status returns to active
- Edge case: recover without prior lockdown (should fail)
- Edge case: double-recover (should be idempotent or fail gracefully)

### scripts/run-e2e.sh
- `--suite <all|lockdown|recovery>` — which tests to run
- `--agent-integration` — include agent integration tests (requires Python)
- `--verbose` — show full output
- Starts test server, runs tests, reports results
- Exit 0 if all pass, 1 if any fail

### docs/E2E_TEST.md updates
- Add "Automated E2E Tests" section
- Document `scripts/run-e2e.sh` usage
- Document how to run tests locally
- Document CI integration
- Keep manual test procedure (for real-machine testing)

## File Boundaries
- CREATE: `tests/e2e/setup.js`, `tests/e2e/lockdown-flow.test.js`, `tests/e2e/recovery-flow.test.js`, `scripts/run-e2e.sh`
- EDIT: `docs/E2E_TEST.md` (add automated testing section)
- DO NOT EDIT: existing test files, source code, or CI workflows
- DO NOT EDIT: `server/tests/e2e.lockdown.test.js` (existing server-side E2E — leave as-is)

## Graph Integration

**Phase node**: `P7` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P7` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-SERVER,V-AGENT,V-DASHBOARD

**Enforcement paths touched by this phase**: E-ENCRYPT,E-ACK,E-RECOVERY

**Debt items related to this phase**: D-003

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

