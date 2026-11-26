# Session Capture — 2026-11-26 — sess-334

## Context
- Task: Make the shipped Windows build path stamp a build identity, and fail the build when the stamp does not reach the binary
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
- Two build entry points existed and only agent/build.ps1 stamped agent/_buildinfo.py, so the CI path (scripts/build-windows-artifacts.ps1) shipped build=unknown.unknown - the exact S286 defect on the path that publishes. The stamping now lives in scripts/stamp-buildinfo.ps1 and both callers invoke it with & (not pwsh, which is absent on plain Windows 10/11 hosts).
- A called PowerShell script must throw, not exit 1: exit inside a script invoked with & takes the caller down mid-build.
- $? is the success signal for a script invoked with &; $LASTEXITCODE reports the last NATIVE command and produced a false 'stamping failed' after a successful stamp.
- agent/build.ps1 uses relative paths and must run with the agent directory as CWD; passing -AgentDir \$PSScriptRoot to the shared script keeps the stamp CWD-independent.
- Set-Content -Encoding utf8 writes a BOM under PowerShell 5.1; -Encoding ascii keeps a generated Python module clean.

## Mistakes / Corrections
- mistake: ran the build through a grep pipeline, so grep's no-match exit 1 became the task's exit code and the real output was filtered into an empty log; correction: redirect to a file and capture the exit status separately from any filter
- mistake: checked $LASTEXITCODE after & script.ps1 and concluded a successful stamp had failed; correction: assert $? or let a throw propagate

## Open Questions
- <none recorded>

## File References
- scripts/stamp-buildinfo.ps1
- scripts/build-windows-artifacts.ps1
- agent/build.ps1
- scripts/test_build_windows_artifacts.py
- docs/artifacts/s359-build-identity.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
