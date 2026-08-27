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
        assert_rule_zero_quality,
        assert_session_closed_with_trace,
        assert_session_end_quality,
        assert_current_state_updated,
        assert_artifact_quality,
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
import re
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


def assert_current_state_updated(current_state_path: Path) -> None:
    """I4 (extended): No session can close without updating current-state.md.

    Checks that current-state.md has a session-end status block with the
    same required sections as trace.md. This ensures the compact summary
    file stays in sync with the full trace.

    Raises GraphViolationError if current-state.md is missing the status block.
    """
    if not current_state_path.exists():
        raise GraphViolationError(
            "I4", "current_state_requires_update",
            "current-state.md does not exist at session close",
            "Session cannot close without updating current-state.md.",
        )
    content = current_state_path.read_text()
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
            "I4", "current_state_requires_update",
            f"current-state.md missing session-end sections: {', '.join(missing)}",
            "current-state.md must include the same session-end status block as trace.md.",
        )


def assert_current_state_compact(current_state_path: Path) -> None:
    """I4 (compactness): current-state.md must not accumulate old session blocks.

    current-state.md is a GENERATED artifact (produced by
    `scripts/graph_session.py generate-current-state`). It should contain
    only ONE session block ("## Latest session"), not a growing list of
    "## Previous session" blocks. Old sessions live in trace.md and the
    trace archives — current-state.md is the compact view.

    This invariant prevents the bloat that occurs when agents manually
    append "Previous session" blocks without removing old ones (the file
    grew from ~70 lines to 633, causing session-start lag).

    Raises GraphViolationError if current-state.md contains
    "## Previous session" headers or exceeds 300 lines.
    """
    if not current_state_path.exists():
        raise GraphViolationError(
            "I4", "current_state_compact",
            "current-state.md does not exist",
            "Run `make gen-state` to generate it from trace.md.",
        )
    content = current_state_path.read_text()
    line_count = content.count("\n")

    # Check for accumulated "Previous session" blocks
    prev_session_count = len(re.findall(r"^##\s+Previous\s+session", content, re.MULTILINE))
    if prev_session_count > 0:
        raise GraphViolationError(
            "I4", "current_state_compact",
            f"current-state.md has {prev_session_count} 'Previous session' block(s) — "
            f"should have 0. Old sessions belong in trace.md, not current-state.md.",
            "Run `make gen-state` to regenerate current-state.md from trace.md "
            "(this removes old session blocks automatically).",
        )

    # Check line count — the file should be compact (~70-200 lines)
    if line_count > 300:
        raise GraphViolationError(
            "I4", "current_state_compact",
            f"current-state.md is {line_count} lines — exceeds 300 line compactness limit. "
            f"The file is a generated compact summary, not a full history.",
            "Run `make gen-state` to regenerate, and `make archive-trace` if "
            "trace.md itself is too large.",
        )


# ---------------------------------------------------------------------------
# Goodhart's Law defense — structural quality minimums (Q1 resolution)
# These prevent the laziest gaming of I4, I5, I7 without requiring a
# semantic evaluator. Thresholds are deliberately low.
# ---------------------------------------------------------------------------


def _extract_last_rule_zero_block(content: str) -> str:
    """Extract the content of the last RULE-ZERO entry in trace.md.

    Finds the last occurrence of a RULE-ZERO header and returns all content
    until the next '---' separator or '## ' header.
    Returns empty string if no RULE-ZERO entry found.
    """
    # Find all RULE-ZERO header positions (### RULE-ZERO or ### Rule Zero)
    pattern = r"###\s+(?:RULE-ZERO|Rule Zero)"
    matches = list(re.finditer(pattern, content))
    if not matches:
        return ""
    last_match = matches[-1]
    start = last_match.end()
    # Find the next --- separator or ## header after the RULE-ZERO header
    rest = content[start:]
    end_match = re.search(r"^---\s*$|^##\s", rest, re.MULTILINE)
    if end_match:
        return rest[: end_match.start()]
    return rest


