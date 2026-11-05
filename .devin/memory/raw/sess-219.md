# Session Capture — 2026-11-05 — sess-219

## Context
- Task: Session 219: why does nothing survive a logon on FRANKENSTEIN — agent starts then vanishes with no log.
- Environment: FRANKENSTEIN 192.168.1.119; two local accounts (SSH 'user', console 'NEWARK USER'); install dir C:\ProgramData\LockdownAgent; scheduler known broken (S218)
- Duration: <not specified>

## Decisions Made
- Diagnose with ownership/permission evidence (icacls) rather than changing code: the symptom 'no log line' points at an unwritable log.
- Record that persistence now requires a product decision (grant modify, SYSTEM task, or a real service) instead of patching around it.

## Actions Taken
- Rebooted state observed (uptime 84s, console NEWARK USER logged on, Run key intact) with no agent process and no new log line.
- Checked icacls: Users have RX only on agent.log/config.json; the Run key launches non-elevated so the agent cannot write.
- Confirmed the same exe runs when started elevated (pid 12684).
- Recorded the three blocked persistence paths and their distinct reasons.

## Outcomes
- What worked: - Reading ACLs explained a silent failure that two sessions had blamed on the scheduler.
- Comparing accounts (user vs NEWARK USER) explained why the Run key appeared not to fire at all.
- What failed: - I assumed 'no log line' meant 'never started'; it actually means 'started and could not write'.
- What was unexpected: - C:\Users contains both 'user' and 'NEWARK USER', so the install is effectively private to the SSH account.
- Windows lets a process start, fail to create its log, and exit with no event-log trace.

## Learnings
- A shared path (ProgramData) is not a shared permission; check effective ACLs.
- When a daemon leaves no trace, suspect file permissions before suspecting the launcher.
- Persistence design must match the privilege level of its launch context.

## Mistakes / Corrections
- mistake: attributed the missing agent after logon to the Run key not firing; correction: it fired, and the process died on its first write.

## Open Questions
- <none recorded>

## File References
- .devin/brain/beliefs.yaml
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
