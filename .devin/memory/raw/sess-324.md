# Session Capture — 2026-11-24 — sess-324

## Context
- Task: Make the serverless deployment viable: fix the per-poll command-index cost, add the cron retention purge, verify the worker
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
- The check-in read the global command index then one record per id: 1 + (fleet commands) reads per poll. Per-device index takes it to <=2 command reads; 1,000 devices KES 63,400 -> 8,300/month.
- A device enrolled before the change has no per-device key, so listCommandIdsForDevice rebuilds once from the global index and persists it; the first poll pays the old price, later ones do not.
- 496 functional tests certified a path that was 26x more expensive than it needed to be. Cost regressions need operation-counting tests, not response assertions.
- A Worker has no process to host the Node server's schedulers: retention needed a [triggers] cron plus a scheduled() export; the alert tick and backup path were then still absent.

## Mistakes / Corrections
- mistake: tried to add Env.LOCATION_RETENTION_DAYS without reading pbl/env.ts first; correction: read-before-edit is enforced and the typecheck caught the missing property immediately after

## Open Questions
- <none recorded>

## File References
- serverless/kv-store.ts
- serverless/worker.ts
- serverless/agent-routes.ts
- serverless/pbl/env.ts
- serverless/wrangler.toml
- serverless/serverless-scale.test.ts
- docs/SERVERLESS-COST.md
- docs/artifacts/s348-serverless-scale.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
