# Session Capture — 2026-11-03 — sess-182

## Context
- Task: Serverless parity increment 2: implement installer/agent-version and devices/:id/location/latest in the Worker, and make corrupt KV loud
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
- /api/installer/:deviceId is matched by an anchored regex in worker.ts, so 'agent-version' is read as a device id unless the specific route is registered FIRST. Express documents the same trap above its own route; the failure mode is a confusing 'Device not found'.
- Serve /api/installer/agent-version from the same agent_release KV record as /api/agent/update: Express hardcodes '1.0.0' in the former and reads the binary in the latter, which is a drift class worth never porting.
- /api/devices/:id/location/latest must return the NEWEST report (sort by created_at ascending, take last) and 404 when there are none; the Worker keeps locations in one KV list, unlike Postgres ORDER BY DESC LIMIT 1.
- All eight KV readers now use parseKvJson(raw, key), which names the key and re-throws on corrupt data. Falling back to an empty collection would make a tampered fleet look empty - wrong direction for anti-theft. The two  KV.delete() probes carry SAFETY comments stating the typeof guard.
- 361 tests pass; coverage 89.05/83.01/93.08/90.77; three mutations KILLED (hardcoded version, oldest-instead-of-newest, missing 404).
- Remaining parity: link-pbl/unlink-pbl/by-pbl, rotate-key, settings/retention, hw-test-artifact (3), integrations (2).

## Mistakes / Corrections
- mistake (avoided): the installer route-ordering trap was only avoided because I read Express's own comment above its equivalent route. Nothing in the Worker's dispatch makes that hazard visible.

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
