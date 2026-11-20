# Session Capture — 2026-11-17 — sess-282

## Context
- Task: Extract the /v1 PBL route dispatcher and the isolate signing-key cache out of worker.ts into pbl/routes/index.ts and pbl/keys.ts
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
- Find the one or two worker-local dependencies of a route block first: here it was a pair of per-isolate key getters, and moving them beside the routes removed the last tie back to the Worker.
- Check how tests obtain an exported symbol before moving it: the harness read resetKeyCache off the worker module with a defensive if-guard, so a missing re-export would have failed silently rather than loudly.
- Remove the imports a move orphans in the same commit; leaving them for the linter makes the next reader think the host still uses them.

## Mistakes / Corrections
- mistake: trusted a python print of line counts computed with escaped backslashes, which reported "worker.ts: 3". correction: wc after the edit.
- mistake: earlier import pruning by regex reported success while matching nothing; the linter found what the script claimed to have removed.

## Open Questions
- <none recorded>

## File References
serverless/pbl/routes/index.ts, serverless/pbl/keys.ts, serverless/worker.ts

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
