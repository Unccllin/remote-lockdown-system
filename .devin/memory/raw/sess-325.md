# Session Capture — 2026-11-24 — sess-325

## Context
- Task: Close the three serverless gaps: alert tick, replay protection, D1 cutover
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
- The Node server's only device alert is device_stale (audit action health_alert); there is no deadman or lockdown-confirmation alert in the product, so mirroring that is the honest scope.
- A Worker has no process memory, so cron dedupe must be a KV marker with a TTL. Clearing it on check-in would be exact but adds a write to the hottest path; a 24h repeat window costs nothing there.
- Replay rejection is conditional on the store: a KV marker narrows the window (eventual consistency), a D1 UNIQUE constraint closes it. Never claim the second without the binding.
- A D1 read/write cutover cannot be verified without a live database; a fake proves only that prepare() is called. Schema plus a staged plan with exit conditions is the honest deliverable.

## Mistakes / Corrections
- mistake: alert tests seeded the legacy 'devices' key instead of 'device_index', so five tests failed with stale:0 while the code was correct; correction: seed through the store's exported key helpers rather than reconstructing the layout from memory

## Open Questions
- <none recorded>

## File References
- serverless/alerts.ts
- serverless/worker.ts
- serverless/kv-store.ts
- serverless/agent-routes.ts
- serverless/d1/schema.sql
- serverless/serverless-alerts.test.ts
- docs/SERVERLESS-D1-CUTOVER.md
- docs/artifacts/s349-serverless-alerts-replay-d1.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