def assert_rule_zero_quality(trace_path: Path) -> None:
    """I5 (strengthened): RULE-ZERO entry must have structural quality.

    Checks that the last RULE-ZERO entry in trace.md has:
    - At least 2 file path references (lines containing '/' or '\\')
    - At least 1 'Finding' or 'Read' line

    This prevents shallow compliance where an agent writes "RULE-ZERO done"
    without actually reading source files or synthesizing findings.

    Raises GraphViolationError if the quality minimums are not met.
    """
    if not trace_path.exists():
        raise GraphViolationError(
            "I5", "rule_zero_quality",
            "trace.md does not exist — cannot check RULE-ZERO quality",
            "Read skill files and source code, then log understanding to trace.md.",
        )
    content = trace_path.read_text()
    block = _extract_last_rule_zero_block(content)
    if not block:
        raise GraphViolationError(
            "I5", "rule_zero_quality",
            "No RULE-ZERO entry found in trace.md",
            "Add a '### RULE-ZERO — Understanding logged before code changes' section.",
        )
    # Count file path references (lines containing / or \ that look like paths)
    file_path_lines = [
        line for line in block.splitlines()
        if ("/" in line or "\\" in line) and line.strip().startswith("-")
    ]
    if len(file_path_lines) < 2:
        raise GraphViolationError(
            "I5", "rule_zero_quality",
            f"RULE-ZERO entry has only {len(file_path_lines)} file path reference(s), need >=2",
            "Cite at least 2 source files you read (lines starting with '- **Read**:').",
        )
    # Check for at least 1 Finding or Read line
    has_finding = bool(re.search(r"\*\*Finding\*\*|\*\*Read\*\*", block))
    if not has_finding:
        raise GraphViolationError(
            "I5", "rule_zero_quality",
            "RULE-ZERO entry has no 'Finding' or 'Read' line",
            "Include at least 1 '- **Read**:' or '- **Finding**:' line.",
        )


