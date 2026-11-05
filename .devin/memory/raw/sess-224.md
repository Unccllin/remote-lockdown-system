# Session Capture — 2026-11-05 — sess-224

## Context
- Task: Session 224: build the frozen service exe, add keep-awake, harden the host, and correct the duplicate-process record.
- Environment: FRANKENSTEIN 192.168.1.119 (Windows 11 26300) with Python 3.12 + PyInstaller; service LockdownAgent running the frozen lockdown-service.exe; server WSL at http://192.168.1.43:3001
- Duration: <not specified>

## Decisions Made
- Build the service exe on the target with PyInstaller rather than leaving the service dependent on Python.
- Treat an empty argv as service mode in frozen builds, because the SCM passes no arguments.
- Hold the keep-awake request in the service host rather than waiting for an agent rebuild.
- Withdraw the 'duplicate agent instance' item instead of 'fixing' it, because the measurement was wrong.

## Actions Taken
- Built lockdown-service.exe (onefile, noconsole), switched the binPath with --service, verified the service RUNNING with no python.exe.
- Found and fixed the empty-argv bug (exit 1066/0x20000001).
- Added acquire_keep_awake/release_keep_awake and the host-side guard, with 6 tests.
- Traced parent processes and corrected AGENTS.md and the backlog.

## Outcomes
- What worked: - The service log made both the argv bug and the keep-awake acquisition visible without guesswork.
- Capturing ParentProcessId settled the duplicate question in one command.
- What failed: - Three sessions treated tasklist counts as instance counts; nothing checked parentage until now.
- What was unexpected: - PyInstaller's bootloader doubles every process entry, so a 'duplicate' had been recorded as a defect since S220.
- The SCM passes no arguments at all — a detail invisible to every manual start.

## Learnings
- Check process parentage before concluding duplicates.
- A service executable must handle the SCM's empty argv.
- Put keep-awake where the longest-lived process is (the host), not where the feature logically belongs.

## Mistakes / Corrections
- mistake: recorded a duplicate-instance defect from tasklist counts; correction: measured the parent chain and withdrew it.

## Open Questions
- <none recorded>

## File References
- agent/service_host.py
- agent/service_installer.py
- agent/tests/test_service_host.py
- agent/tests/test_service_installer.py
- AGENTS.md
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
