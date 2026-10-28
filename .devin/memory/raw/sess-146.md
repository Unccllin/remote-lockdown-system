# Session Capture — 2026-10-28 — sess-146

## Context
- Task: Execute the load-test harness for the first time using the owner's ProLiant, and fix the two defects it exposed
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
- tailnet path to the ProLiant is broken above ~800B client->server but fine server->client (20MB); inverting which side runs the server/generator removes the need for the MTU fix entirely
- chunked upload works: 700B chunks over an ssh ControlMaster, 184KB gzip in 86s, md5-verified — the only transfer that survives
- measured: k6 baseline 200VUs/60s = 10,225 req, 168 req/s, p95 355ms, 0% errors, exit 0; lockdown spike 200VUs/60s = 10,842 req, 178 req/s, p95 302ms, 0% errors, all 200 ACKs OK
- k6 exit code is the authority on thresholds (0 pass / 99 crossed); the summary-export's top-level 'thresholds: false' is a reporting quirk
- K6_AGENT_KEY must equal the server's AGENT_SHARED_KEY or you get http_req_failed 100% with sub-100ms latencies (looks like a broken server, is an auth mismatch)

## Mistakes / Corrections
- mistake: spent the first round trying to diagnose a 'slow server' when the generator->SUT direction was blackholed; check path MTU before blaming the SUT
- mistake: grew the S143 session block past 300 lines and broke the I4 compactness invariant twice; keep per-session blocks summary-sized and put detail in the doc being written
- mistake: earlier assumed the owner's sudo commands were on the critical path for load testing; they were not

## Open Questions
- <none recorded>

## File References
- server/src/index.js
- docs/LOAD_TESTING.md
- tests/load/results/k6-baseline-dl380p-20261028.json
- tests/load/results/k6-lockdown-spike-dl380p-20261028.json
- server/src/config/env.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
