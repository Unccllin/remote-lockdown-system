# Session Capture — 2026-11-05 — sess-220

## Context
- Task: Session 220: implement the approved recommendation — run the agent as a real Windows service — and prove boot start with no logon.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300, Python 3.12 + pywin32 installed for the test), install dir C:\ProgramData\LockdownAgent, server WSL at http://192.168.1.43:3001
- Duration: <not specified>

## Decisions Made
- Service as the primary mechanism (boot, SYSTEM, no logon), task + Run key demoted to fallbacks.
- Verify RUNNING by polling sc query, not by trusting sc start's exit code.
- Discover the frozen service exe is the packaging target for machines without Python; python+script is the lab path.

## Actions Taken
- Added agent/service_host.py: SCM host supervising the agent with restart backoff, --service dispatcher mode, debug mode, [SERVICE] log lines, and a _StopHandle adapter.
- Rewrote install_service()/remove_service() with sc create/config/failure/start and a poll for RUNNING; install() prefers the service.
- Found and fixed two live bugs: binPath without --service caused SCM timeout 7009; is_set() on a Win32 handle caused 0x20000001.
- Rebooted the machine with no logon and confirmed the agent started and checked in (07:54:57).

## Outcomes
- What worked: - The SCM's own events (7009 timeout, service-specific error) pointed at each bug precisely.
- Rebooting with nobody logged on was the only honest test of unattended start, and it passed.
- What failed: - First service registration used a binPath that the SCM starts but nobody dispatches; and the supervisor used a threading.Event API on a handle.
- What was unexpected: - The agent ended up running in session 0 and immediately exercised its D-007 tsdiscon path.
- Two agent instances still start (host + the agent's own watchdog).

## Learnings
- A service binPath must reach an SCM dispatcher; python.exe script.py does not by itself.
- Win32 handles and threading.Event are not interchangeable; adapt explicitly.
- Only a boot with no logon proves unattended start.

## Mistakes / Corrections
- mistake: shipped a binPath and a stop-event usage that both failed on first contact with the SCM; correction: read the SCM events and fix the dispatcher and handle semantics.

## Open Questions
- <none recorded>

## File References
- agent/service_host.py
- agent/service_installer.py
- agent/tests/test_service_installer.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
