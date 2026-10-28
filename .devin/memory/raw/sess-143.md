# Session Capture — 2026-10-27 — sess-143

## Context
- Task: I3 evidence integrity (graph reads the artifact it cites) + arm the secret scanner in CI and as a git hook
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
- I3 only required a non-empty hardware_artifact_ref string; reading the file revealed E-BCD was verified-on-hardware while citing E-BCD-01 FAIL (two independent hardware runs agree)
- three artifact schemas exist and all must be parsed: harness v1.0 legacy results[], CTRF results.tests[], live-agent enforcement_paths{} (agent/hw_test_artifact_live_hp.json — real HP run 2026-08-21)
- a demoted path may still cite its failed attempt as evidence-of-attempt; only verified-on-hardware is held to the PASS rule
- scripts/pre-push-check.sh was tracked 100644 so its own documented usage failed; the hook was never installed and no CI job ran the scanner — a gate that exists as a script is not a gate
- check staleness before proposing audit items: E2E wiring and the server/dashboard effectiveness loop were already complete

## Mistakes / Corrections
- mistake: repeated a stale audit claim that E2E was orphaned and that the effectiveness loop needed closing; both were already done. Verify before recommending
- mistake: session blocks grew to 268 lines, pushing current-state.md over the 300-line compactness cap (I4 violation). Condensed to 146; keep blocks summary-sized, detail belongs in the doc being written

## Open Questions
- <none recorded>

## File References
- .devin/graph/graph_assert.py
- .devin/graph/GRAPH-SPEC.yaml
- agent/tests/test_graph_assertions.py
- .github/workflows/lint.yml
- scripts/pre-push-check.sh
- docs/D-129-HARDWARE-RUNBOOK.md
- agent/hw_test_harness.py
- agent/agent.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
