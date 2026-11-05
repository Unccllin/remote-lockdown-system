# Session Capture — 2026-11-05 — sess-222

## Context
- Task: Session 222: user reported the screen timing out after a few seconds; find the cause and fix it.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300), agent as service LockdownAgent, install dir C:\ProgramData\LockdownAgent
- Duration: <not specified>

## Decisions Made
- Diagnose from the agent log rather than the power settings: VIDEOIDLE was normal, so the screen was being disconnected, not idled.
- Treat the server's status as authoritative for a managed device: clear a stale latch on check-in, keeping the three locking statuses untouched.
- Remediate the live machine by clearing .locked/.deadman/.heartbeat, and record the WTS session-state thrash as a build-time follow-up instead of changing a frozen binary blind.

## Actions Taken
- Found D-007 tsdiscon entries every ~10s and traced them to a corrupt deadman ('stolen') plus an unconditional startup re-assert.
- Confirmed no user data was encrypted (lockdown_folder had only README.txt).
- Added reconcile_lock_state() after the check-in status is known, with 7 tests.
- Cleared the machine state, restarted the service, verified an Active console session and no new D-007 lines.

## Outcomes
- What worked: - The agent log named the exact behaviour (tsdiscon) and cadence, which made the power-settings theory immediately falsifiable.
- Checking the lockdown folder before deleting state confirmed nothing would be lost.
- What failed: - Earlier sessions read that log repeatedly and did not act on the repeated tsdiscon lines.
- What was unexpected: - A corrupt deadman file silently becomes status 'stolen', which is what latched the lockdown.
- The dashboard said active throughout; the sentinel said locked. Two sources of truth, no reconciliation.

## Learnings
- Two sources of truth need an explicit reconciliation rule, not an assumption about which one wins.
- A log line repeating every ten seconds is a symptom, not noise.
- Fail-secure defaults need an unwind path that does not require the original key.

## Mistakes / Corrections
- mistake: initially suspected the display timeout because the user said 'screen times out'; correction: VIDEOIDLE was 3h and the log showed tsdiscon.

## Open Questions
- <none recorded>

## File References
- agent/agent.py
- agent/tests/test_lock_reconcile.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
