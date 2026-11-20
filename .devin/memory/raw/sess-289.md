# Session Capture — 2026-11-18 — sess-289

## Context
- Task: S286: install Python on MOLE, rebuild the agent from this tree, deploy it, and re-run the lock -> recover acceptance to prove the WinRE fix on hardware
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- MOLE's SSH session (labadmin) is already elevated, and winget/choco are absent: fetch python-3.14.8-amd64.exe with curl.exe and run it /quiet InstallAllUsers=1 PrependPath=1 TargetDir=C:\Python314. The dev interpreter is 3.14.8, so match it.
- Rebuild path on MOLE: deps from agent/requirements.txt + PyInstaller 6.22.3, then 'PyInstaller agent.spec' -> dist\lockdown-agent.exe (16.1 MB, sha256 b17f390d...). Source transferred as a 315,946-byte tarball, hash verified on arrival.
- Hardware proof of the WinRE fix: log line 'WinRE already disabled (reagentc /disable returned 2) - the state is what lockdown wants...' and bcd ACK detail moved from {success:false, rolled_back:true, critical_applied:0} to {success:true, rolled_back:false, critical_applied:3, best_effort_applied:5}; lockdown_effective 0 -> 1.
- Hardware proof of the S271 BIOS-restore reporting: old binary said 'Restored 0 BIOS settings' then claimed the BIOS was restored; new binary says [ERROR] 'Restored 0 of 5 ... every write was refused' and 'did NOT restore'.
- Unlock restores BCD 5/5 and explicitly does not re-enable WinRE that was disabled before lockdown.

## Mistakes / Corrections
- mistake: first exe swap copied while the agent child was still alive; Copy-Item reported 'copy ok' and the installed hash was unchanged (old bb32c3d2). Correction: Stop-Service, then kill any lingering lockdown-agent pid, then copy and verify Get-FileHash before claiming the deploy.
- mistake: assumed a service restart had relaunched the agent when the log showed only [SERVICE] heartbeat lines; correction: a live heartbeat is not a live check-in - confirm a new 'Agent starting' line and a fresh last_checkin.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s286-current-tree-acceptance.txt
- agent/build.ps1
- agent/agent.spec
- agent/bcd_lockdown.py
- .devin/graph/trace.md
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
