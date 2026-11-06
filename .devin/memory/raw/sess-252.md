# Session Capture — 2026-11-06 — sess-252

## Context
- Task: File the uninstall-token scheme weakness as D-221 debt and open a 4-question ruling instead of fixing it; repair stale generated ledger text
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
- New non-firmware debt goes into PBL-DEBT-LEDGER.md despite the name: D-211 (covert tracking) is the precedent and the 2xx id series is global and never reused
- D-212 was already taken by the 2026-09-15 RE-hardening review, so the next free id was D-221 — always grep max id before assigning one
- GRAPH-SPEC.yaml mirrors only part of each ledger (D-001..D-012 of 21 legacy, D-100..D-211 of the live one), so its item count is never the complete debt set
- graph_session.py printed literal 'D-100..D-130, 31 OPEN' into every regenerated current-state.md for many sessions; derived counts from the graph are the fix
- D-134 was OPEN in its detail section and in the graph but had no row in the ledger's authoritative summary table
- The uninstall token has 4 defects: no device binding, Express HMAC vs Worker SHA256 divergence, ADMIN_TOKEN||'fallback' public constant, non-constant-time compare

## Mistakes / Corrections
- mistake: headed the session block 'D-212 filed' before checking that D-212 was already used — caught by grepping the id set, fixed in both the heading and the body
- mistake: first version of the ruling used a - [ ] checkbox per OPTION, so check-ruling.sh reported 12 open items instead of 4; existing rulings use one checkbox per QUESTION with options as plain bullets

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- .devin/PENDING-RULING.md
- scripts/graph_session.py
- .devin/graph/current-state.md
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
