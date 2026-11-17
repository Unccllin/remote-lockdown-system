# Session Capture — 2026-11-17 — sess-274

## Context
- Task: Close the last fleet-rollout blocker: migrate the Worker's devices store from one whole-list KV value to per-entity records (ADR-003), extending the ADR-002 pattern that commands already use
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
- Per-entity records need a keyed lookup or auth becomes N+1: verifyAgentAuth scanned the device list, so agent_key:<sha256> -> device id must ship WITH the migration, not after (60 devices polling 300s = 288 reads/day -> 17,000).
- The migration blueprint is ADR-002 exactly: <entity>:<id> keys + an append-mostly index key + lazy idempotent migration from the legacy list key, then delete the legacy key.
- Deleting saveDevices() at the end is what makes the refactor verifiable: any leftover whole-list write becomes a compile error instead of a silent regression.
- Converting list-based storage to per-entity turns previously-cheap paths into N reads. Grep every listX(env) inside agent-facing handlers and replace with the record the auth layer already loaded.
- Tests that read KV keys directly break on any storage change (12 of them here). The repo already has the pattern: read through the API (readCommandViaApi / deviceIdByHostname), or through the documented metadata key.
- MockKV only implements get/put/delete, and the Worker uses no KV list(), so a prefix scan is not available - an explicit index is the mechanism.

## Mistakes / Corrections
- mistake: ran a multi-step python rewrite with a shared 'sub(old,new,count)' helper where one oldText matched twice ('const status = devices[idx].status;') - the assertion caught it before writing, but the run aborted mid-plan. correction: assert counts on ALL planned replacements up front, or do one replacement per call.
- mistake: assumed the check-in path's fleet read was harmless while converting writes - it was the hot path and would have become N+1. correction: after a storage-shape change, re-examine the read paths too, not only the writes.
- mistake: the ADR's own 'Alternatives rejected' claimed KV list() was pagination-only while MockKV does implement list(); the real reason to use an index is that the Worker never uses list() and pagination/consistency make it worse. correction: verify the claim against the code before writing it as a rationale.

## Open Questions
- <none recorded>

## File References
docs/adr/ADR-003-per-entity-device-records.md, serverless/worker.ts, serverless/worker.test.ts, serverless/README.md, docs/artifacts/s272-device-per-entity-keys.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
