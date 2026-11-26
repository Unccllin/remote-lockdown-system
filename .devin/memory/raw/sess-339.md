# Session Capture — 2026-11-26 — sess-339

## Context
- Task: D-226: replace UUID-only re-arm with administrator approval (Worker half), recorded in ADR-011
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
- The PblPersistDxe ESP payload carries no secret by design (its own comment says so), so any re-arm proof must come from either firmware (TPM-sealed secret) or a human. The TPM route is blocked in practice by open D-134: platform-hierarchy NV indices, missing OWNERREAD, and unverified ownerAuth on Windows. A recovery path that fails on a client's real firmware is worse than one needing an admin awake — so approval, with ADR-011 recording the deferral.
- Approval must be single-use and time-limited and consumed BEFORE issuing the key, or two racing callers both get one. The technician retry is what makes it workable: the payload writes its success marker only after the install runs.
- The hwid:<uuid> pointer belongs in putDevice next to agent_key:, including deleting the stale pointer when the UUID changes, so the anonymous route never scans the fleet.
- Unknown and active devices must answer an IDENTICAL 404 so the route cannot be probed for which UUIDs exist.
- Express has its own server/src/routes/rearm.js with the same hole and a docstring defending 'the Computrace model' — the two backends now disagree, which is why D-226 stays OPEN.

## Mistakes / Corrections
- mistake: reused one Request object for the retry-after-approval attempt; a Request body can only be read once, so the handler correctly answered 400 and the test was wrong
- mistake: asserted the literal api_key inside the generated installer, whose config is base64-encoded, so the assertion could never pass; assert the stored hash changing instead
- mistake: replaced a block by string offsets that did not bracket it and broke worker.ts syntax; tsc caught it immediately and a pre-edit copy made the restore instant

## Open Questions
- <none recorded>

## File References
- docs/adr/ADR-011-rearm-requires-approval.md
- serverless/worker.ts
- serverless/kv-store.ts
- serverless/worker.test.ts
- scripts/test_cross_surface_contract.py
- docs/adr/PBL-DEBT-LEDGER.md
- docs/artifacts/s365-d226-rearm-approval.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
