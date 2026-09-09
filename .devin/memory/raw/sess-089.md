# Session Capture — 2026-09-09 — sess-089

## Context
- Task: Debug and fix firmware hang at 'Collecting platform state' in TPM-enabled QEMU+swtpm harness
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
- PCR reads return Device Error in swtpm (non-zero response code) — fail-soft zeros the PCR fields. Not a hang.

## Mistakes / Corrections
- Initial assumption was that the hang was in OVMF TCG2 init or a non-TPM platform-state helper. Debug prints proved it was in the first PBL-issued TPM2_PCR_Read command.

## Open Questions
- <none recorded>

## File References
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
