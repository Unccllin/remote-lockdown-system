# Session Capture — 2026-08-28 — sess-024

## Context
- Task: Complete audit of all 21 harnesses/subsystems in the project
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
- 21 harnesses total: 7 test suites, 7 infrastructure, 7 auxiliary
- 84 improvement opportunities found across all harnesses
- Biggest miss: firmware/UEFI test harness (QEMU/OVMF + swtpm) — 6 test scripts, entirely outside CI
- No coverage reporting in ANY of the 21 harnesses
- No shared fixtures in any harness — all duplicate setup code
- Memory harness has race conditions (no file locking, no atomic writes)
- Memory consolidate/decay are manual, not automated despite docs saying every 5/10 sessions
- E2E is orphaned — not in Makefile, not in CI, not in verify-env
- Hardware HIL harness only covers 5 of 12+ enforcement paths
- test_boot_lockdown.py is 3056 lines, worker.test.ts is 1273, test_agent.py is 2027
- test_tamper_protection.py has backwards skip logic (skips on Windows, the only platform that matters)
- Graph assertion doesn't verify cited files exist
- Load testing never runs (no CI, no schedule, no make target)
- Docker test compose never actually run in CI
- PostgreSQL smoke test not in CI
- Firmware DNS tunnel tests have no assertions
- Prioritized into P0 (4 items), P1 (8 items), P2 (9 items), P3 (8 items)

## Mistakes / Corrections
- Initially missed 7 harnesses in first pass (firmware/UEFI, phase orchestrator, harness template, wayfinder, manual boot lockdown, electron simulation, clean-state checklist)
- Initially missed 7 more in second pass (CI/CD, load testing, Docker, graph assertion, PostgreSQL smoke, code review, dependency audit)
- Should have done exhaustive find/grep sweep FIRST before launching audit agents

## Open Questions
- <none recorded>

## File References
- AGENTS.md (complete 21-harness audit with priorities)
- agent/hw_test_harness.py (hardware HIL harness, 5 of 12 paths)
- scripts/memory.py (memory harness, race conditions found)
- scripts/test_memory.py (memory tests, no CLI-level tests)
- .github/workflows/ci.yml (CI, no graph-check in release)
- .github/workflows/lint.yml (lint, no ruff format --check)
- firmware/build-capsule-test.sh (UEFI capsule test, not in CI)
- firmware/tpm-test/tpm-seal-test.sh (TPM seal test, not in CI)
- firmware/dns-tunnel/dns-tunnel-client.py (DNS tunnel, no assertions)
- .devin/graph/graph_assert.py (graph assertion, no self-tests)
- tests/pg-smoke/pg-smoke.js (Postgres smoke, not in CI)
- scripts/run-load-test.sh (load testing, not in CI)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
