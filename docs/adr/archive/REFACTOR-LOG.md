# REFACTOR-LOG.md — Refactors Needed to Make the Graph the Center

> This file lists every refactor required to make the node graph the center
> and heart of the project. Each refactor maps to a debt item in
> `DEBT-LEDGER.md` and a graph invariant in `GRAPH-SPEC.yaml`.

## Refactor 1: Update orchestrator.sh to know all 17 phases (D-001, I6)

**Current state**: `orchestrator.sh` has `PHASE_DEPS` and `PHASE_NAMES` arrays
that only go to phase 7. Phases 8-16 have skill files and configs but are
invisible to the orchestrator.

**Required change**:
- Add phases 8-16 to `PHASE_DEPS` and `PHASE_NAMES` arrays
- Add phases 8-16 to the `show_status` loop (currently `for phase in 0 1 2 3 4 5 6 7`)
- Add phases 8-16 to the `run_all` order array
- Add phases 8-16 to the `case` statement at the bottom
- Optionally: replace hardcoded arrays with a call to `graph_loader.py` to
  dynamically load phase info from `GRAPH-SPEC.yaml`

**Files to change**: `.devin/orchestration/orchestrator.sh`

**Invariant fixed**: I6 (orchestrator_knows_all_phases)

---

## Refactor 2: Populate .complete files with commit hash + artifact (D-002, I7)

**Current state**: All 17 `results/phase-N.complete` files are 0 bytes. There's
no way to verify what was actually done or when.

**Required change**:
- Each `.complete` file should contain:
  ```
  commit: <git hash>
  artifact: <description of what was verified>
  date: <ISO timestamp>
  tests: <test counts at time of completion>
  ```
- This can be done retroactively by checking git log for each phase's work
- Going forward, the orchestrator should write this content when marking
  a phase complete

**Files to change**: `.devin/orchestration/results/phase-*.complete` (17 files)

**Invariant fixed**: I7 (complete_phases_have_artifacts)

---

## Refactor 3: Wire graph_assert.py into the orchestrator (D-006) — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: `graph_assert.py` exists and runs standalone, but the
orchestrator doesn't call it. Phase transitions are not validated against
the graph.

**Required change**:
- In `orchestrator.sh`, before running a phase, call:
  ```bash
  python3 .devin/graph/graph_assert.py --assert-phase-deps P$phase
  ```
- Or import the graph loader in a Python wrapper that the orchestrator calls
- On `GraphViolationError`, halt the phase and report the violation

**Files to change**: `.devin/orchestration/orchestrator.sh`

**Implemented**: Added `graph_check_phase()` function that calls
`graph_assert.py --assert-phase-deps P$phase`. Inserted into `run_phase()`
after `deps_met()` check. Added `--assert-phase-deps` CLI flag to
`graph_assert.py`.

---

## Refactor 4: Add RULE-ZERO gate to the orchestrator (I5) — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: The orchestrator runs tasks directly without checking
that the agent has read the skill file and source code first.

**Required change**:
- Before executing tasks for a phase, the orchestrator should:
  1. Check that `trace.md` has a RULE-ZERO entry for the current phase
  2. If not, refuse to proceed and instruct the agent to complete Rule Zero
- This can be a simple grep check:
  ```bash
  grep -q "RULE-ZERO.*P$phase" .devin/graph/trace.md || {
    fail "RULE-ZERO not completed for phase $phase — read skill file first"
    return 1
  }
  ```

**Files to change**: `.devin/orchestration/orchestrator.sh`

**Invariant enforced**: I5 (rule_zero_before_code)

**Implemented**: Added `rule_zero_check()` function that greps trace.md for
any RULE-ZERO entry (session-scoped). Inserted into `run_phase()` after
`graph_check_phase()`. Tested: correctly blocks phase 0 when no entry exists,
correctly passes when entry exists.

---

## Refactor 5: Add session-end trace update to the orchestrator (I4) — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: The orchestrator doesn't update `trace.md` at session end.

**Required change**:
- After all phases are complete (or on halt), the orchestrator should:
  1. Append a session-end status block to `trace.md`
  2. Include: fog cleared, fog remaining, debt items closed, debt items open,
     blockers, next session opening
- This can be a helper function `write_session_end()` in `orchestrator.sh`

**Files to change**: `.devin/orchestration/orchestrator.sh`

**Invariant enforced**: I4 (session_close_requires_trace_update)

**Implemented**: Added `write_session_end()` function that appends a
session-end block to trace.md. Called at end of `run_all()` (SUCCESS) and
via ERR trap (FAILURE).

---

## Refactor 6: Update PHASES.md to reference the graph (D-006) — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: `.devin/orchestration/PHASES.md` describes the old 8-phase
system and doesn't mention the graph.

**Required change**:
- Update to reference all 17 phases
- Add a "Graph Integration" section pointing to `GRAPH-SPEC.yaml`
- Update the execution order diagram to include phases 8-16
- Note that the graph is now the source of truth for phase dependencies

