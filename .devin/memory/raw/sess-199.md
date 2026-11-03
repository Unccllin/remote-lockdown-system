# Session Capture — 2026-11-03 — sess-199

## Context
- Task: Session 199: audit the class S198 found (advertised-but-unserved paths) and settle the CI question about the opt-in workerd E2E with evidence.
- Environment: repo=remote-lockdown-system; files=serverless/worker.test.ts, serverless/worker.ts, .github/workflows/{ci,release}.yml
- Duration: <not specified>

## Decisions Made
- Keep make test-worker-e2e opt-in: CI already runs the unit regression that spans the S198 contract, so pinning wrangler (~100MB) buys runtime fidelity, not failure-mode coverage.
- Turn the accidental catch into a static contract test (source audit) rather than adding workerd to every PR.
- No production code change: the audit found 0 unrouted paths.

## Actions Taken
- Audited every /api literal outside comments against dispatch branches: 37 mentioned, 56 routed, 0 unrouted.
- Added 2 route-contract tests to worker.test.ts (all mentioned paths dispatched; the specific broken route named).
- Proved non-vacuity by renaming the route: 5 tests fail; restored and re-verified.
- Recorded belief B-054 and closed session 199.

## Outcomes
- What worked: - Letting a script do the audit (regex over source, comments skipped, templates excluded) answered the 'is this a pattern?' question in one run.
- Checking what CI actually runs settled the design question without opinion: ci.yml runs the serverless suite, so the class is gated.
- What failed: - None.
- What was unexpected: - Zero unrouted paths: the defect was a single instance, which means the E2E found the only one and the class guard is cheap.

## Learnings
- Before adding a heavy runtime dependency for CI fidelity, check whether an existing cheap test already spans the failure mode.
- A contract between two files (advertised URL vs route table) can be asserted statically over source, and that costs nothing in CI.
- An accidental discovery is not a control; convert it into a check.

## Mistakes / Corrections
- mistake: earlier framed the wrangler decision as risk-bearing ('the only way the path stays honest'); correction: CI already gated it, so the honest framing was fidelity vs cost, not coverage.

## Open Questions
- <none recorded>

## File References
- serverless/worker.test.ts
- serverless/worker.ts
- .github/workflows/ci.yml
- .github/workflows/release.yml
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
