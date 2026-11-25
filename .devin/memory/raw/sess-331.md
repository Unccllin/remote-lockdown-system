# Session Capture — 2026-11-25 — sess-331

## Context
- Task: Complete the interrupted pi session: commit and push the S347-S355 working tree, then continue with the TPM sealing rewrite and the 1.0.4 release
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
- The pre-push secret scanner blocks an assigned-secret shape in a smoke script; the fix is a recognised placeholder value, not an exception.
- serverless/backups/ contained a real S354 drill backup (every device, command, location, audit and admin record); it is now gitignored and was never staged.
- The TPM rewrite and the 1.0.4 Windows build both depend on MOLE, which is only reachable from the lab LAN (192.168.1.0/24); the laptop is on 10.131.72.0/24 with no VPN.
- Wrangler is authenticated, so the Cloudflare half of a release is ready as soon as a Windows binary exists.

## Mistakes / Corrections
- First push attempt was blocked by the repo's own secret gate because a deliberately bogus token literal in scripts/serverless-smoke.mjs matched assigned-secret; fixed with a placeholder and an autosquash rebase before publishing.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s356-git-push.txt
- scripts/serverless-smoke.mjs
- .gitignore
- Makefile
- .devin/graph/trace.md
- .devin/graph/current-state.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
