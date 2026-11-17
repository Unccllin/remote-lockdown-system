# Session Capture — 2026-11-17 — sess-278

## Context
- Task: Take the last two whole-list stores (encryption_keys, bios_passwords) off the rewrite: one key per device, no index and no cap (ADR-006)
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
- When every access to a store is already scoped to one entity, that entity IS the partition: use a natural key (store:<deviceId>) and skip the index the earlier ADRs needed, because the population is the entity set and the rows per entity are single digits.
- Never put a retention cap on secrets: a cap that silently evicts is fine for history and catastrophic for an encryption key, where eviction means an unrecoverable device.
- A migration must preserve the storage encoding (KEK-encrypted vs plaintext rows), not re-encrypt or normalise rows as it moves them.
- Each store migrates on its own first read: reading the BIOS endpoint does not migrate the key store, so a test asserting both must trigger both readers.
- API state machines block test fixtures in ways worth tracing first: recover leaves a device in recovering (release refuses it), and an ACK must name a real queued command id.

## Mistakes / Corrections
- mistake: wrote ACKs with a made-up command_id ("ignored"), so no key was stored and three assertions failed with nulls. correction: read the queued command id from GET /api/devices/:id/commands after flagging.
- mistake: asserted both stores migrated after reading only the PBA endpoint; only that store migrates. correction: trigger each store own reader.
- mistake: tried to release a device after recover without ACKing the unlock, so status was recovering and release 409ed. correction: ack the unlock to reach active.
- mistake: compared an unsorted list() result against a sorted expectation. correction: sort both sides when the assertion is about the key set.

## Open Questions
- <none recorded>

## File References
docs/adr/ADR-006-per-device-secret-stores.md, serverless/worker.ts, serverless/worker.test.ts, serverless/README.md, docs/artifacts/s276-secret-stores-per-device-keys.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
