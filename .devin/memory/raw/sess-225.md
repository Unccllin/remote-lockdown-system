# Session Capture — 2026-11-05 — sess-225

## Context
- Task: Session 225: rebuild the agent carrying the WTS gate and bundled tamper_protection; kill the recurring false tamper alarms.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300) with Python 3.12 + PyInstaller; agent built from agent.spec and run by the frozen lockdown-service.exe
- Duration: <not specified>

## Decisions Made
- Treat .locked/.deadman as state, not protected assets; protected assets are config.json.
- Treat service and scheduled task as alternative persistence (AND of the two missing flags), keeping the raw flags for reporting.
- Gate tsdiscon on an active console session, failing open so a broken WTS call cannot disable locking.
- Rebuild on the target from the existing spec rather than trusting the shipped binary.

## Actions Taken
- Fixed check_tamper (assets vs state, persistence semantics) and _lock_workstation (WTS gate).
- Rebuilt lockdown-agent.exe with PyInstaller (15,362,718 bytes) and installed it under the service.
- Verified: no TAMPER DETECTED, no D-007/tsdiscon, console Active, service RUNNING, check-in 27s old.
- Added 8 tests.

## Outcomes
- What worked: - Reading the healthy device's log showed both false alarms were logic errors, not intrusions.
- Checking agent.spec first showed the module was never missing — the binary was stale.
- What failed: - Weeks of TAMPER DETECTED lines were treated as noise instead of investigated; they were the S222 root cause.
- What was unexpected: - The spec had listed tamper_protection all along; only the shipped exe lacked it.
- A field named 'critical_files' held two files that are legitimately absent.

## Learnings
- Separate assets from state in any tamper/tripwire check.
- Alternatives must be modelled as OR in the failure condition, not as cumulative flags.
- A security alarm that fires on healthy state trains everyone to ignore it.

## Mistakes / Corrections
- mistake: recorded 'tamper_protection not bundled' (S221) as a build gap when the spec was correct and the artefact was stale; correction: rebuilt and verified.

## Open Questions
- <none recorded>

## File References
- agent/tamper_protection.py
- agent/agent.py
- agent/tests/test_tamper_check.py
- agent/tests/test_lock_workstation.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
