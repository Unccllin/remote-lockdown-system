# Session Capture — 2026-11-06 — sess-254

## Context
- Task: Give the D-221 legacy uninstall-token deprecation a mechanical sunset (2027-02-04) enforced by three suites, instead of deleting the branch early (which would reverse ruling Q2-A)
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
- A tag-driven repo has no release cadence code can observe, so 'the release after this one' is unactionable; a date in the shared vectors file is the enforceable form
- Enforcement pattern repeated from the SAST gate: convert a statement into a failing check (contract test + both surface suites fail on the sunset date with the deletion checklist)
- A deadline can be gamed by setting it far out, so the window itself is asserted (<=180 days from d221_closed_at); both fields live in the reviewed shared artifact
- Both surfaces echo deprecated_scheme_sunset in the response, and each suite pins its local constant against the vectors file so drift fails a test

## Mistakes / Corrections
- mistake: my first ledger edit asserted on a string that the file wraps across lines ('for\n  one release'), so the assert failed silently until I re-read the actual text
- mistake: nearly deleted the legacy branch on 'proceed', which would have reversed Q2-A (dual-accept one release) closed one session earlier — the right move was to make the removal date mechanical

## Open Questions
- <none recorded>

## File References
- docs/adr/D-221-token-vectors.json
- scripts/test_cross_surface_contract.py
- server/src/routes/agent.js
- serverless/worker.ts
- server/tests/uninstallAuth.test.js
- serverless/worker.test.ts
- docs/API.md
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
