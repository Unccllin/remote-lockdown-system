# Session Capture — 2026-11-26 — sess-338

## Context
- Task: Fix the four cheapest findings from the external code review (S1 setup takeover, S4 dev-secret token forgery, S6 admin revocation, S7 timing-unsafe comparisons), deploy them, and file the remaining five as debt
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
- S1 fix shape: require the deployment ADMIN_TOKEN on create-first-admin via X-Setup-Token, compare with the existing timingSafeEqualStr, and return 503 (not fall open) when no token is configured. Setup is already complete on the live deployment so it stays a 409.
- S4's defect was the literal 'dev-secret' fallback, not the ADMIN_TOKEN fallback: make absence fatal (throw) and keep the unguessable fallback documented.
- S6 revocation must take the role from the stored admin record, and must EXEMPT the synthetic break-glass identity (id admin-token) because the login route issues it as a signed token with no row. A pre-existing test caught my first attempt 401ing break-glass.
- When verification cannot run (no secret configured), fail closed with 401 for callers and let the login route report 503 with the reason.
- A regression test must be run against the pre-fix code before it is trusted: my dev-secret forgery test passed while the fallback was present because the env also set JWT_SECRET, and two S6 tests assumed a flat POST /api/admins response was nested.

## Mistakes / Corrections
- mistake: my S6 check broke break-glass login (401) until a sentinel constant was shared; correction: when adding an existence check to a token path, enumerate the synthetic identities first
- mistake: two new tests were weak (wrong env; wrong response shape) and only the teeth step exposed it; correction: revert the fix and watch the test fail before calling it a regression test

## Open Questions
- <none recorded>

## File References
- serverless/admin-auth.ts
- serverless/worker.ts
- serverless/agent-routes.ts
- dashboard/src/pages/SetupPage.jsx
- dashboard/src/api/setup.js
- dashboard/tests/SetupPage.test.jsx
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- docs/artifacts/s364-review-fixes-s1-s4-s6-s7.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