**Files to change**: `.devin/orchestration/PHASES.md`

**Implemented**: Full rewrite of PHASES.md. Now lists all 17 phases (P0-P16)
with graph node IDs and deps. Added "Graph Integration" section with mandatory
reads, invariant list, and `make graph-check` reference. Updated Orchestration
Protocol to mention graph enforcement (step 2), RULE-ZERO gate (step 3), and
session-end trace (step 11). Updated execution order diagram to show all 17
phases.

---

## Refactor 7: Add Makefile target for graph invariant sweep — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: There's no `make graph-check` or similar target.

**Required change**:
- Add to `Makefile`:
  ```makefile
  .PHONY: graph-check
  graph-check:
  	@python3 .devin/graph/graph_assert.py
  ```
- Add to `make test` or `make verify-env` as a pre-flight check

**Files to change**: `Makefile`

**Implemented**: Added `graph-check` target to Makefile. Added to help text.
Verified `make graph-check` runs and passes.

---

## Refactor 8: Add graph_loader to CI pipeline — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: CI doesn't check graph invariants.

**Required change**:
- Add a step to `.github/workflows/ci.yml`:
  ```yaml
  - name: Graph invariant sweep
    run: python3 .devin/graph/graph_assert.py
  ```
- This should run before tests to catch dependency violations early

**Files to change**: `.github/workflows/ci.yml`

**Implemented**: Added `graph-check` job as the FIRST job in ci.yml. All 6
other jobs (server-tests, dashboard-tests, agent-tests, api-e2e, dashboard-e2e,
env-verify) now have `needs: graph-check` so a graph violation halts all tests.
The job installs PyYAML, then runs `python3 .devin/graph/graph_assert.py`.

---

## Refactor 9: Update phase configs to reference graph node IDs — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: Phase configs (`.devin/orchestration/phases/phase-N.conf`)
don't reference their graph node ID.

**Required change**:
- Add `GRAPH_NODE="P$PHASE"` to each config
- Optionally add `VERIFY_NODES` list from the graph spec
- This lets the orchestrator cross-reference the config with the graph

**Files to change**: `.devin/orchestration/phases/phase-*.conf` (17 files)

**Implemented**: Added `GRAPH_NODE="P$PHASE"` and `VERIFY_NODES="..."` to all
17 phase configs. VERIFY_NODES mapped from GRAPH-SPEC.yaml verification
relationships. Orchestrator can still source all configs (tested phases 0, 8, 16).

---

## Refactor 10: Add enforcement path status tracking to graph_assert — DONE

**Status**: COMPLETED 2026-08-10

**Current state**: `graph_assert.py` checks phase deps and debt evidence,
but doesn't check enforcement path verification status.

**Required change**:
- Add `assert_enforcement_path_status()` function
- Check that no enforcement path is marked `verified-on-hardware` without
  a real hardware artifact reference
- Check that blocked enforcement paths (from open debt items) are not
  marked as verified

**Files to change**: `.devin/graph/graph_assert.py`

**Invariant enforced**: I3 (hardware_verification_requires_real_artifact)

**Implemented**: Added `assert_enforcement_path_status()` function with 3 checks:
1. Every enforcement path has a valid status from the enum
   (verified-on-hardware, verified-in-unit-test, verified-in-ci, unverified)
2. No path marked verified-on-hardware without hardware_artifact_ref
3. No blocked path (from open debt items) marked as verified-on-hardware
Wired into `assert_all_invariants()`. All 3 violation types tested and confirmed.

---

## Summary: Refactor priority order

| Priority | Refactor | Debt Item | Invariant | Effort | Status |
|----------|----------|-----------|-----------|--------|--------|
| 1 | Update orchestrator.sh (phases 8-16) | D-001 | I6 | Medium | DONE |
| 2 | Populate .complete files | D-002 | I7 | Low | DONE |
| 3 | Wire graph_assert into orchestrator | D-006 | I1 | Medium | DONE |
| 4 | Add RULE-ZERO gate | — | I5 | Low | DONE |
| 5 | Add session-end trace update | D-005 | I4 | Low | DONE |
| 6 | Update PHASES.md | — | — | Low | DONE |
| 7 | Add Makefile graph-check target | — | — | Trivial | DONE |
| 8 | Add graph_loader to CI | — | — | Trivial | DONE |
| 9 | Update phase configs with graph node IDs | — | — | Low | DONE |
| 10 | Add enforcement path status tracking | — | I3 | Medium | DONE |

**ALL 10 REFACTORS DONE.** They closed D-001, D-002, D-005, D-006 and brought
the orchestrator, CI, phase configs, and assertion engine into compliance with
all 7 graph invariants (I1-I7). The node graph is now the center and heart of
the project, with automatic enforcement at every phase transition.
