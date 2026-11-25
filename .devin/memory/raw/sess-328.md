# Session Capture — 2026-11-24 — sess-328

## Context
- Task: Deploy the S348-S350 serverless work to the live Cloudflare account and verify it
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
- wrangler secret put has no stdin support in 4.162: it needs a TTY and silently does nothing when piped; use the API PUT /workers/scripts/<name>/secrets with the body in a 600 temp file
- Secret edits fail with 10215 while the live deployment is a rollback; deploy first, then set secrets
- The PBL firmware signing keys existed only in KV (auto-generated); exporting them to escrow matters more than setting a secret, because rotating them invalidates what deployed devices trust
- A route that is POST-only returns 404 on GET, which reads like a missing route; verify the method before concluding the deploy failed

## Mistakes / Corrections
- mistake: assumed piped stdin worked for wrangler secret put and did not verify the secret list after; correction: treat 'command exited 0' as unproven until the effect is observed (secret list, route status)

## Open Questions
- <none recorded>

## File References
- serverless/wrangler.toml
- secrets/serverless-secrets-2026-11-24.env
- docs/artifacts/s352-first-prod-deploy.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
