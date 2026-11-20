# Session Capture — 2026-11-18 — sess-291

## Context
- Task: S288: deploy the Worker (which needed wrangler login) and investigate the E-LOCK-SCREEN evidence bar
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
- Device-flow login works headless: npx wrangler login --device prints a URL + code for the operator to approve; wrangler 4.162.0 has no deploy --temporary, so publishing always needs auth.
- scripts/verify-worker.sh proves bundle + serve with local workerd and NO account, so 'needs wrangler login' only ever blocked publishing, not verification.
- Deployed lockdown-serverless version 6a113a90-7707-4b32-a7f0-852e205ee812; live HTTPS smoke green on setup/status, devices 401, health, /v1/health, /v1/verdict 400, /v1/policy/1 200, unknown 404.
- The binaries in KV are stale: /api/download/agent serves 16,370,993 bytes sha256 39a29b35..., PE TimeDateStamp 2026-11-12T15:16:16Z - predating the S271/S284/S287 fixes. Publishing binary:agent + companions + signed agent_release is a release decision.
- E-LOCK-SCREEN evidence bar: Windows checks the password before reporting account state. Measured on MOLE with a temp account: active+correct=SUCCESS, disabled+correct=1331 (account disabled), wrong password=1326 in every state. So a LogonUser answering 1331 proves both the credential and the refusal.

## Mistakes / Corrections
- mistake: nearly treated 'needs wrangler login' as 'cannot be verified'; correction: read verify-worker.sh's header - bundle+serve need no account.
- mistake: a temp account via 'net user <name> <password> /add' fails for passwords longer than 14 chars (it prompts Y/N and exits -1); correction: use New-LocalUser from the LocalAccounts module.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s288-worker-deployed.txt
- serverless/wrangler.toml
- scripts/verify-worker.sh
- serverless/README.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
