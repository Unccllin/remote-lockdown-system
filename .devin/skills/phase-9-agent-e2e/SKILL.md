# Skill Domain: Phase 9 — Agent Integration E2E

## Context
Phase 7 created API-level E2E tests (supertest against Express, no real agent). This phase adds integration tests that spawn the real Python agent process against a test server, verifying actual encryption, lock screen, and key management.

## Current State
- tests/e2e/setup.js — starts Express with SQLite, provides API helpers
- tests/e2e/lockdown-flow.test.js — API-level lockdown test (no real agent)
- tests/e2e/recovery-flow.test.js — API-level recovery test (no real agent)
- agent/agent.py — full agent implementation (1669 lines)
- agent/config.ini.example — config template

## Research Findings
### Agent Process Testing Strategy
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

### Challenges
- Agent needs Python + dependencies (cryptography, requests) installed
- Agent polling interval is 30s by default — tests would be slow
- Solution: set POLL_INTERVAL=2 in test config for fast tests
- Agent needs to run as non-root for testing (lock screen may need root)
- Solution: use `--dry-run` mode if agent supports it, or test without lock screen
- Read agent/agent.py to find if there's a dry-run/test mode

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

### Test File Structure
- tests/e2e/agent-integration.test.js — Jest test that spawns Python agent
- tests/e2e/agent-helpers.js — helper functions for agent process management
- May need to skip tests if Python/cryptography not available

## Reasoning Questions
1. **Should tests skip if Python not available?**
   - Answer: Yes. Use `beforeAll` to check `python3 --version` and `python3 -c "import cryptography, requests"`. If missing, `test.skip` with message.

2. **How long should tests wait for agent actions?**
   - Answer: Use polling with timeout. Max 30s timeout per action (poll every 500ms). With POLL_INTERVAL=2, agent should process commands within 4-6s.

3. **Should lock screen be tested?**
   - Answer: No — lock screen requires root/display access. Test encryption and key management only. Lock screen is verified manually per docs/E2E_TEST.md.

4. **Should tests use the agent binary or Python script?**
   - Answer: Python script (`python3 agent/agent.py`). Binary may not be built. Script tests the same code.

## Implementation Guidelines
### tests/e2e/agent-helpers.js
- `startTestServer()` — start Express on random port, return {url, cleanup}
- `createAgentConfig(serverUrl, apiKey, hostname, lockdownFolder)` — write temp config.ini
- `startAgent(configPath)` — spawn python3 agent/agent.py, return {process, cleanup}
- `waitForCondition(checkFn, timeoutMs, intervalMs)` — polling helper
- `createTestLockdownFolder()` — create temp dir with test files, return {path, files, cleanup}

### tests/e2e/agent-integration.test.js
- Test: agent checks in to server
- Test: lockdown encrypts LOCKDOWN_FOLDER files
- Test: recovery decrypts LOCKDOWN_FOLDER files
- Test: agent reconnects after server restart (if feasible)
- Skip all if Python/cryptography not available

## File Boundaries
- CREATE: `tests/e2e/agent-helpers.js`, `tests/e2e/agent-integration.test.js`
- EDIT: `scripts/run-e2e.sh` (add `--agent-integration` flag)
- DO NOT EDIT: agent/agent.py, existing E2E test files, server source
