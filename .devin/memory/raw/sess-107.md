# Session Capture — 2026-09-16 — sess-107

## Context
- Task: Implement C2 bound HMAC session for PBL NV lock-state cache: includeAuth semantics, WRITTEN-aware names, real NV auth
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
- TPMA_NV standard layout: read bits 16-19, PLATFORMCREATE bit 30; 0x420D000D correct

## Mistakes / Corrections
- mistake: hashed parameterSize into rpHash -> response HMAC mismatch; correction: stage responseCode||params contiguously

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/ci-harness-persistence.sh

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
