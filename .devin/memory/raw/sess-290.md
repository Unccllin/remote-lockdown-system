# Session Capture — 2026-11-18 — sess-290

## Context
- Task: S287: give the agent a build identity so two binaries stop both reporting 1.0.0
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
- Build metadata must not ride on AGENT_VERSION: server compareVersions maps each dot-segment through Number(), so a suffix becomes NaN and every update comparison would silently read as equal.
- Identity lives in a tracked agent/_buildinfo.py (committed defaults 'unknown'); build.ps1 stamps it with a UTC date + SHA-256 over agent/*.py, which works on MOLE where there is no git.
- version_string() is the single formatter for --version, the startup log and the crash log, so the two places a person looks cannot drift.
- A test fails if a STAMPED _buildinfo.py is committed, so a release cannot claim an identity it did not build.
- Proven on hardware: build=20261118.4bfeda526b77 in --version and in 'Agent starting ... build=...'.

## Mistakes / Corrections
- mistake: the first version of the import tripped the checker as an unresolved module; correction: keep the static import (PyInstaller needs it to bundle the module) and add a line-level pyright ignore with the reason, rather than switching to importlib which would have required a hiddenimports entry.

## Open Questions
- <none recorded>

## File References
- agent/agent.py
- agent/_buildinfo.py
- agent/build.ps1
- agent/tests/test_version_identity.py
- docs/artifacts/s287-build-identity.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
