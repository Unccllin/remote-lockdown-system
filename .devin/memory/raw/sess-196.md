# Session Capture — 2026-11-03 — sess-196

## Context
- Task: Session 196: verify the two harness-bug claims I reported in S195, and correct the record if they were wrong.
- Environment: repo=remote-lockdown-system; files=.devin/graph/trace.md, .devin/brain/, tests/e2e/agent-helpers.js, server/src/routes/devices.js, server/src/db/migrations/001_base.sql, agent/agent.py
- Duration: <not specified>

## Decisions Made
- Correct S195's block in place with a visible CORRECTION marker rather than silently rewriting history.
- Refute B-050 and assert B-051 (corrected attribution + measurements) instead of editing the belief text.
- Keep the mechanisms (they are real) and drop the misattribution.

## Actions Taken
- Read agent-helpers.js: startAgent already used async spawn and already deleted AGENT_SHARED_KEY.
- Measured both mechanisms: spawnSync -> ReadTimeout 6.0s vs async 200 in 0.01s; agent_key -> SHARED-KEY-FROM-ENV over DEVICE-KEY-FROM-FILE.
- Verified last_checkin is null at enrollment (schema + probe: null -> '2026-11-03 10:24:49').
- Amended trace.md S195, refuted B-050 -> B-051, regenerated BELIEFS.md, closed session 196.

## Outcomes
- What worked: - Testing the discriminating question by execution instead of re-reading my own summary settled it in one probe.
- The graph/brain layering made the propagation visible: a wrong claim in trace + brain would have been inherited as fact.
- What failed: - None this session.
- What was unexpected: - The pre-existing harness was already correct on both counts; the failures were the new suite bypassing rules the harness encoded. My summary had inverted cause and blame.

## Learnings
- When a session blames existing code, re-read that code before writing the block: the repo has been wrong in both directions (stale debt claims, and inflated defect claims).
- Corollary of the 12ms/15s lesson: measure the mechanism, then decide whose bug it is — the measurement says 'property of in-process servers', not 'harness defect'.

## Mistakes / Corrections
- mistake: reported two pre-existing harness defects from a debugging narrative without checking the harness source; correction: refuted B-050, corrected S195 in place, and re-stated the mechanisms with measurements.

## Open Questions
- <none recorded>

## File References
- .devin/graph/trace.md
- .devin/brain/beliefs.yaml
- .devin/brain/BELIEFS.md
- tests/e2e/agent-helpers.js
- server/src/routes/devices.js
- server/src/db/migrations/001_base.sql
- agent/agent.py

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
