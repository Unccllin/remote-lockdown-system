# Session Capture — 2026-11-04 — sess-207

## Context
- Task: Session 207: automate the cross-surface audit that four consecutive sessions kept needing (UI vs server vs Worker), and fix the flaky TLS-floor test found while running the suite.
- Environment: repo=remote-lockdown-system; files=scripts/test_cross_surface_contract.py (new), scripts/test_tls_floor.py; sources compared=dashboard/src, server/src/index.js + routes, serverless/worker.ts
- Duration: <not specified>

## Decisions Made
- Compare all three surfaces in one source-level test rather than adding checks to each surface's own suite.
- Split Worker-only routes into WORKER_ONLY_BY_DESIGN vs KNOWN_GAPS, and make the gap list shrink-only so fixing one fails loudly.
- Assert parser anchors first: a silent parse failure would make the audit vacuous (it nearly did, twice).
- For the TLS test, assert what this sandbox can prove (refusal is real; handshake completion is not) instead of encoding a sandbox-dependent success.

## Actions Taken
- Wrote scripts/test_cross_surface_contract.py (UI->server with receiver-based bases; Worker->Express with allowlists; anchors; shrink-only baseline).
- Falsified both directions (nonexistent UI route; a 'gap' Express serves).
- Diagnosed test_tls_floor flakiness: three refusal shapes (alert 70, errno=104, unexpected eof) plus a startup race; fixed readiness to wait for handshaking and accept all three shapes; 8/8 green.
- Recorded the two new parity gaps the audit found: POST /api/rearm and POST /api/agent/efs-cert.

## Outcomes
- What worked: - The audit found a third class of defect the day it was written, which is the strongest evidence it was worth building.
- Recording what the sandbox cannot prove (Caddy tls internal cannot issue a cert here) turned a wrong assertion into an honest one.
- What failed: - My first two parsers were wrong (double-slash composition reported 41 false misses; a filename-based base rule produced 7 false positives) - both caught only by anchoring and falsifying.
- What was unexpected: - Express lacks POST /api/rearm and POST /api/agent/efs-cert entirely; the Worker has both.
- Caddy's internal issuer fails for every TLS version in this sandbox, so 'handshake completes' was never a valid assertion here.

## Learnings
- Cross-surface contracts need a test that reads both sides; per-surface suites cannot see them.
- Always anchor a source parser to known-good facts before trusting its output.
- An allowlist of known gaps should be shrink-only, so closing a gap forces the list to be updated.
- If a test's success condition depends on a sandbox capability, assert the capability-independent part and say why.

## Mistakes / Corrections
- mistake: shipped two broken parsers into a test before validating them; correction: anchors + falsification, now the first two assertions in the file.

## Open Questions
- <none recorded>

## File References
- scripts/test_cross_surface_contract.py
- scripts/test_tls_floor.py
- serverless/worker.ts
- server/src/routes/enroll.js
- dashboard/src/api/pblClient.js
- .devin/brain/beliefs.yaml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
