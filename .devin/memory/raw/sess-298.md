# Session Capture — 2026-11-18 — sess-298

## Context
- Task: S299: close the pywin32 loose end found in S298 — pin it and make the Windows build fail loudly without it
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
- agent/requirements.txt now pins pywin32==312 with; sys_platform == 'win32' so Linux installs are unchanged.
- scripts/build-windows-artifacts.ps1 checks 'import servicemanager, win32serviceutil' before building the service, and fails with the fix — because a service built without pywin32 is a valid PE that cannot start (SCM 1053, empty log).
- Two source-level tests pin ordering (check before PyInstaller) and the Windows-only marker; suite 8 passed, script still ASCII-only.

## Mistakes / Corrections
- mistake: none of consequence this session; the guard is source-pinned only because this host has no PowerShell and the build needs Windows.

## Open Questions
- <none recorded>

## File References
- agent/requirements.txt
- scripts/build-windows-artifacts.ps1
- scripts/test_build_windows_artifacts.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
