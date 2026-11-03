# Session Capture — 2026-11-03 — sess-181

## Context
- Task: Start the serverless-first plan: implement the Worker's missing /api/agent/update, which had left the default deployment unable to patch its fleet
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
- The shipped defaults already point at the Worker (agent/installer.py:61, installer_gui.py:64, agent_diagnostic.py:273, electron/test-simulation.js), so 'fully serverless' is finishing the serverless path, not pivoting to it.
- The agent calls GET /api/agent/update (agent.py:3238); the Worker had no such route, so raise_for_status() turned the 404 into a logged warning and the fleet could never be patched on the default deployment - while E-AUTO-UPDATE was still listed as verified.
- Implemented handleAgentUpdate in serverless/worker.ts: agent HMAC auth over the empty body, metadata from the agent_release KV key, Express-compatible response, per-platform hash/size, fails closed (500) on corrupt or incomplete metadata. The Worker holds NO signing key: signing happens in CI and the Worker only serves the result, so metadata cannot drift from the signed payload v1:{version}:{sha256}.
- Release publishing is two wrangler kv key put calls (binary:agent and agent_release) - documented in serverless/README.md.
- 6 tests + 3 mutations (auth, version comparison, metadata completeness) all KILLED. Coverage 88.93/82.84/92.85/90.7.
- Owner decisions this session: Worker is THE backend with Express optional; update metadata in the Worker; generic NSIS installer with runtime config; Cloudflare-native observability/backup replacing Prometheus/Grafana/pg_dump.
- Remaining parity gaps: installer/agent-version, link-pbl/unlink-pbl/by-pbl, rotate-key, location/latest, settings/retention, hw-test-artifact (3), integrations (2).

## Mistakes / Corrections
- mistake: earlier I treated 'the Worker has many routes' as 'the Worker is the backend' without reading the clients' configured defaults, which said Worker all along. The route diff plus 'what do the clients actually call' was the analysis that found the live defect.

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- serverless/README.md
- scripts/audit_test_teeth.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
