# Session Capture — 2026-11-05 — sess-217

## Context
- Task: Session 217: fix the three gaps from the first live install (duplicate agent, ONSTART-only task, false tamper alarm).
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300), agent installed at C:\ProgramData\LockdownAgent, server WSL on DESKTOP-G4PCDHH at http://192.168.1.43:3001
- Duration: <not specified>

## Decisions Made
- Guard both start paths with a tasklist probe instead of relying on the agent to enforce single-instance (it is a frozen binary we cannot rebuild here).
- Make the scheduled task the single start mechanism (schtasks /Run), so the task is proven at install time.
- Add the 5-minute repetition the comments had always claimed.
- Record, rather than paper over, the SYSTEM-launch failure: the evidence says the agent is healthy and the task context is not.

## Actions Taken
- Added _agent_running() and the same guard in launch_agent; switched install() to run the task; added /RI 5 /DU 24:00.
- Verified live: one process after a clean install, repeat registered, check-in recorded from a direct start.
- Measured the SYSTEM launch three ways and captured that it starts nothing while leaving no scheduler events.

## Outcomes
- What worked: - Counting processes after a clean install separated my own test duplication from the product's behaviour.
- Running the same exe interactively isolated the fault to the task context.
- What failed: - S216 recorded the duplicate as a product defect when part of it was my diagnostic; and I still cannot explain or fix the SYSTEM launch.
- What was unexpected: - The task reports success (Last Result 0) while starting nothing, and the scheduler's operational log has no events at all.
- schtasks /Change /RU needs a password, so the principal cannot be changed non-interactively.

## Learnings
- Verify the effect (a running process), not the exit code, when a scheduler is the launcher.
- Separate what the harness caused from what the product causes before recording a defect.
- An empty operational log is itself evidence: the scheduler thinks nothing happened.

## Mistakes / Corrections
- mistake: attributed my own duplicate Start-Process to the installer in S216; correction: measured instance count after a clean install and confirmed the guards hold.

## Open Questions
- <none recorded>

## File References
- agent/service_installer.py
- agent/installer_gui.py
- agent/tests/test_service_installer.py
- agent/tests/test_installer_gui.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
