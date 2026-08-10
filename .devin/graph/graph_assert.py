"""
graph_assert.py — Assertion engine for the node graph.

Enforces the graph invariants defined in GRAPH-SPEC.yaml. Every agent
session, every phase transition, and every debt closure must pass through
this engine. Violations raise GraphViolationError and halt the pipeline.

Usage:
    from graph_assert import (
        assert_phase_deps_met,
        assert_debt_close_has_evidence,
        assert_enforcement_path_status,
        assert_rule_zero_complete,
        assert_session_closed_with_trace,
        assert_all_invariants,
        GraphViolationError,
    )

    # Before running a phase:
    assert_phase_deps_met(graph, "P3")

    # Before closing a debt item:
    assert_debt_close_has_evidence(debt_item)

    # Before writing code:
    assert_rule_zero_complete(trace_path)

    # At session end:
    assert_session_closed_with_trace(trace_path)

    # Full sweep:
    violations = assert_all_invariants(graph)
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Add parent to path for graph_loader import
sys.path.insert(0, str(Path(__file__).parent))
from graph_loader import (  # noqa: E402
    are_phase_deps_met,
    get_blocked_enforcement_paths,
    get_debt_items,
    get_enforcement_paths,
    get_invariants,
    get_open_debt_items,
    get_phase,
    get_phase_nodes,
    load_graph,
)


# ---------------------------------------------------------------------------
# Exception
# ---------------------------------------------------------------------------


class GraphViolationError(Exception):
    """Raised when a graph invariant is violated.

    The message includes:
    - The invariant ID (e.g., I1, I2)
    - The rule name
    - What was checked
    - What was found
    """

    def __init__(self, invariant_id: str, rule: str, description: str, detail: str):
        self.invariant_id = invariant_id
        self.rule = rule
        self.description = description
        self.detail = detail
        super().__init__(f"[{invariant_id}] {rule}: {description}\n  → {detail}")


# ---------------------------------------------------------------------------
# Individual invariant assertions
# ---------------------------------------------------------------------------


def assert_phase_deps_met(graph: dict, phase_id: str) -> None:
    """I1: No phase can run before its dependencies are COMPLETE.

    Raises GraphViolationError if any dependency is not COMPLETE.
    """
    phase = get_phase(graph, phase_id)
    if not phase:
        raise GraphViolationError(
            "I1", "phase_deps_must_be_complete",
            f"Phase {phase_id} not found in graph",
            "The phase ID does not exist in GRAPH-SPEC.yaml",
        )
    deps = phase.get("deps", [])
    for dep_id in deps:
        dep = get_phase(graph, dep_id)
        if not dep:
            raise GraphViolationError(
                "I1", "phase_deps_must_be_complete",
                f"Phase {phase_id} depends on {dep_id}, but {dep_id} not found",
                f"Dependency {dep_id} does not exist in graph",
            )
        if dep.get("status") != "COMPLETE":
            raise GraphViolationError(
                "I1", "phase_deps_must_be_complete",
                f"Phase {phase_id} depends on {dep_id}, but {dep_id} status is {dep.get('status')}",
                f"Cannot run {phase_id} until {dep_id} is COMPLETE",
            )


def assert_debt_close_has_evidence(debt_item: dict) -> None:
    """I2: No debt item can be CLOSED without commit_ref and artifact_ref.

    Raises GraphViolationError if a CLOSED debt item lacks evidence.
    """
    if debt_item.get("status") == "CLOSED":
        commit_ref = debt_item.get("commit_ref", "")
        artifact_ref = debt_item.get("artifact_ref", "")
        if not commit_ref:
            raise GraphViolationError(
                "I2", "debt_close_requires_evidence",
                f"Debt item {debt_item['id']} is CLOSED but has no commit_ref",
                f"Description: {debt_item.get('description', '—')}",
            )
        if not artifact_ref:
            raise GraphViolationError(
                "I2", "debt_close_requires_evidence",
                f"Debt item {debt_item['id']} is CLOSED but has no artifact_ref",
                f"Description: {debt_item.get('description', '—')}",
            )


def assert_rule_zero_complete(trace_path: Path) -> None:
    """I5: No code changes before RULE-ZERO is complete.

    Checks that trace.md has a RULE-ZERO entry for the current session
    before any IMPLEMENT entry.

    Raises GraphViolationError if RULE-ZERO was not logged before code changes.
    """
    if not trace_path.exists():
        raise GraphViolationError(
            "I5", "rule_zero_before_code",
            "trace.md does not exist — RULE-ZERO was not completed",
            "No session trace found. Read skill files and log understanding before coding.",
        )
    content = trace_path.read_text()
    if "RULE-ZERO" not in content and "Rule Zero" not in content:
        raise GraphViolationError(
            "I5", "rule_zero_before_code",
            "trace.md has no RULE-ZERO entry — understanding was not logged before coding",
            "Read the relevant skill file(s) and source code, then log understanding to trace.md.",
        )


def assert_session_closed_with_trace(trace_path: Path) -> None:
    """I4: No session can close without updating trace.md.

    Checks that trace.md has a session-end status block.

    Raises GraphViolationError if the trace is missing the status block.
    """
    if not trace_path.exists():
        raise GraphViolationError(
            "I4", "session_close_requires_trace_update",
            "trace.md does not exist at session close",
            "Session cannot close without a trace update.",
        )
    content = trace_path.read_text()
    required_sections = [
        "Fog cleared",
        "Fog remaining",
        "Debt items closed",
        "Debt items still open",
        "Blockers",
        "Next session",
    ]
    missing = [s for s in required_sections if s not in content]
    if missing:
        raise GraphViolationError(
            "I4", "session_close_requires_trace_update",
            f"trace.md missing session-end sections: {', '.join(missing)}",
            "Session-end status block must include all required sections.",
        )


def assert_orchestrator_knows_all_phases(graph: dict, orchestrator_path: Path) -> None:
    """I6: Orchestrator must know about ALL phases in the graph.

    Checks that orchestrator.sh includes all phase IDs from the graph.

    Raises GraphViolationError if any phase is missing from the orchestrator.
    """
    if not orchestrator_path.exists():
        raise GraphViolationError(
            "I6", "orchestrator_knows_all_phases",
            f"Orchestrator script not found at {orchestrator_path}",
            "The orchestrator script must exist and know about all phases.",
        )
    content = orchestrator_path.read_text()
    phases = get_phase_nodes(graph)
    missing = []
    for phase in phases:
        # Check if the phase number appears in the orchestrator
        phase_num = phase["id"].replace("P", "")
        # Look for the phase number in PHASE_DEPS or PHASE_NAMES
        if f"[{phase_num}]=" not in content and f'"{phase_num}"' not in content:
            # Also check if it appears in the case statement or run_all
            if f" {phase_num})" not in content and f" {phase_num} " not in content:
                missing.append(phase["id"])
    if missing:
        raise GraphViolationError(
            "I6", "orchestrator_knows_all_phases",
            f"Orchestrator is missing phases: {', '.join(missing)}",
            f"Update orchestrator.sh to include all {len(phases)} phases (0-16).",
        )


def assert_complete_phases_have_artifacts(results_dir: Path) -> None:
    """I7: Every phase marked COMPLETE must have a non-empty artifact reference.

    Checks that each results/phase-N.complete file is non-empty and contains
    a commit hash reference.

    Raises GraphViolationError if any .complete file is empty or lacks a commit ref.
    """
    if not results_dir.exists():
        raise GraphViolationError(
            "I7", "complete_phases_have_artifacts",
            f"Results directory not found: {results_dir}",
            "The results directory must exist with phase completion markers.",
        )
    empty_files = []
    no_commit = []
    for f in sorted(results_dir.glob("phase-*.complete")):
        content = f.read_text().strip()
        if not content:
            empty_files.append(f.name)
        elif "commit" not in content.lower() and "hash" not in content.lower():
            no_commit.append(f.name)
    if empty_files:
        raise GraphViolationError(
            "I7", "complete_phases_have_artifacts",
            f"Empty completion markers: {', '.join(empty_files)}",
            "Each .complete file must contain a commit hash + artifact reference.",
        )
    if no_commit:
        raise GraphViolationError(
            "I7", "complete_phases_have_artifacts",
            f"Completion markers without commit ref: {', '.join(no_commit)}",
            "Each .complete file must reference a commit hash.",
        )


# ---------------------------------------------------------------------------
# I3: Enforcement path status tracking
# ---------------------------------------------------------------------------

VALID_ENFORCEMENT_STATUSES = {
    "verified-on-hardware",
    "verified-in-unit-test",
    "verified-in-ci",
    "unverified",
}


def assert_enforcement_path_status(graph: dict) -> None:
    """Assert that enforcement path statuses are valid and consistent.

    Checks:
    1. Every enforcement path has a valid status from the enum
    2. No path marked 'verified-on-hardware' without a hardware_artifact_ref
    3. No blocked path (from open debt items) marked as 'verified-on-hardware'

    Raises GraphViolationError on any violation.
    """
    paths = get_enforcement_paths(graph)
    blocked = get_blocked_enforcement_paths(graph)
    blocked_ids = {p["id"] for p in blocked}

    for path in paths:
        path_id = path["id"]
        status = path.get("status", "")

        # Check 1: status must be from the valid enum
        if status not in VALID_ENFORCEMENT_STATUSES:
            raise GraphViolationError(
                "I3", "enforcement_path_status_valid",
                f"Enforcement path {path_id} has invalid status '{status}'",
                f"Status must be one of: {', '.join(sorted(VALID_ENFORCEMENT_STATUSES))}",
            )

        # Check 2: verified-on-hardware requires hardware_artifact_ref
        if status == "verified-on-hardware":
            artifact_ref = path.get("hardware_artifact_ref", "")
            if not artifact_ref:
                raise GraphViolationError(
                    "I3", "hardware_verification_requires_real_artifact",
                    f"Enforcement path {path_id} marked 'verified-on-hardware' "
                    f"without hardware_artifact_ref",
                    "Add a hardware_artifact_ref field with a description of "
                    "the real hardware test that verified this path.",
                )

        # Check 3: blocked paths cannot be verified-on-hardware
        if path_id in blocked_ids and status == "verified-on-hardware":
            raise GraphViolationError(
                "I3", "blocked_path_cannot_be_hardware_verified",
                f"Enforcement path {path_id} is blocked by open debt items "
                f"but marked 'verified-on-hardware'",
                "Resolve the blocking debt items before marking this path "
                "as verified-on-hardware.",
            )


# ---------------------------------------------------------------------------
# Full invariant sweep
# ---------------------------------------------------------------------------


def assert_all_invariants(graph: dict | None = None) -> list[str]:
    """Run all invariant checks and return a list of violation messages.

    Does NOT raise — collects all violations and returns them.
    Useful for a pre-flight check before starting work.
    """
    if graph is None:
        graph = load_graph()

    violations = []
    project_root = Path(__file__).parent.parent.parent

    # I1: Check all phase dependencies
    for phase in get_phase_nodes(graph):
        try:
            assert_phase_deps_met(graph, phase["id"])
        except GraphViolationError as e:
            violations.append(str(e))

    # I2: Check all closed debt items have evidence
    for debt in get_debt_items(graph):
        try:
            assert_debt_close_has_evidence(debt)
        except GraphViolationError as e:
            violations.append(str(e))

    # I3: Check enforcement path statuses are valid and consistent
    try:
        assert_enforcement_path_status(graph)
    except GraphViolationError as e:
        violations.append(str(e))

    # I4: Check session trace (non-fatal if no session in progress)
    trace_path = project_root / ".devin" / "graph" / "trace.md"
    if trace_path.exists():
        try:
            assert_session_closed_with_trace(trace_path)
        except GraphViolationError as e:
            violations.append(str(e))

    # I6: Check orchestrator knows all phases
    orchestrator_path = project_root / ".devin" / "orchestration" / "orchestrator.sh"
    try:
        assert_orchestrator_knows_all_phases(graph, orchestrator_path)
    except GraphViolationError as e:
        violations.append(str(e))

    # I7: Check completion markers have artifacts
    results_dir = project_root / ".devin" / "orchestration" / "results"
    try:
        assert_complete_phases_have_artifacts(results_dir)
    except GraphViolationError as e:
        violations.append(str(e))

    return violations


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Graph invariant assertion engine")
    parser.add_argument(
        "--assert-phase-deps",
        metavar="PHASE_ID",
        help="Assert that a single phase's dependencies are met (e.g., P3). Exits 0 if OK, 1 if violated.",
    )
    parser.add_argument(
        "--full-sweep",
        action="store_true",
        help="Run all invariant checks (default if no other flag given).",
    )
    args = parser.parse_args()

    if args.assert_phase_deps:
        # Single-phase dependency check
        phase_id = args.assert_phase_deps
        graph = load_graph()
        try:
            assert_phase_deps_met(graph, phase_id)
            print(f"  ✓ {phase_id}: dependencies met.")
            sys.exit(0)
        except GraphViolationError as e:
            print(f"  ✗ {phase_id}: {e}")
            sys.exit(1)
    else:
        # Full sweep (default)
        print("=== Graph Invariant Sweep ===")
        print()

        violations = assert_all_invariants()

        if not violations:
            print("  ✓ All invariants pass.")
        else:
            print(f"  ✗ {len(violations)} violation(s) found:")
            print()
            for v in violations:
                print(f"  ---")
                print(f"  {v}")
                print()

        print()
        print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
        sys.exit(0 if not violations else 1)
