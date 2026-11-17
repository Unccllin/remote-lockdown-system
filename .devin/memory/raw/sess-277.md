# Session Capture — 2026-11-17 — sess-277

## Context
- Task: Take the Worker audit_log off the whole-list write: per-entry records behind one capped index that carries the device id (ADR-005)
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
- The write path every mutation goes through is where an N+1 hurts most: addAuditEntry scanned the whole fleet for one hostname, which ADR-003 turned into one read per device.
- One index carrying {id, device_id} beats two indexes: the read API is global-or-per-device, so the device id in the index buys scoped reads for one write instead of two on the busiest path.
- Converting list-based storage to per-entity leaves the ADMIN handlers scanning the fleet even when the agent paths were fixed; grep for listX(env).find(d => d.id === ...) across every handler, not just the hot ones.
- An artifact that counts KV gets proves a cost claim; a passing suite does not. Measuring gets before/after is the way to show an N+1 is gone.
- Release/anonymisation cascades that rewrite a whole trail can drop entries when a cap bites mid-rewrite; amend only the affected records.

## Mistakes / Corrections
- mistake: asserted "an append never reads device_index" when putDevice legitimately maintains that index. correction: assert the thing that matters - device RECORD reads are bounded, not the index probe - and enroll enough devices that a scan is distinguishable from a constant.
- mistake: flag-stolen was used twice in a fixture to produce two audit entries, but the second call 409s on an already-stolen device. correction: use an idempotent action (rotate-key) when a fixture needs N entries from one device.
- mistake: the cap pruned the bystander entry the release assertion needed, because the cap section ran first. correction: lift the limit for the section that needs an older entry to survive.

## Open Questions
- <none recorded>

## File References
docs/adr/ADR-005-per-entity-audit-entries.md, serverless/worker.ts, serverless/worker.test.ts, serverless/pbl/env.ts, serverless/README.md, docs/artifacts/s275-audit-per-entity-keys.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
