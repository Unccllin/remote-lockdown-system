# Session Capture — 2026-11-19 — sess-314

## Context
- Task: Measure option (c1): can an in-session helper obtain BSSIDs? (CreateProcessAsUser into session 1)
- Environment: MOLE session 1 (Newark User), SYSTEM launcher via temp service, consent Allow, Python 3.14 at C:\Python314
- Duration: <not specified>

## Decisions Made
- exercise the helper the way a real one must work (WTSQueryUserToken + CreateProcessAsUser on winsta0\\default), since Task Scheduler is broken
- re-run from a binary outside System32 to remove the documented prompt restriction as a confounder
- stop before RequestAccessAsync: it needs a human at the console, which is the precondition it would establish

## Actions Taken
- built a SYSTEM launcher; it created the child in session 1 (pid reported, waited)
- child #1 (powershell, System32): session 1, interactive, WlanGetNetworkBssList rc=5
- child #2 (C:\Python314\python.exe, outside System32, ctypes): rc=5 as well
- updated ADR-009 + AGENTS.md, asserted B-184, cleaned up the temp service

## Outcomes
- What worked: - CreateProcessAsUser with winsta0\\default put the child on the interactive desktop and it reported session 1
- moving script + report to C:\Users\Public fixed the silent no-report failure
- What failed: - first child produced no report at all: it lived in C:\Users\labadmin while the console user is Newark User
- service binPath with > redirection is rejected before starting; the launcher writes its own log instead
- What was unexpected: - the doc's outside-System32 condition was not the blocker; per-app consent is
- so an interactive install is IP-level too unless a user grants consent, which nothing in the installer requests

## Learnings
- powerShell inside System32 is disqualified from the consent prompt by path; use a non-System32 binary to test location features properly
- a launcher that cannot be read by the target user fails silently: check file permissions before concluding a child did nothing

## Mistakes / Corrections
- mistake: first (c1) attempt used a System32 binary and would have misattributed the denial to the session; correction: repeated it from C:\Python314

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s316-in-session-helper-probe.txt
- docs/adr/ADR-009-location-precision-by-install-type.md
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
