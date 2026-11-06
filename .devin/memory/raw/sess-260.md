# Session Capture — 2026-11-06 — sess-260

## Context
- Task: Second hardware window on FRANKENSTEIN: E-DECRYPT, E-ACK, E-RECOVERY, E-DEADMAN moved to verified-on-hardware (7/13 -> 11/13)
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
- All four remaining stub-based tags passed on the first Windows run because the WSL pre-flight had already exercised them; pre-flighting turns the hardware run into a confirmation rather than a discovery
- E-DEADMAN reads dangerous ('auto-lockdown if no offline for 24h') but is non-destructive: state is patched to a temp root and the assertions are about firing conditions (60s skew no; 25h offline yes; backward clock jump yes; corrupt file yes)
- The two remaining paths E-BCD and E-HP-UEFI are a different class: they change boot/firmware state a failed run cannot undo, so they need a named sacrificial machine and a recovery plan, not another tag list
- defender_exclusion was null in both windows — two observations make it evidence rather than an anecdote

## Mistakes / Corrections
- mistake: hand-wrapped four GRAPH-SPEC paragraphs and got the column count wrong on 10 of 16 lines, so my own validation rejected the write three times; the width budget has to be computed, not eyeballed
- mistake: my validation exempted the two pre-existing long lines by line number, which shifts on every edit; it now exempts them by content
- note: the artifact was renamed from the transferred name (…_d259.json -> …_win2.json) with sha256 verified identical, so provenance is intact

## Open Questions
- <none recorded>

## File References
- agent/hw_test_artifact_frankenstein_win2.json
- .devin/graph/GRAPH-SPEC.yaml
- AGENTS.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
