# Session Capture — 2026-11-03 — sess-184

## Context
- Task: Finish Worker parity: port the hardware-test artifact routes (the D-129 evidence path) and fix a sort bug the audit's baseline gate surfaced
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
- HW test artifacts are the D-129 evidence path: without them a serverless deployment cannot file what the hardware runbook requires. Both shapes must be accepted - CTRF ({results:{tool,summary,extra}}) and the legacy ({harness_version,summary,environment}) the harness emitted for months. Rejecting either loses a hardware run.
- Real bug found: the artifact list sorted by created_at alone, and two uploads can share a millisecond (the harness uploads a batch), so 'newest first' was ambiguous. Fix: tie-break on the monotonic numeric id. My own test failed its BASELINE inside the audit because of it, which made two mutation verdicts unscoreable and misattributed a third - the fix belongs in the sort, not a sleep in the test.
- List responses carry summary rows only (no artifact_json); GET /:id returns the full blob; ids are decimal strings so the dashboard's /^\d+$/ validation still holds; POST links the artifact to the device whose hostname matches and writes an audit entry.
- integrations is NOT an endpoint port: 442 lines across index/meshcentral/errors/graph, a connector registry that calls upstream HTTP. Porting needs a decision (shared module vs Worker-only minimal connector vs self-hosted-only), so it was left explicitly open rather than half-ported.
- 378 tests; coverage 89.36/82.83/93.92/91.42; four mutations KILLED (CTRF rejected, device link dropped, blobs in list, arbitrary artifact by id).

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- scripts/audit_test_teeth.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
