# Session Capture — 2026-11-05 — sess-228

## Context
- Task: Session 228: make the Windows artefacts reproducible (script + CI + make target) and guard them with tests.
- Environment: repo=remote-lockdown-system; FRANKENSTEIN 192.168.1.119 for real runs (Python 3.12 + PyInstaller); agent/dist gitignored; GitHub Actions windows-latest for CI
- Duration: <not specified>

## Decisions Made
- One script builds every Windows target from existing specs and verifies each output by size and MZ/PE, failing on a bad artefact.
- CI runs exactly that script on windows-latest with if-no-files-found: error, pinned SHAs and persist-credentials false.
- The Makefile only delegates, per the repo rule.
- Treat 'a build must never bake a server URL nobody chose' as the contract, with a test for the refusal case.

## Actions Taken
- Wrote build-windows-artifacts.ps1, the windows-artifacts workflow, the Makefile target and 6 guard tests.
- Ran the script for real on FRANKENSTEIN (agent + service targets) and checked the guard when misplaced.
- Found and fixed the sed extraction bug that baked DEFAULT_SERVER_URL = "" into generic installers since S213; added a scheme check.
- Made the build script ASCII-only after the em-dash/BOM parse failure on the target.

## Outcomes
- What worked: - Running the script on the target immediately exposed the encoding trap; linting alone would have passed it.
- The new guard test for an empty default surfaced a ten-session-old release-path bug.
- What failed: - The first draft used typographic dashes in a BOM-less file; PS 5.1 parsed it as ANSI and failed.
- What was unexpected: - The generic build script silently baked a garbage URL because sed's [^"]+ does not match an empty quoted value.
- Four existing tests had been passing only because of that bug.

## Learnings
- Test the build path, not just the product: a one-character regex shipped wrong URLs for ten sessions.
- Write PowerShell scripts in ASCII (or with a BOM); PS 5.1 misreads BOM-less UTF-8.
- Verify artefacts by content (PE header, size), not by exit code.

## Mistakes / Corrections
- mistake: trusted the URL extraction because the build 'succeeded'; correction: added the refusal test which failed and exposed it.

## Open Questions
- <none recorded>

## File References
- scripts/build-windows-artifacts.ps1
- .github/workflows/windows-artifacts.yml
- scripts/test_build_windows_artifacts.py
- Makefile
- scripts/build-generic-installer.sh
- scripts/test_generic_installer.py
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
