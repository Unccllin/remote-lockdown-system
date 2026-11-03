# Session Capture — 2026-11-03 — sess-183

## Context
- Task: Serverless parity increment 3: port link-pbl/unlink-pbl/by-pbl, rotate-key and settings/retention to the Worker
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
- Two more route-ordering traps of the same shape as the installer one: /api/devices/:id is an anchored regex, so 'settings' and 'by-pbl' get read as device ids unless registered BEFORE it. Both answers would be a plausible 404 'Device not found' from an endpoint that is fine - the most misdiagnosable failure shape. Both now have tests.
- Business rules preserved from Express: one firmware identity links to at most one agent (409 naming the current owner - two claimants make the verdict target ambiguous); unlink on an unlinked device is 400 not a silent success; a rotated key's plaintext is returned once while only its hash is stored.
- rotate-key test asserts the property that matters: the NEW key authenticates an agent check-in and the OLD one gets 401 (not merely that a key came back).
- Worker Device gains pbl_device_id?: string | null; readJsonBody() returns null on malformed JSON instead of throwing a bare SyntaxError.
- 371 tests; coverage 89.07/83.08/93.52/91.09; three mutations KILLED (409 collision, stored-hash update, unlink 400).
- Pre-existing dead code in worker.ts confirmed at HEAD and queued for its own cleanup commit: verifyAdminAuth, boot_lock_detail, generateSigningKey, importPrivateKey, checkDeviceRateLimit, DEVICE_RATE_LIMITS.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- scripts/audit_test_teeth.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
