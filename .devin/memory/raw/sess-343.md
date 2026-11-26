# Session Capture — 2026-11-26 — sess-343

## Context
- Task: D-229: make enrolment-token claims atomic with D1's primary key
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
- The fix was not 'add a lock' but 'make consumption one atomic operation': KV cannot, D1's PRIMARY KEY can, and the prepare/bind/run + meta.changes pattern already existed in rememberNonce two functions above.
- Parity ran the OPPOSITE way this time: Express already consumed the token with a conditional UPDATE ... WHERE used_at IS NULL plus a rowCount check, so D-229 was Worker-only. That is the argument for checking rather than assuming either direction.
- A claim row outlives the 15-minute token, so the cron needs a purge and should audit the count the way nonce_purge does.

## Mistakes / Corrections
- mistake: added the cron purge but left its result unused, which tsc flagged; correction: copy the whole block including its audit line, not just the call

## Open Questions
- <none recorded>

## File References
- serverless/d1/schema.sql
- serverless/kv-store.ts
- serverless/worker.ts
- serverless/worker.test.ts
- docs/artifacts/s369-d229-enrol-claim.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
