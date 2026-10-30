# Session Capture — 2026-10-30 — sess-162

## Context
- Task: Make invariant I2 verify that cited evidence exists, not merely that it is non-empty
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
- I2 only checked non-empty strings. Measuring first showed 43 citations of 14 unique hashes across the then-54 CLOSED items no longer resolve, because session 149's git filter-repo history rewrite orphaned every pre-rewrite hash. The project's own trace recorded 'all SHAs are post-rewrite' but the graph kept citing the old ones.
- Fix shape: verify commit tokens with git rev-parse --verify <hash>^{commit}, verify plain repo paths in artifact_ref exist, skip globs and brace-expanded families, and record pre-existing orphans in a shrink-only baseline so the rule bites on new evidence only.
- Token extraction must exclude hex literals and filenames: use lowercase-hex-only, 7-40 chars, with word boundaries, so 0x420D000D and d131-wire-capture.py are not treated as commits.
- Teeth demonstrated end to end by injecting a fabricated CLOSED item into the spec: make graph-check failed with a precise I2 violation, and restoring returned green.

## Mistakes / Corrections
- The existing I2 tests encoded the weak contract (commit 'abc1234', artifact 'docs/x.md' — neither exists), so strengthening the rule required rewriting them rather than adding cases.
- Implement first would have failed the whole graph across 54 items and tempted me to weaken the rule; measuring the blast radius first turned it into a ratchet.

## Open Questions
- <none recorded>

## File References
- .devin/graph/graph_assert.py
- .devin/graph/orphaned-commit-refs.txt
- agent/tests/test_graph_assertions.py
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
