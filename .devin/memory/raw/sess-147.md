# Session Capture — 2026-10-28 — sess-147

## Context
- Task: Push the repo to the ProLiant via chunks and implement HMAC signing in the k6 load scripts (closing the audit item)
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
- dd bs=700 piped through ssh still fails (0B in 2.5min): ssh coalesces stdio writes into oversized packets, so per-invocation 700B chunks over a ControlMaster are the only transfer (7.9MB/11336 chunks, md5-identical)
- per-device keys can be derived from one secret instead of shipped: key_i = base64(HMAC-SHA256(secret, 'load-test-device-0000i')); seeder stores api_key_hash via the server's own hashApiKey() so the pepper cannot drift
- server enforces: payload '{ts}:{nonce}:{sha256(body)}', hex HMAC-SHA256 with the device key, nonce 32-hex unique, timestamp window
- a WRONG secret fails at agentAuth (unknown x-agent-key), NOT at HMAC; only a probe holding the key constant proves signature enforcement
- full repo on an idle 32-core box boots with 0 errors, confirming the scheduler-after-migrations fix on a clean extraction

## Mistakes / Corrections
- mistake: first 'negative test' used a wrong secret and concluded signatures were not enforced because the server logged 0 HMAC rejections; the requests never reached the HMAC check
- mistake: k6 spike hoisted headers to a module constant — incompatible with per-request nonces; had to move to per-request authHeaders()
- mistake: assumed node_modules would be present in the full-repo extraction; it was installed in the earlier partial extraction. Symlinked after MODULE_NOT_FOUND (identical lockfile md5)

## Open Questions
- <none recorded>

## File References
- tests/load/lib/sign.js
- tests/load/hmac-probe.js
- scripts/seed-loadtest-devices.js
- tests/load/k6-baseline.js
- tests/load/k6-lockdown-spike.js
- tests/load/k6-mixed.js
- docs/LOAD_TESTING.md
- tests/load/results/k6-hmac-signed-spike-dl380p-20261028.json

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
