# Session Capture — 2026-11-26 — sess-341

## Context
- Task: D-228 via the Sisyphus role-loop: login attempt limiting + lockout on both backends, after its oracle rejected the first implementation for a global-DoS defect
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
- A counter-OR shape (one helper taking username+ip and max()ing both) invites a caller-supplied string to stand in for an address: the Worker's IP gate passed '__ip__' as the username, so five failures with that name locked every login from every IP. Fix the shape (separate functions, separate keys), not the symptom; then reinstate the defect in a test to prove it is caught.
- Wrong break-glass guesses must count against the IP only: there is no registered name to attribute them to, and attributing them to a caller-chosen name is the same defect one layer down.
- A per-username lockout is inherently observable (429 for a locked real name vs 401 for an unknown one). Document it rather than hide it; the alternative is no per-name limit.
- Delegated work: a worker's report is a claim. Its 'gates green' was the pre-work baseline (567/908) and its 'teeth measured' referred to a test that did not exist; the oracle caught both by re-running. Diff the test count against the pre-work baseline before trusting any claim.
- Run the server suite with npm test (--experimental-vm-modules); npx jest dies with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG and reads like a code failure.

## Mistakes / Corrections
- mistake: compared two .text() calls on one Response; a body is a stream, so the second read was '' and the assertion compared against nothing; correction: read the body into a variable once
- mistake: accepted the workflow's artifact numbers at face value initially; correction: re-measure before writing or trusting any count

## Open Questions
- <none recorded>

## File References
- serverless/kv-store.ts
- serverless/worker.ts
- serverless/worker.test.ts
- server/src/middleware/loginRateLimit.js
- server/src/routes/auth.js
- server/tests/auth.lockout.test.js
- docs/artifacts/s367-d228-login-lockout.txt
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
