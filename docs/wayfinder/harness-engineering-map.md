# Wayfinder Map: Harness Engineering Hardening

> **Label:** `wayfinder:map`
> **Tracker:** local-markdown (`docs/wayfinder/`)
> **Created:** 2026-08-13
> **Status:** Active

## Destination

Harden the agent harness based on findings from the WalkingLabs "Learn Harness
Engineering" course (lectures 01-14) and a grilling session that stress-tested
every recommendation against this repo's actual state. The end state: trace.md
is restructured for fast session startup, gameable graph invariants (I4, I5, I7)
have structural minimums that prevent shallow compliance, error messages across
all 4 components include fix instructions (not just descriptions), and completed
artifacts are archived so the wayfinder system reflects only active work.

## Origin

This map was produced by a grilling session that:

1. Studied lecture 01 in full and lectures 02-14 via a research subagent
2. Audited error message quality across the entire codebase (147 errors analyzed)
3. Assessed every harness component for usage and enforcement status
4. Grilled 10 initial recommendations down to 6 honest survivors

7 of 10 initial recommendations were **rejected** after grilling:
- WIP=1 enforcement (no evidence of overreach — multi-ticket sessions succeeded)
- Generator/evaluator separation (external test tools already provide this)
- feature_list.json (wayfinder tickets already have the triple structure)
- Sprint contracts (session objective + ticket acceptance + AGENTS.md = sprint contract)
- AGENTS.md length concern (206 lines — below the 300-600+ danger zone)
- init.sh (Makefile + scripts/ already serve this role)
- Task-level trace files (trace.md already has per-task sections)

## Notes

- **Domain:** The harness itself is the project. No new product features.
- **Skills every session should consult:** `.devin/skills/phase-3-hardening/SKILL.md`
  (code hardening conventions), the node graph (`GRAPH-SPEC.yaml`), `DEBT-LEDGER.md`.
- **Execution override:** This effort carries **execution into the map** —
  tickets are resolved by implementing code, not just making decisions.
- **Session lifecycle:** Each implementation ticket follows
  `SESSION-START -> RULE-ZERO -> IMPLEMENT -> VERIFY -> ARTIFACT -> CLOSE-DEBT`.
- **Session batching:** 3 sessions, themed:
  - Session 1 (T1): Cleanup + state restructure
  - Session 2 (Q1 then T2): Process hardening
  - Session 3 (T3): Error messages
- **Demonstration requirement:** Every T-ticket acceptance includes a
  "demonstration" step — construct a scenario the old harness would miss and
  show the new harness catches it. This is the repo's "run artifacts as proof"
  philosophy applied to harness work.

## Decisions so far

<!-- Decisions from the grilling session, all accepted by the user -->

- **Q1: Goodhart's Law defense** — Strengthen gameable invariants I4, I5, I7
  with structural minimums. See `tickets/Q1-goodhart-law-defense.md`.

## Not yet specified

<!-- Fog: decisions we can tell are coming but can't yet pin down -->

- **Error message style guide**: Should we create a formal style guide document
  for error messages, or is the pattern established by T3's fixes sufficient?
  Graduates after T3 is implemented.
- **Orchestrator simplification**: The inline NEW-G3 assessment found that
  orchestrator.sh's `run_phase`/`run_all` functions are never called by CI
  (CI uses graph_assert.py directly). Should the orchestrator be simplified
  to remove dead code, or kept as a manual tool? Graduates after T1 archival
  reveals what's still referenced.

## Out of scope

<!-- Work ruled beyond the destination -->

- **WIP=1 enforcement**: No evidence of overreach in this repo. Multi-ticket
  sessions (T7-T10, T1-T6) all succeeded with all tasks passing. Rejected.
- **Generator/evaluator agent separation**: External test tools (Jest, pytest,
  vitest, graph_assert.py) already provide real separation. A separate
  evaluator agent would double cost for no proven benefit. Rejected.
- **feature_list.json migration**: Wayfinder tickets already encode the
  (behavior, verification, state) triple in markdown. Converting to JSON
  would enable machine scheduling but the orchestrator works in bash.
  Rejected.
- **Sprint contract formalization**: Session objective + ticket acceptance +
  AGENTS.md conventions + wayfinder "Out of scope" section = sprint contract
  under different names. Rejected.
- **init.sh**: `make verify-env` + Makefile + scripts/ already serve this role.
  Rejected.
- **Task-level trace files**: trace.md already has per-task sections within
  sessions. Separate files would create proliferation. Rejected.
- **AGENTS.md split**: 206 lines is below the course's 300-600+ danger zone.
  Rejected.
- **I8 (anti-copy-paste invariant)**: A new invariant preventing identical
  session-end blocks would be hard to enforce meaningfully — similar sessions
  can legitimately have similar blocks. Rejected.
