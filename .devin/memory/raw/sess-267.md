# Session Capture — 2026-11-13 — sess-267

## Context
- Task: Re-measure every verification gate after S266; set the serverless admin password; fix the make test-e2e teardown race it exposed
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- Nine documented gate counts were stale; re-measuring by running the owning command is the only way to know (agent 857->863, dashboard 231->260, script harness 251->255, verify-env 60->63 PASS, API E2E 10->14 tests).\n- A gate can exit non-zero without failing a test: sqlite3 raises SQLITE_MISUSE from its native error callback, an uncaught throw that kills the process with no test-level trace.\n- sqlitePool.getDb() reopens lazily after end(), so the crash window is only a query already mid-flight when end() closes underneath it, not a query issued after.\n- Fix belongs at the pool layer, mirroring pg.Pool.end() (refuse new work + drain in-flight), not per test suite: tests/e2e/setup.js has no listening server so the agent-helpers drain fix could not be copied.\n- Regression tests must be mutation-checked: reverting the fix must reproduce the exact failure. It did.\n- semgrep, actionlint, shellcheck and k6 are all installed on this host; older notes claiming they cannot run are stale.

## Mistakes / Corrections
- mistake: ran the server suite with 'npx jest' instead of 'npm test' and read an ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG crash in postgres-compat.test.js as my own regression -> correction: the server runner is 'node --experimental-vm-modules node_modules/jest/bin/jest.js', which npm test supplies.\n- mistake: first regression test asserted promise settlement order ['query','end'] when end() legitimately settles first because trackEnd() runs in the finally block -> correction: assert the property (the statement ran to completion and returned its full count), not the microtask order.\n- mistake: treated a concurrent-Playwright E2E failure as a fair isolated rerun -> correction: it was still racing another harness; the honest evidence was 10 sweeps after the fix under the same concurrency.

## Open Questions
- <none recorded>

## File References
- server/src/db/sqlitePool.js\n- server/tests/sqlitePoolEnd.test.js\n- docs/artifacts/s267-e2e-teardown-race.txt\n- AGENTS.md\n- tests/e2e/agent-helpers.js\n- tests/e2e/setup.js\n- scripts/run-e2e.sh

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
