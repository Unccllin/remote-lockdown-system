---
name: phase-9-agent-e2e
description: Agent integration E2E tests that spawn the real Python agent process against a test server
---

# Phase 9 — Agent Integration E2E

## Context

Phase 7 created API-level E2E tests (supertest against Express, no real agent).
This phase adds integration tests that spawn the real Python agent process
against a test server, verifying actual encryption, lock screen, and key
management.

## Current State

### Agent Integration Test Infrastructure
- `tests/e2e/agent-helpers.js` — helper functions for agent process management
  - `startTestServer()` — starts Express on random port, returns `{url, cleanup}`
  - `createAgentConfig(serverUrl, apiKey, hostname, lockdownFolder)` — writes temp config.ini
  - `startAgent(configPath)` — spawns `python3 agent/agent.py`, returns `{process, cleanup}`
  - `waitForCondition(checkFn, timeoutMs, intervalMs)` — polling helper
  - `createTestLockdownFolder()` — creates temp dir with test files, returns `{path, files, cleanup}`
- `tests/e2e/agent-integration.test.js` — Jest test that spawns Python agent
  - Test: agent checks in to server
  - Test: lockdown encrypts LOCKDOWN_FOLDER files (verifies actual encryption)
  - Test: recovery decrypts LOCKDOWN_FOLDER files (verifies actual decryption)
  - Test: agent reconnects after server restart
  - Skips all tests if Python/cryptography not available
- `scripts/run-e2e.sh` — updated with `--agent-integration` flag

### Agent Config for Testing
```ini
[agent]
server_url = http://localhost:TEST_PORT
agent_key = TEST_DEVICE_API_KEY
hostname = test-device-001
lockdown_folder = /tmp/test-lockdown-XXXX
poll_interval = 2
verify_tls = false
```

### Test Flow (12 steps)
1. Start test Express server on a real port (not supertest in-process)
2. Create a temp LOCKDOWN_FOLDER with test files
3. Generate agent config.ini pointing to test server
4. Spawn `python3 agent/agent.py` as subprocess
5. Wait for agent to check in (poll device status via API)
6. Flag device stolen via API
7. Wait for agent to process lockdown command (poll command status)
8. Verify LOCKDOWN_FOLDER files are actually encrypted (can't read original content)
9. Recover via API
10. Wait for agent to process unlock command
11. Verify LOCKDOWN_FOLDER files are decrypted (can read original content)
12. Kill agent subprocess, clean up

## Verification

```bash
# Run agent integration E2E tests
make test-e2e

# Run with verbose output
scripts/run-e2e.sh --agent-integration --verbose

# Verify agent helpers exist
ls tests/e2e/agent-helpers.js tests/e2e/agent-integration.test.js

# Verify run-e2e.sh supports --agent-integration flag
grep "agent-integration" scripts/run-e2e.sh

# Full verification sweep (includes E2E)
make full-verify
```

## Regression checks

1. **Verify tests skip if Python not available**: `grep -c "skip\|python3.*version\|import cryptography" tests/e2e/agent-integration.test.js`
2. **Verify tests use polling with timeout (not fixed sleep)**: `grep -c "waitForCondition\|poll\|timeout" tests/e2e/agent-helpers.js`
3. **Verify lock screen is NOT tested (requires root/display)**: `grep -i "lock.screen\|lock_screen" tests/e2e/agent-integration.test.js` (should show skip or exclusion)
4. **Verify tests use Python script (not binary)**: `grep "python3.*agent.py" tests/e2e/agent-helpers.js`
5. **Verify POLL_INTERVAL=2 for fast tests**: `grep "poll_interval" tests/e2e/agent-helpers.js`

## Gotchas

- Agent needs Python + dependencies (cryptography, requests) installed — tests skip gracefully if missing
- Agent polling interval is set to 2s in test config (default 30s would make tests too slow)
- Lock screen is NOT tested (requires root/display access) — verified manually per docs/E2E_TEST.md
- Tests use the Python script (`python3 agent/agent.py`), not the PyInstaller binary — binary testing happens in CI (release.yml)
- Max 30s timeout per action (poll every 500ms) — with POLL_INTERVAL=2, agent should process commands within 4-6s

## Graph Integration

**Phase node**: `P9` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P9` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-AGENT

**Enforcement paths touched by this phase**: E-ENCRYPT, E-ACK, E-RECOVERY, E-OFFLINE-QUEUE

**Debt items related to this phase**: D-003 (CLOSED — hardware test harness built and verified on Azure Windows VM)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
