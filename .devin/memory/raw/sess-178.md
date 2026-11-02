# Session Capture — 2026-11-02 — sess-178

## Context
- Task: Mutation-audit the Worker command lifecycle: escrow ownership, terminal ACK status, command_uuid persistence
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
- All three mutations SURVIVED on the first run (predicted in advance): handleEscrowKey's ownership check, the status==='executed' dedup early-return, and the command_uuid write were all unasserted. The suite never mentioned 'deduplicated'.
- Consequence profile: a device could escrow a key against another device's command id; an executed command could be flipped to failed by a later ACK (history rewrite); the retry-idempotency uuid was never stored.
- Three tests added to serverless/worker.test.ts (file-local helpers, so they belong there): cross-device escrow -> 404 with the owner still 200; second ACK returns deduplicated:true AND the stored status stays 'executed' (read from LOCKDOWN_KV.get('commands')); command_uuid persists on the stored command.
- All three mutations now KILLED, naming the new tests. 340 tests pass, coverage 84.09/78.12/88/85.77 above the 82/75/86/82 floors.
- Worker KV keys: COMMANDS_KEY='commands', KEYS_KEY='encryption_keys'; tests can read them via env.LOCKDOWN_KV.get(...) for stored-state assertions.

## Mistakes / Corrections
- mistake: while cleaning an unused declaration I used str.replace(..., 1), which replaced the FIRST checkin2Data occurrence - the one the recover test uses - and broke a pre-existing test. It passed only because I re-ran the suite; fix was to target by line number and assert the expected text at each site.

## Open Questions
- <none recorded>

## File References
- serverless/worker.test.ts
- scripts/audit_test_teeth.py
- serverless/worker.ts

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