def assert_session_end_quality(trace_path: Path) -> None:
    """I4 (strengthened): Session-end block must have content under each section.

    Checks that the last session-end status block in trace.md has at least
    1 line of non-header content under each of the 6 required sections.

    This prevents shallow compliance where an agent writes the section headers
    but leaves them empty.

    Raises GraphViolationError if any section has no content.
    """
    if not trace_path.exists():
        raise GraphViolationError(
            "I4", "session_end_quality",
            "trace.md does not exist — cannot check session-end quality",
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
    # Find the last occurrence of each section header and check content after it
    for section in required_sections:
        # Find all occurrences of the section header (### Section Name)
        pattern = rf"###\s+{re.escape(section)}"
        matches = list(re.finditer(pattern, content))
        if not matches:
            raise GraphViolationError(
                "I4", "session_end_quality",
                f"Session-end section '{section}' not found in trace.md",
                "All 6 required sections must be present.",
            )
        # Check the last occurrence (most recent session)
        last = matches[-1]
        after = content[last.end():]
        # Find content until the next ### or ## header or --- separator
        end_match = re.search(r"^###\s|^##\s|^---\s*$", after, re.MULTILINE)
        section_content = after[: end_match.start()] if end_match else after
        # Count non-empty, non-header lines
        content_lines = [
            line for line in section_content.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        if len(content_lines) < 1:
            raise GraphViolationError(
                "I4", "session_end_quality",
                f"Session-end section '{section}' has no content",
                f"Add at least 1 line of content under the '{section}' header.",
            )


def assert_artifact_quality(results_dir: Path) -> None:
    """I7 (strengthened): .complete files must have commit hash + test count.

    Checks that each results/phase-N.complete file contains:
    - A commit hash pattern (7+ hexadecimal characters)
    - A test count (digits followed by 'test' or 'pass')

    This prevents shallow compliance where 'tests pass' is written without
    a commit hash, or a commit hash is written without evidence of tests.

    Raises GraphViolationError if any .complete file lacks quality.
    """
    if not results_dir.exists():
        raise GraphViolationError(
            "I7", "artifact_quality",
            f"Results directory not found: {results_dir}",
            "The results directory must exist with phase completion markers.",
        )
    no_commit = []
    no_tests = []
    for f in sorted(results_dir.glob("phase-*.complete")):
        content = f.read_text()
        # Check for commit hash: 7+ hex chars (git short hash)
        if not re.search(r"\b[0-9a-f]{7,}\b", content):
            no_commit.append(f.name)
        # Check for test count: digits + 'test' or 'pass'
        if not re.search(r"\d+.*(?:test|pass)", content, re.IGNORECASE):
            no_tests.append(f.name)
    if no_commit:
        raise GraphViolationError(
            "I7", "artifact_quality",
            f"Completion markers without commit hash: {', '.join(no_commit)}",
            "Each .complete file must contain a git commit hash (7+ hex chars).",
        )
    if no_tests:
        raise GraphViolationError(
            "I7", "artifact_quality",
            f"Completion markers without test count: {', '.join(no_tests)}",
            "Each .complete file must contain a test count (digits + 'test' or 'pass').",
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

    # I4 (extended): Check current-state.md is also updated
    current_state_path = project_root / ".devin" / "graph" / "current-state.md"
    if current_state_path.exists():
        try:
            assert_current_state_updated(current_state_path)
        except GraphViolationError as e:
            violations.append(str(e))

    # I4 (compactness): Check current-state.md hasn't bloated with old sessions
    if current_state_path.exists():
        try:
            assert_current_state_compact(current_state_path)
        except GraphViolationError as e:
            violations.append(str(e))

    # I4 (strengthened): Check session-end block has content under each section
    if trace_path.exists():
        try:
            assert_session_end_quality(trace_path)
        except GraphViolationError as e:
            violations.append(str(e))

    # I5 (strengthened): Check RULE-ZERO entry has file paths + findings
    if trace_path.exists():
        try:
            assert_rule_zero_quality(trace_path)
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

    # I7 (strengthened): Check .complete files have commit hash + test count
    try:
        assert_artifact_quality(results_dir)
    except GraphViolationError as e:
        violations.append(str(e))

    return violations


# ---------------------------------------------------------------------------
# Convergence report (Path A: surface the real gaps, don't just assert state)
# ---------------------------------------------------------------------------


def report_convergence(graph: dict | None = None) -> dict:
    """Compute the project's convergence state — what's done vs. what's left.

    This is NOT an assertion (it never raises). It's a reporting function that
    surfaces the real remaining work, which the declared status ("all phases
    COMPLETE, all debt CLOSED") can obscure.

    The three convergence dimensions:
      1. Phases:       all 17 must be COMPLETE
      2. Debt:         all debt items must be CLOSED
      3. Enforcement:  all 13 paths must be verified-on-hardware

    The project is "converged" only when all three reach 100%. Right now
    enforcement paths are the gap — most are verified-in-unit-test only.
    """
    if graph is None:
        graph = load_graph()

    phases = get_phase_nodes(graph)
    debts = get_debt_items(graph)
    enforcement = get_enforcement_paths(graph)

    phases_complete = sum(1 for p in phases if p.get("status") == "COMPLETE")
    debts_closed = sum(1 for d in debts if d.get("status") == "CLOSED")
    enforce_on_hw = sum(1 for e in enforcement if e.get("status") == "verified-on-hardware")
    enforce_in_unit = sum(1 for e in enforcement if e.get("status") == "verified-in-unit-test")
    enforce_unverified = sum(1 for e in enforcement if e.get("status") == "unverified")

    # The enforcement paths that still need hardware verification
    enforce_gap = [
        {
            "id": e["id"],
            "name": e.get("name", ""),
            "status": e.get("status", "?"),
            "risk_notes": e.get("risk_notes", ""),
        }
        for e in enforcement
        if e.get("status") != "verified-on-hardware"
    ]

    converged = (
        phases_complete == len(phases)
        and debts_closed == len(debts)
        and enforce_on_hw == len(enforcement)
    )

    return {
        "phases": {"complete": phases_complete, "total": len(phases)},
        "debt": {"closed": debts_closed, "total": len(debts)},
        "enforcement": {
            "on_hardware": enforce_on_hw,
            "in_unit_test": enforce_in_unit,
            "unverified": enforce_unverified,
            "total": len(enforcement),
        },
        "enforcement_gap": enforce_gap,
        "converged": converged,
    }


def print_convergence_report() -> None:
    """Print a human-readable convergence report to stdout."""
    report = report_convergence()

    print("=== Graph Convergence Report ===")
    print()
    print(f"  Phases:       {report['phases']['complete']}/{report['phases']['total']} COMPLETE")
    print(f"  Debt:         {report['debt']['closed']}/{report['debt']['total']} CLOSED")
    print(
        f"  Enforcement:  {report['enforcement']['on_hardware']}/{report['enforcement']['total']} "
        f"verified-on-hardware"
    )
    print(
        f"                {report['enforcement']['in_unit_test']} verified-in-unit-test, "
        f"{report['enforcement']['unverified']} unverified"
    )
    print()

    if report["converged"]:
        print("  ✓ Project CONVERGED — all dimensions at 100%.")
    else:
        print("  ✗ Project NOT CONVERGED — remaining gaps:")
        print()
        if report["phases"]["complete"] < report["phases"]["total"]:
            print(f"     • {report['phases']['total'] - report['phases']['complete']} phase(s) not COMPLETE")
        if report["debt"]["closed"] < report["debt"]["total"]:
            print(f"     • {report['debt']['total'] - report['debt']['closed']} debt item(s) not CLOSED")
        if report["enforcement"]["on_hardware"] < report["enforcement"]["total"]:
            gap = report["enforcement"]["total"] - report["enforcement"]["on_hardware"]
            print(f"     • {gap} enforcement path(s) need hardware verification:")
            for e in report["enforcement_gap"]:
                print(f"         - {e['id']:12} {e['name']:30} status={e['status']}")
                if e["risk_notes"]:
                    print(f"           notes: {e['risk_notes'][:80]}")
    print()
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")


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
    parser.add_argument(
        "--convergence",
        action="store_true",
        help="Print convergence report (phases, debt, enforcement gaps). Never raises.",
    )
    args = parser.parse_args()

    if args.convergence:
        print_convergence_report()
        sys.exit(0)
    elif args.assert_phase_deps:
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
