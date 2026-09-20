# Session Capture — 2026-09-20 — sess-131

## Context
- Task: Brain hygiene: backfill S1.x/NG-T5 beliefs, commit-aware staleness, refute stale B-012
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
- brain.py stale was mtime-day-based → false positives on unrelated same-day edits AND missed real staleness; commit_ref-aware check (git log ref..HEAD -- file) is strictly more precise
- The improved check caught B-012 as actually-refuted (Mor.c now uses correct MOR GUID) — a fixed bug still marked confirmed
- Beliefs not auto-asserted during work are lost to the queryable layer; assert during session, not just capture to memory
- B-003/B-008/B-028/B-027/B-032/B-036 re-confirmed intact after S1.x edits

## Mistakes / Corrections
- Under-used the brain during S1.x/NG-T5: produced assertable findings (osdevice layout, SignatureType trap, slirp topology, resume discriminator) but only captured to memory, not beliefs

## Open Questions
- <none recorded>

## File References
- scripts/brain.py
- .devin/brain/beliefs.yaml
- .devin/brain/BELIEFS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
