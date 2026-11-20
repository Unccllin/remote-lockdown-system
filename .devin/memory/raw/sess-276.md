# Session Capture — 2026-11-17 — sess-276

## Context
- Task: Take the Worker locations store off the whole-list write: per-report records with a per-device index and a per-device cap (ADR-004)
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
- A global cap shared by N devices is a per-device cliff: 1000 rows / 60 tracking devices = 16 reports each (~8 min at a 30s poll), and the chattiest device starves the rest. Partition the retention per entity, not just the storage.
- Pruning a per-entity store must delete the RECORDS, not only the index ids: an immutable record (a location report) is never rewritten in place, so an unindexed record lives forever.
- Migrating rows that have no id needs DETERMINISTIC ids (hash of row content), otherwise two isolates migrating at once duplicate every row; generateId() is only safe for live writes.
- Assert key layout through the KV interface (list with a prefix), never through a mock private storage object.
- A retention limit no test can cross is untested: make it env-overridable as a [vars] entry (LOCATION_HISTORY_LIMIT), following ACTIVE_POLL_SECONDS.

## Mistakes / Corrections
- mistake: the first test version reached into MockKV private storage (data.keys()), which does not exist. correction: go through the KV interface the mock implements (list/put/get).
- mistake: nearly bounded the history fetch to the last N ids before sorting, which would have reintroduced the S272 defect (a backfilled report with an older observed_at dropping rows). correction: keep the full-window sort and record the cost as a residual.
- mistake: passed backticks inside a shell double-quoted --learnings argument, so bash ran them as command substitution and the capture was lost. correction: single-quote tool arguments that contain markdown code spans.

## Open Questions
- <none recorded>

## File References
docs/adr/ADR-004-per-entity-location-reports.md, serverless/worker.ts, serverless/worker.test.ts, serverless/pbl/env.ts, serverless/README.md, docs/artifacts/s274-location-per-entity-keys.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
