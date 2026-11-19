# Session Capture — 2026-11-19 — sess-310

## Context
- Task: Finish the ADR-010 rotation on real hardware: build 1.0.4 on MOLE, install, verify rotation and restart survival
- Environment: MOLE (192.168.1.249, labadmin over ssh -i ~/.ssh/lockdown_lab_ed25519), deployed Worker lockdown-serverless, wrangler authenticated
- Duration: <not specified>

## Decisions Made
- build the Windows agent ON MOLE with build.ps1 (source-hash identity, no git needed) instead of pushing 20 commits for CI
- redeploy the Worker: a secret change is a VERSION, not a code deploy, so the settings field was missing entirely
- restore the real key via wrangler rollback to the version that held it rather than asking for the secret
- prove restart survival by mtime invariance instead of inference

## Actions Taken
- tarred agent source, scp'd to MOLE, ran build.ps1 -AgentOnly -Install
- killed the IGNORES_SHUTDOWN process, replaced the exe, started the service, verified 1.0.4
- read .runtime_settings as key_len + revision only (never the key)
- rotated the secret, measured, rolled back, measured again, then restarted the service and measured

## Outcomes
- What worked: - the mtime invariant is a clean observable: a service that cannot read the file must rewrite it
- rollback restored the real secret exactly, revision returned to the identical digest
- What failed: - first binary swap failed because Stop-Service leaves the process alive (IGNORES_SHUTDOWN)
- What was unexpected: - the deployed Worker predated the rotation code; MOLE received no settings for a day and ignored the field correctly
- ssh route was documented in docs/artifacts/s281 and memory m-1341 while I had claimed there was no access

## Learnings
- check known_hosts/memory for access before declaring 'no access' — an ssh config alias is not the only route
- wrangler secret put deploys a Source: Secret Change version; it does NOT deploy code
- version rollback restores the secret that version held, which makes secret rotation reversible without the plaintext

## Mistakes / Corrections
- mistake: concluded 'no SSH to MOLE' from an empty ssh config; correction: labadmin@192.168.1.249 with the lab key, recorded in s281 and m-1341

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s311-rotation-hardware.txt
- docs/adr/ADR-010-geolocation-key-rotation.md
- agent/agent.py (1.0.4)
- serverless/agent-routes.ts (deployed as 0ad0ff6a)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
