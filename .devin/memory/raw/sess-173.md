# Session Capture — 2026-11-02 — sess-173

## Context
- Task: Extend the mutation audit to the server (jest): forged token, ignored role hierarchy, bypassed HMAC
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
- Jest must be invoked exactly as server/package.json does: node --experimental-vm-modules node_modules/jest/bin/jest.js. Without the flag the suite dies mid-run (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG from pglite) with exit 1, indistinguishable from a test failure.
- 'The run was red' is not the question. Correct mutation scoring needs (a) a GREEN baseline per runner, (b) the set of failing tests, (c) a verdict only for failures NEW relative to the baseline. A flaky test otherwise makes every mutation look caught.
- Server baseline is green: 43 suites, 716 tests. With that established, SVC/requireAuth, SVC/requireRole and SVC/hmacAuth all KILLED, with the right catchers named (hmacAuth mutation caught by 'hmacAuth middleware › invalid signature is rejected'; the two auth mutations caught by 'D-205: Admin key rotation endpoint › rejects operator role with 403' because a forged super-admin turns an expected 403 into a 200).
- Across sessions 171-173 four of my harnesses could not tell 'the test failed' from 'the test did not run properly': unresolved paths, -x summary parsing, crash-vs-failure, flake-vs-caught. All four were caught by reading output rather than trusting a verdict.

## Mistakes / Corrections
- mistake: copied the jest invocation from memory/Makefile instead of server/package.json, missing --experimental-vm-modules and producing a crashed suite that read as three security kills.
- mistake: attributed a kill to the first failing test in jest output without a baseline, so an unrelated (and intermittent) admins failure was reported as the catcher.
- mistake: would have shipped a component audit whose verdicts were flake-driven; the baseline step is what exposed it.

## Open Questions
- <none recorded>

## File References
- scripts/audit_test_teeth.py
- server/src/middleware/auth.js
- server/src/middleware/hmacAuth.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
