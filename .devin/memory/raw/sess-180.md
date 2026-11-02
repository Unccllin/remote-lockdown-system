# Session Capture — 2026-11-02 — sess-180

## Context
- Task: Mutation-audit the uninstall-authorisation pair and the ping command-delivery path
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
- All three mutations SURVIVED on the first run (predicted): grep -c uninstall in worker.test.ts was 0, and grep '/api/ping' was also 0. Neither uninstall-auth endpoint nor the ping route had ever been executed by a test.
- Consequences: any caller could obtain an uninstall token (issuer authorized=true); any token verified (if (true)); and the ping path - a SECOND command-delivery route one function away from the check-in filter fixed in session 179 - would hand a device another device's pending lockdown.
- Coverage corroborated it: adding those tests moved worker.ts from 84.09 to 89.0 stmts and 78.12 to 82.8 branches, i.e. the handlers were unexecuted, not merely unasserted.
- Six tests added: uninstall-auth (no creds 401, unknown key 401, enrolled device 200 + token + expires_in 300), uninstall-auth/verify (issued token authorized:true, wrong token authorized:false), ping (bystander gets no command, flagged victim gets the lockdown).
- worker.ts contains the uninstall authorization block twice verbatim (issuer 747, verifier 782), so that mutation must anchor on the function signature; the ping pending-command lookup is a separate .find() from the check-in .filter() at 875.

## Mistakes / Corrections
- mistake: my first insertion asserted a blank line before the file's final '});' that does not exist, and the second assumed split(chr(10))[-1] was the close rather than the trailing newline. Both caught by the assertions before any write.

## Open Questions
- <none recorded>

## File References
- serverless/worker.test.ts
- scripts/audit_test_teeth.py
- serverless/worker.ts

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
