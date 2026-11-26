# Session Capture — 2026-11-26 — sess-336

## Context
- Task: Publish the first GitHub release of the Electron app (v1.0.5), fixing the build-identity and pipeline defects it exposed
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
- A GitHub release pipeline that has never run is unverified no matter how carefully it reads: seven defects only appeared on execution (missing PyYAML, shallow checkout vs I2, --timeout=30 without pytest-timeout, electron-rebuild of a tree that is not packaged, build.sh's venv vs the CI interpreter, draft-vs-release publish type, unclassified Worker-only routes).
- electron-builder's GitHub publisher defaults to creating a DRAFT: if a published release already exists for the tag it logs 'skipped publishing' and exits 0, so the job is green and the artifacts are silently absent. releaseType: 'release' in build.publish is the fix. A publish job must assert its own artifacts landed.
- agent/build.sh creates a .venv and switches PYTHON to it; CI installs requirements into the setup-python interpreter, so passing --no-venv (not --install, which only adds PyInstaller to the venv) is what makes it work there.
- publish-agent-binaries does not use build.sh at all - it calls PyInstaller directly - so the shared stamp must be invoked explicitly there too.
- electron-builder skips macOS notarisation with a warning when no APPLE_* credentials exist (MacTargetHelper.notarizeIfProvided -> getNotarizeOptions() === null), so notarize:true is safe without credentials but the DMG ships unnotarised.
- The build id is computed over checked-out bytes, so a CRLF Windows checkout and an LF Linux checkout of the same commit produce different ids.
- artifactName should be explicit: the first AppImage had spaces while latest-linux.yml listed the hyphenated name.

## Mistakes / Corrections
- mistake: piped a remote build through Select-String, whose no-match exit code 1 became the task result and hid the build's output; correction: redirect to a file and capture the exit status separately
- mistake: used %ERRORLEVEL% in a single cmd line, which expands at parse time and reported 0 for both builds; correction: verify by artifact (size, PE header, --version), not by echoing a variable
- mistake: ran a sed whose pattern contained ||, so it failed silently and the teeth check compared an unchanged file; correction: assert the substitution happened before trusting the test result
- mistake: claimed in an artifact that agent/build.sh builds the release's agent binaries; publish-agent-binaries calls PyInstaller directly

## Open Questions
- <none recorded>

## File References
- scripts/stamp_buildinfo.py
- scripts/stamp-buildinfo.ps1
- agent/build.sh
- .github/workflows/release.yml
- electron/package.json
- electron/main.js
- electron/preload.js
- electron/tests/preload.test.js
- scripts/test_cross_surface_contract.py
- docs/artifacts/s361-electron-release.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
