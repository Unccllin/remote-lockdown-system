# Session Capture — 2026-11-05 — sess-226

## Context
- Task: Session 226: decide and implement the watchdog question (ship watchdog.exe or rely on the service).
- Environment: FRANKENSTEIN 192.168.1.119; agent built from agent.spec with PyInstaller and run by the frozen lockdown-service.exe; server WSL at http://192.168.1.43:3001
- Duration: <not specified>

## Decisions Made
- Rely on the Windows service's SCM crash recovery as the restart mechanism; do not ship a second watchdog process.
- Encode that in the agent rather than in documentation only: skip the watchdog expectation when session 0 and the service answers, keep it for interactive runs and for session-0 without the service.

## Actions Taken
- Added _service_provides_restart() and gated check_watchdog_health(), with 4 tests.
- Rebuilt and installed the agent (15,362,267 bytes).
- Verified with a timestamp-bounded log check that the new binary emits no watchdog warning, no tamper alarm and no tsdiscon, and that check-in continues.

## Outcomes
- What worked: - Naming the boundary (lines after 11:48:31) made the verification honest, because the same log holds the previous binary's warnings.
- Reading the service's sc failure configuration proved the watchdog was redundant before deleting its expectation.
- What failed: - Three sessions logged 'Watchdog not running' as a known issue without deciding which mechanism was authoritative.
- What was unexpected: - The watchdog and the service had coexisted in the design without either being declared canonical.

## Learnings
- Duplicate mechanisms need an explicit owner; otherwise both look unfinished.
- When verifying against a log that spans versions, bound the check by the binary's start time.

## Mistakes / Corrections
- mistake: left 'watchdog expected but not installed' as an open item across sessions; correction: made the decision, implemented it, and verified by timestamp.

## Open Questions
- <none recorded>

## File References
- agent/agent.py
- agent/tests/test_watchdog_service.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
