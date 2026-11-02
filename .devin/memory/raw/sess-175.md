# Session Capture — 2026-11-02 — sess-175

## Context
- Task: Verify the Cloudflare Worker deploys: bundle builds, workerd serves, routes answer — without Cloudflare credentials
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
- serverless/worker.test.ts and pbl.test.ts call worker.fetch() directly, so nothing ran the code through esbuild or booted workerd; and there was no serverless documentation at all.
- scripts/verify-worker.sh covers both halves: wrangler deploy --dry-run --outdir bundles (164K) and greps the output for /v1/verdict, /api/agent/checkin, /api/enroll, /api/download/agent (a valid JS file that lost its router to tree-shaking would otherwise pass), then wrangler dev on loopback with --persist-to (local KV) and --var ADMIN_TOKEN/JWT_SECRET serves it.
- Route behaviour proven over HTTP: /api/setup/status 200; /api/devices 401 without token, 200 with the break-glass ADMIN_TOKEN (worker.ts:272 maps it to a synthetic super-admin), 401 with a bogus token; unknown path 404; POST /v1/verdict with junk -> 400 (routed and validated, not 5xx); GET /v1/policy/1 -> 200 (built-in default policy when KV is empty); /api/download/agent -> 404.
- Worker env usage: LOCKDOWN_KV (50), ADMIN_TOKEN (9), JWT_SECRET (2), PBL_SIGNING_KEY (1), PBL_POLICY_SIGNING_KEY (1). Publishing needs wrangler login + those four secrets + the KV id already in wrangler.toml.
- wrangler dev spawns workerd as a child, so kill the process group (setsid + kill -- -PID) or the port stays held.

## Mistakes / Corrections
- mistake: the first run asserted /v1/policy/1 would be 404 with an empty KV; it returns 200 because a built-in default policy is served. The check still passed because the case pattern accepted 200 or 404 — a check that accepts two outcomes for different reasons is weaker than it looks; the message now states which happened.

## Open Questions
- <none recorded>

## File References
- scripts/verify-worker.sh
- serverless/README.md
- serverless/worker.ts
- serverless/wrangler.toml
- Makefile
- docs/DEPLOYMENT.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
