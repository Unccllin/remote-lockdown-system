# Session Capture — 2026-09-01 — sess-028

## Context
- Task: Deploy lockdown agent on Windows test machine DESKTOP-RUDJGI6
- Environment: remote-lockdown-system, agent/, serverless/
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: Agent persistence: scheduled task creation fails with -2147467259. Agent dies when PowerShell terminal closes. Lock screen shows as small window not fullscreen.
- What was unexpected: Start-Process -WindowStyle Hidden does not fully detach from parent console

## Learnings
Agent dies when terminal closes because it is a child of PowerShell. Scheduled task creation failed with -2147467259 so no watchdog exists. server_url must NOT include /api suffix. ctypes.WNDPROC does not exist use WINFUNCTYPE. console=False makes stdout None. Sentinel .locked causes crash loop.

## Mistakes / Corrections
Repeatedly asked user to restart agent without fixing why it keeps dying. Missed server_url /api/api/ doubling. Missed ctypes.WNDPROC in create(). Did not track scheduled task failure.

## Open Questions
- <none recorded>

## File References
agent/agent.py agent/lock_screen.py agent/service_installer.py agent/deploy.ps1 agent/reenroll.ps1

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
