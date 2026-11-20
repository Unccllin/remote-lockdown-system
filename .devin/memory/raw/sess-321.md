# Session Capture — 2026-11-20 — sess-321

## Context
- Task: S345: MOLE came online, so verify the last unproven half of store_lock (msvcrt.locking exclusion on Windows)
- Environment: repo remote-lockdown-system + Windows lab device MOLE (192.168.1.249) over OpenSSH, python 3.14.8 both sides
- Duration: <not specified>

## Decisions Made
- reuse the S315 SSH access path rather than inventing a transfer mechanism
- run the same exclusion protocol as S344 plus a lock-bypassed control, because a positive alone could be orchestrator artifact
- copy only memory.py (stdlib-only) to MOLE, avoiding a venv on the lab box

## Actions Taken
- measured msvcrt.locking exclusion on MOLE: +0.5568s EXCLUDED, control -0.5484s NOT EXCLUDED
- ran 20 concurrent memory.py capture through the real CLI on Windows: 20/20 kept
- recorded the coarse LK_LOCK retry (~1s) as a latency property of the Windows branch
- left the probe scripts in C:\Users\labadmin\lockdown-lock-test with the re-run commands in the artifact

## Outcomes
- What worked: - the control run: same protocol, only the lock line changed, so the sign of the gap isolates the lock
- checking memory.py's imports before deciding what could be transferred
- What failed: - nothing failed
- What was unexpected: - B entered ~0.55s after A released, not immediately: msvcrt LK_LOCK retries at ~1s intervals, so Windows waiters are coarse
- a 0-byte file is lockable on Windows, which was the specific doubt about locking byte 0 of a freshly created file

## Learnings
- a POSIX-only test cannot approximate msvcrt's semantics, and the one doubt (lockable zero-byte file) was answerable only on Windows
- when a blocker is access-shaped, the artifact that proves it should also document how to reach the host, or the next session rediscovers it

## Mistakes / Corrections
- mistake: S344 recorded the Windows blocker without the access path (SSH host+key), forcing a rediscovery from s315-*; correction: artifact and AGENTS.md now carry the re-run commands

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s345-store-lock-windows.txt
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
