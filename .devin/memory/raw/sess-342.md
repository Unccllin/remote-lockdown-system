# Session Capture — 2026-11-26 — sess-342

## Context
- Task: D-227: stop re-enrolment silently clearing a device's stolen flag, on both backends, with an audit record and an out-of-band notification
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
- Reassociation by hardware_uuid wrote status='active' with no audit entry, so reinstalling the agent erased a theft flag and a thief's reinstall looked identical to a technician's rebuild. Fix: one helper both enrolment paths call (the two blocks were byte-identical twins) that preserves status, audits previous_status+via+ip, and notifies when the previous status was not active.
- Reinstalling software must not undo a state an administrator set; recovery stays an explicit action, which is what gives the audit trail meaning.
- CHECK PARITY BEFORE CLOSING: the same status='active' existed in Express server/src/routes/enroll.js. This check exists because D-226 stayed open a session for exactly this reason.
- An ast-grep finding on the unguarded URL parse in composeSetupScript is a FALSE POSITIVE: the route validates PUBLIC_SERVER_URL first and a test pins the 500. Three nosemgrep forms are not honoured for that rule; record the reason at the call site and do not change behaviour to silence a heuristic.
- When a checker flags code you did not write, look for a test that pins the current behaviour first: the existing 'malformed PUBLIC_SERVER_URL is explained, not thrown' test caught my wrong 'fix' immediately.

## Mistakes / Corrections
- mistake: 'fixed' an ast-grep finding by adding a try/catch, which turned an operator-facing 500 into a 200 with a degraded script; the existing test caught it and I reverted; correction: a checker finding in untouched code is a claim, and the test that pins the contract is the evidence
- mistake: appended the RULE-ZERO/IMPLEMENT half of the S368 trace block without the state sections, so I2 had nothing to compare for that block; correction: write the whole block (RULE-ZERO through Next opening) in one pass

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts
- server/src/routes/enroll.js
- server/tests/enroll.routes.test.js
- docs/artifacts/s368-d227-reassociation.txt
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
