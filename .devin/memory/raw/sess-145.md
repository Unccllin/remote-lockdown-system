# Session Capture — 2026-10-27 — sess-145

## Context
- Task: Use the owner's ProLiant DL380p Gen8 (Tailscale peer) for whatever it can actually do
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
- the box has NO TPM (empty /sys/class/tpm, no /dev/tpm*) so PBL Stream A / D-129 is impossible there; Gen8 kits are TPM 1.2 and PBL needs 2.0
- tailnet path to that box is a one-way blackhole above ~1KB: 200B/800B arrive, 1.6KB+ arrives as 0B over ssh, rsync AND http; server->client moves 20MB fine. Chunked 'cat >>' at 700B/file is the only working upload
- config/env.js required Postgres vars whenever NODE_ENV=production without checking USE_SQLITE, so docker-compose.test.yml could never boot; fixed + 2 regression tests
- k6 load harness now executes end-to-end (k6 in docker, detached, summary-export needs a writable mount): 200 VUs/60s produced 200 requests and 100% timeouts, caused by the path not the server

## Mistakes / Corrections
- mistake: tested 20MB and 5MB to judge the tailnet; the real cutoff was between 800B and 1.6KB, so the first conclusion ('bulk is slow') missed that even a 3.7KB script cannot be pushed
- mistake: ran k6 attached to an ssh session; when the connection dropped the container died. Run it detached (docker run -d) and collect afterwards
- mistake: NODE_ENV=production with SQLite looked like my own env mistake; it was a real config bug and the reason that compose stack was never exercised

## Open Questions
- <none recorded>

## File References
- server/src/config/env.js
- server/tests/env.test.js
- docs/LOAD_TESTING.md
- ~/.ssh/config

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
