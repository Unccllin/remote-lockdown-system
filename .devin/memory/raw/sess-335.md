# Session Capture — 2026-11-26 — sess-335

## Context
- Task: Instrument D-225's unknown trigger: an in-flight KV watchdog on the check-in path, published on /api/health
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
- A promise that never settles cannot be timed on completion (finally never runs), so the instrument has to be a witness: arm a timer and, if the op is still pending when it fires, record and log the label.
- Two views answer different questions: kv_inflight (live, readable by a DIFFERENT request in the same isolate while the first is stuck) and kv_stalls (history, because the hung handler may never log again).
- Put the instrument in kv-store.ts: it is the KV layer and both agent-routes.ts and worker.ts already import from it, so no new dependency edge.
- Threshold 2 s is chosen against the agent's own 15 s check-in timeout: warn while the device is still waiting, so the culprit is named during the incident rather than described after it.
- A rejection is not a stall - it answered. Recording it as one would invert the signal.
- kv-store.ts importers (agent-routes, alerts, backup, worker) all reach the tsc graph through worker.ts, so the cascade is compiler-checked and not just test-checked.

## Mistakes / Corrections
- mistake: added watchKv to worker.ts's import list (which never calls it) instead of the two symbols worker.ts does use (kvInFlight, kvStalls), and a multi-site edit silently applied 3 of 5 blocks because two anchors were ambiguous; correction: tsc names both instantly - read the unused/undefined diagnostics before re-running tests

## Open Questions
- <none recorded>

## File References
- serverless/kv-store.ts
- serverless/agent-routes.ts
- serverless/worker.ts
- serverless/kv-stall.test.ts
- docs/artifacts/s360-kv-watchdog.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
