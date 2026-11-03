# Session Capture — 2026-11-03 — sess-191

## Context
- Task: Fix the Worker's two generated install scripts (per-device installer + PblPersistDxe re-arm): they registered sc.exe services Windows kills ~30s after boot.
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
- The Worker's pi-lens advisories (JSON.parse x14, as-unknown-as x2, Record<string,any> x1) are byte-identical at HEAD; only declarations orphaned by an edit need fixing.

## Mistakes / Corrections
- mistake: in S190 the Express fix was scoped to the file I happened to open; both S191 and the S190 ruling existed only because a later grep found the second and third copies of sc.exe. Sweep for 'who else emits this artefact' BEFORE fixing, not after.

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts, serverless/worker.test.ts, serverless/README.md, .devin/PENDING-RULING.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
