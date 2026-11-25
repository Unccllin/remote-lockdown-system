# Session Capture — 2026-11-24 — sess-327

## Context
- Task: Write the serverless deploy checklist and a post-deploy smoke that fails closed
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
- make verify-worker answers 'does the bundle build and route' against local workerd; a post-deploy smoke answers 'does the thing I deployed behave' — different questions, both needed
- A smoke must be read-only by default and put every write behind an explicit flag, or nobody will dare run it against production
- The negative control is the valuable run: with no token the smoke reported 4 failures and exit 1, proving it fails closed instead of green-lighting an unauthenticated deployment
- Replay protection is now proven at HTTP level (200 then 401 on an identical signed check-in), not only in unit tests

## Mistakes / Corrections
- mistake: the first smoke read setup.json.needs_setup while the route returns needsSetup, so it printed needs_setup=undefined, which reads like a pass; correction: read the contract from the handler and print the value actually received

## Open Questions
- <none recorded>

## File References
- docs/SERVERLESS-DEPLOY.md
- scripts/serverless-smoke.mjs
- serverless/README.md
- docs/README.md
- docs/artifacts/s351-serverless-deploy-smoke.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
