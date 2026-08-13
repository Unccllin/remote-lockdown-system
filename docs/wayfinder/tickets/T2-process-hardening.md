# T2: Clean-state checklist + failure attribution + Goodhart defense

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-13)
> **Blocks:** none
> **Blocked by:** Q1 (Goodhart design decisions), T1 (clean trace state)
> **Implements:** H2 (clean-state checklist), H3 (Goodhart defense), H5 (failure attribution convention)

## Question

Implement three process-hardening improvements: a clean-state checklist for
session end, structural minimums for gameable invariants (per Q1 resolution),
and a failure-to-layer attribution convention.

## Work

### Clean-state checklist (H2)

The WalkingLabs course (Lecture 12) defines 5 conditions for clean state at
session end:
1. Build passes
2. Tests pass (including pre-existing tests)
3. Progress recorded in machine-readable artifacts
4. No temporary artifacts (debug logs, TODO markers, commented-out code)
5. Startup path remains functional

1. Create `.devin/graph/clean-state-checklist.md` with the 5 conditions as
   verifiable checks:
   - Build: `cd dashboard && npx vite build` succeeds
   - Tests: `npm test` (server + agent) passes
   - Progress: `current-state.md` updated with session-end block
   - No temp artifacts: `git status` shows no untracked debug/temp files
   - Startup: `make verify-env` passes (or a subset check)
2. Add a `clean-state-check` function to `orchestrator.sh` that runs these
   checks and reports pass/fail per condition
3. Add `make clean-state` target to Makefile that runs the checklist
4. Update `AGENTS.md` session-end section to reference the checklist

### Goodhart's Law defense (H3, per Q1 resolution)

Implement the structural minimums decided in Q1:

1. **I5 strengthening** in `graph_assert.py`:
   - RULE-ZERO entry must cite >=2 file paths (lines containing `/` or `\`)
   - RULE-ZERO entry must include >=1 "Finding" or "Read" line
   - Add `assert_rule_zero_quality()` function
2. **I4 strengthening** in `graph_assert.py`:
   - Each required section in session-end block must have >=1 line of
     non-header content (content under the header, not just the header itself)
   - Add `assert_session_end_quality()` function
3. **I7 strengthening** in `graph_assert.py`:
   - `.complete` file must contain a commit hash pattern (7+ hex chars)
   - `.complete` file must contain a test count (digits + "test" or "pass")
   - Add `assert_artifact_quality()` function
4. Wire all 3 new assertions into `assert_all_invariants()`
5. Add tests for each new assertion (pass case + fail case)

### Failure-to-layer attribution convention (H5)

1. Add a section to `AGENTS.md` under "Conventions" describing the 5 failure
   layers from the course (task specification, context provision, execution
   environment, verification feedback, state management)
2. Convention: when a failure occurs during a session, the session-end trace
   block must include a "Failure attribution" subsection naming the layer
   and what harness change would prevent it
3. This is a convention (guidance), not an enforced invariant — no
   graph_assert.py change. The convention prepares for future failures
   without backfilling a failure log with no data.

## Files to edit

- `.devin/graph/clean-state-checklist.md` (new)
- `.devin/graph/graph_assert.py` (3 new assertion functions + wiring + tests)
- `.devin/orchestration/orchestrator.sh` (clean-state-check function)
- `Makefile` (clean-state target)
- `AGENTS.md` (clean-state checklist reference + failure attribution convention)
- `agent/tests/test_graph_assertions.py` or equivalent (new tests for
  I4/I5/I7 quality checks)

## Acceptance

- `clean-state-checklist.md` exists with 5 verifiable conditions
- `make clean-state` runs and reports pass/fail per condition
- `graph_assert.py` has `assert_rule_zero_quality()`,
  `assert_session_end_quality()`, `assert_artifact_quality()`
- All 3 new assertions have pass + fail tests
- `make graph-check` passes with the strengthened invariants
- All existing tests pass (no regressions from strengthened checks)
- `AGENTS.md` has failure attribution convention documented

### Demonstration (red-green)

**I5**: Create a trace.md entry with "RULE-ZERO" but no file paths — show
`graph_assert.py` catches it as an I5 violation. Then add 2 file paths + 1
Finding line — show it passes.

**I4**: Create a session-end block with all section headers but empty content
under one section — show `graph_assert.py` catches it as an I4 violation.
Then add content — show it passes.

**I7**: Create a `.complete` file with "tests pass" but no commit hash or
test count — show `graph_assert.py` catches it as an I7 violation. Then add
commit hash + test count — show it passes.

**Clean-state**: Run `make clean-state` after a session that leaves a debug
file — show it reports "No temp artifacts: FAIL". Remove the file — show
all 5 conditions pass.
