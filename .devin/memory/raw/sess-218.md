# Session Capture — 2026-11-05 — sess-218

## Context
- Task: Session 218: find why nothing starts the agent at boot on FRANKENSTEIN; verify the task-start improvement.
- Environment: FRANKENSTEIN 192.168.1.119 Windows 11 26300; agent at C:\ProgramData\LockdownAgent; SSH as frankenstein\user
- Duration: <not specified>

## Decisions Made
- Treat the scheduler's behaviour as a machine defect after a control experiment (cmd /c echo > file) proved tasks execute nothing while reporting success.
- Make install() believe the process, not schtasks' exit code: poll for the agent and warn + fall back when it does not appear.
- Use the HKLM Run key as the persistence that actually works on this machine, and say so rather than claiming the task works.

## Actions Taken
- Ran a control probe, an ONLOGON variant, and a schedule restart; all showed the scheduler is broken.
- Established that SSH-started processes die with the session (agent pid 14140 gone within 30s).
- Implemented the post-/Run process check with a warning and fallback; added a test; cleaned up the three probe tasks.
- Verified the install now reports the broken scheduler and still completes.

## Outcomes
- What worked: - The five-second control experiment (echo to a file) settled in one step what two sessions of task debugging could not.
- Reading the HKLM Run key found the persistence that had been working all along.
- What failed: - S217 spent effort changing principals and actions on a scheduler that executes nothing; the control probe should have come first.
- What was unexpected: - A task can report Last Result 0 and execute nothing, with an empty operational log.
- The Schedule service cannot even be opened for restart by this 'administrator' session.
- wscript launches the agent fine; the agent then dies with the SSH session.

## Learnings
- Control experiments beat inference: prove the mechanism works before tuning your use of it.
- Verify effects (processes, files), never exit codes alone.
- A remote SSH session is not a durable launcher on Windows.

## Mistakes / Corrections
- mistake: attributed the start failure to SYSTEM/principal before testing whether the scheduler worked at all; correction: control probe first.

## Open Questions
- <none recorded>

## File References
- agent/service_installer.py
- agent/tests/test_service_installer.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
