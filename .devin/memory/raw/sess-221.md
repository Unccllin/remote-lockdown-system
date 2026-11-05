# Session Capture — 2026-11-05 — sess-221

## Context
- Task: Session 221: find out why the machine sleeps quickly, ensure the app is silent, and fix the reinstall failure that surfaced.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300), service LockdownAgent running as LocalSystem, install dir C:\ProgramData\LockdownAgent, server on WSL at http://192.168.1.43:3001
- Duration: <not specified>

## Decisions Made
- Fix the OS power policy on AC (never sleep/hibernate) rather than claiming the app should hold wake; note the agent-side power request as the durable fix once a rebuild is possible.
- Leave battery policy untouched (operator trade-off).
- Delete legacy task + Run key whenever the service install succeeds, so exactly one starter exists.
- Stop the running agent before replacing its binary instead of treating 'binary unavailable' as a download problem.

## Actions Taken
- Measured powercfg: AC hibernate 1h, sleep 3h, nothing blocking sleep, no keep-awake calls in the agent.
- Added apply_managed_power_policy() (AC never sleep/hibernate) and remove_legacy_starters().
- Added stop_running_agent() and made _download_verified report its real failure; fixed RequestException-before-OSError ordering.
- Verified live: AC timeouts 0, Run key and task gone, service RUNNING, processes silent in session 0, check-in 11s old.

## Outcomes
- What worked: - powercfg /requests proved nothing (including the agent) was holding the machine awake, which pointed straight at policy rather than at a bug.
- Testing the download outside the installer isolated a file-lock from a network problem in one step.
- What failed: - The installer reported 'agent binary unavailable' for a locked executable, sending me to the server first.
- What was unexpected: - The app was already windowless; the noise came from leftover starters, not from visible UI.
- requests.RequestException subclasses OSError, making my except order unreachable.

## Learnings
- Diagnose sleep with powercfg rather than assuming an application is at fault.
- Distinguish failure causes at the point they occur; a single None hides four different problems.
- Remove legacy mechanisms when replacing them, or they keep starting duplicates.

## Mistakes / Corrections
- mistake: chased the download endpoint when the real failure was a locked destination file; correction: instrument the function itself on the target.

## Open Questions
- <none recorded>

## File References
- agent/service_installer.py
- agent/installer_gui.py
- agent/tests/test_installer_gui.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
