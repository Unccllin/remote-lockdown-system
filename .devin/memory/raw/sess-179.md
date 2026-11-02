# Session Capture — 2026-11-02 — sess-179

## Context
- Task: Mutation-audit the check-in delivery filters: can a device be handed another device's command, or be re-delivered an executed one?
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
- WRK/checkin-device-filter SURVIVED despite my prediction that it was covered: dropping 'c.device_id === device.id' from the check-in delivery filter left the suite green. Nothing asserted that a device receives only its own commands - with it gone, one machine's check-in can return another machine's pending lockdown.
- WRK/checkin-pending-filter KILLED, incidentally by the session-177 test 'a normal recovery is not marked as duress' (it acks the lockdown, recovers, then expects the unlock on the next check-in).
- Fix: a test where a bystander checks in and must get command: null while the victim still receives its lockdown (positive control on both sides). Mutation now KILLED by that test.
- worker.ts has TWO occurrences of the device+pending filter shape: 875 (check-in delivery, now tested) and 701 (a different handler, still unmutated). A bare one-line anchor is ambiguous there; use a 3-line anchor.
- CORS: the Worker is a bearer-token API with no cookie sessions, so Access-Control-Allow-Origin '*' does not expose credentials. Rather than leave seven bare '*' assertions (and a linter warning), the decision is now a named TOKEN_API_CORS_ORIGIN constant with the reasoning above it.

## Mistakes / Corrections
- mistake: I predicted WRK/checkin-device-filter would be killed and it survived; my mental model of the suite was wrong, which is exactly why the mutation gets run rather than reasoned about.

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
