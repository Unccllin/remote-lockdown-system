# Session Capture — 2026-09-16 — sess-105

## Context
- Task: Bind PBL lock state to TPM platform hierarchy and fix OVMF docker harness
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
Custom OVMF with PeiDxeTpmPlatformHierarchyLibNull leaves platformAuth empty for swtpm testing.

## Mistakes / Corrections
Initial ci-harness-docker.sh used stock OVMF due to env var defaults; fixed by explicit /ovmf preference.

## Open Questions
- <none recorded>

## File References
/tmp/pbl-ci-artifact.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
