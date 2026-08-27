#!/usr/bin/env python3
"""
test_graph_session.py — Unit tests for scripts/graph_session.py

Tests the session lifecycle tool that makes current-state.md a generated
artifact and rotates old trace.md sessions to archives.

Run: python3 scripts/test_graph_session.py
"""

import sys
import tempfile
import textwrap
from pathlib import Path

# Add scripts dir to path
_SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS_DIR))

from graph_session import (
    archive_trace,
    close_session,
    extract_latest_session,
    generate_current_state,
    parse_trace_sessions,
)

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

SAMPLE_TRACE = textwrap.dedent("""\
# trace.md — Cross-Session Context Trace

> This file persists context across agent sessions.

---

## Session 2026-08-01 — First session

### Fog cleared
- Something was learned.

### Fog remaining
- Something is still unknown.

### Debt items closed
None.

### Debt items still open
None.

### Blockers
- None.

### Next session opening
Do the next thing.

---

## Session 2026-08-02 — Second session

### RULE-ZERO — Understanding logged before code changes
- **Read**: `src/main.py` — the main entry point
- **Read**: `src/utils.py` — utility functions
- **Finding**: The code works.

### Fog cleared
- More was learned.

### Fog remaining
- Less is unknown.

### Debt items closed
None.

### Debt items still open
None.

### Blockers
- None.

### Next session opening
Do the final thing.

---
""")

SAMPLE_GRAPH_SPEC = textwrap.dedent("""\
# GRAPH-SPEC.yaml

phase_nodes:
  - id: P0
    status: COMPLETE
  - id: P1
    status: COMPLETE

enforcement_paths:
  - id: E-ENCRYPT
    name: file-encryption
    status: verified-on-hardware
    hardware_artifact_ref: "agent/test.json"
    risk_notes: "Verified"
  - id: E-DECRYPT
    name: file-decryption
    status: verified-in-unit-test
    risk_notes: "Needs hardware"

debt_items:
  - id: D-001
    status: CLOSED
    description: "First debt"
  - id: D-002
    status: CLOSED
    description: "Second debt"
""")


def _make_test_env():
    """Create a temp directory with trace.md and GRAPH-SPEC.yaml."""
    tmp = tempfile.mkdtemp(prefix="graph-session-test-")
    graph_dir = Path(tmp) / ".devin" / "graph"
    graph_dir.mkdir(parents=True)
    trace_path = graph_dir / "trace.md"
    graph_spec_path = graph_dir / "GRAPH-SPEC.yaml"
    current_state_path = graph_dir / "current-state.md"
    trace_path.write_text(SAMPLE_TRACE)
    graph_spec_path.write_text(SAMPLE_GRAPH_SPEC)
    return tmp, trace_path, graph_spec_path, current_state_path, graph_dir


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

_passed = 0
_failed = 0


def check(name: str, condition: bool, detail: str = ""):
    """Custom assert helper — prints progress and raises on failure.

    Using ``check`` (not ``test``) so pytest doesn't mis-collect this as a
    test function. Raises ``AssertionError`` on failure so pytest-collected
    ``test_*`` functions actually fail when conditions are false.
    """
    global _passed, _failed
    if condition:
        _passed += 1
        print(f"  ✓ {name}")
    else:
        _failed += 1
        print(f"  ✗ {name} {detail}")
        raise AssertionError(f"{name} {detail}")


def test_parse_trace_sessions():
    """parse_trace_sessions should find all session blocks."""
    sessions = parse_trace_sessions(SAMPLE_TRACE)
    check("parse_trace_sessions finds 2 sessions", len(sessions) == 2,
         f"got {len(sessions)}")
    check("first session header correct",
         "First session" in sessions[0]["header"],
         f"got '{sessions[0]['header']}'")
    check("second session header correct",
         "Second session" in sessions[1]["header"],
         f"got '{sessions[1]['header']}'")
    check("session bodies are non-empty",
         len(sessions[0]["body"]) > 0 and len(sessions[1]["body"]) > 0)


def test_extract_latest_session():
    """extract_latest_session should return the last session block."""
    latest = extract_latest_session(SAMPLE_TRACE)
    check("extract_latest_session returns second session",
         "Second session" in latest,
         f"got: {latest[:50]}")
    check("extract_latest_session includes Fog cleared",
         "Fog cleared" in latest)
    check("extract_latest_session includes Next session opening",
         "Next session opening" in latest)


def test_generate_current_state():
    """generate_current_state should produce a compact file with no Previous session blocks."""
    _tmp, trace_path, graph_spec_path, current_state_path, _ = _make_test_env()
    lines = generate_current_state(trace_path, graph_spec_path, current_state_path)
    content = current_state_path.read_text()

    check("generate_current_state returns positive line count", lines > 0, f"got {lines}")
    check("generated file has Latest session header",
         "## Latest session" in content)
    check("generated file has NO Previous session blocks",
         "## Previous session" not in content)
    check("generated file has convergence status",
         "## Convergence status" in content)
    check("generated file has enforcement path table",
         "E-DECRYPT" in content)
    check("generated file has open debt items section",
         "## Open debt items" in content)
    check("generated file has quick reference",
         "## Quick reference" in content)
    check("generated file is compact (< 200 lines)",
         lines < 200, f"got {lines} lines")
    check("generated file mentions it is generated",
         "GENERATED" in content)


def test_archive_trace():
    """archive_trace should move old sessions to archive files."""
    _tmp, trace_path, _graph_spec_path, _current_state_path, graph_dir = _make_test_env()

    # Add more sessions to trigger archival (need > keep sessions)
    content = trace_path.read_text()
    for i in range(3, 8):
        content += f"\n## Session 2026-08-{i:02d} — Session {i}\n\n"
        content += "### Fog cleared\n- Done.\n\n"
        content += "### Fog remaining\n- Unknown.\n\n"
        content += "### Debt items closed\nNone.\n\n"
        content += "### Debt items still open\nNone.\n\n"
        content += "### Blockers\n- None.\n\n"
        content += "### Next session opening\nNext.\n\n---\n\n"
    trace_path.write_text(content)

    original_lines = content.count("\n")
    archive_name = archive_trace(trace_path, graph_dir, threshold=50, keep=3)

    check("archive_trace returns archive filename", archive_name is not None,
         f"got {archive_name}")
    check("archive file was created",
         (graph_dir / archive_name).exists() if archive_name else False)

    new_content = trace_path.read_text()
    new_lines = new_content.count("\n")
    check("trace.md shrunk after archival",
         new_lines < original_lines,
         f"was {original_lines}, now {new_lines}")

    remaining_sessions = parse_trace_sessions(new_content)
    check("trace.md has exactly `keep` sessions after archival",
         len(remaining_sessions) == 3,
         f"got {len(remaining_sessions)}")

    archive_content = (graph_dir / archive_name).read_text()
    archived_sessions = parse_trace_sessions(archive_content)
    check("archive file has the archived sessions",
         len(archived_sessions) >= 4,
         f"got {len(archived_sessions)}")


def test_archive_trace_no_archival_needed():
    """archive_trace should return None when trace is under threshold."""
    _tmp, trace_path, _graph_spec_path, _current_state_path, graph_dir = _make_test_env()
    result = archive_trace(trace_path, graph_dir, threshold=10000, keep=5)
    check("archive_trace returns None when under threshold", result is None)


def test_close_session():
    """close_session should append to trace and regenerate current-state."""
    _tmp, trace_path, graph_spec_path, current_state_path, _ = _make_test_env()

    new_block = textwrap.dedent("""\
    ## Session: 2026-08-03 — New session

    ### RULE-ZERO — Understanding logged before code changes
    - **Read**: `src/new.py` — new file
    - **Finding**: New finding.

    ### Fog cleared
- New thing learned.

    ### Fog remaining
- Still unknown.

    ### Debt items closed
None.

    ### Debt items still open
None.

    ### Blockers
- None.

    ### Next session opening
Do more.
    """)

    original_content = trace_path.read_text()
    original_session_count = len(parse_trace_sessions(original_content))

    success = close_session(new_block, trace_path, current_state_path, graph_spec_path)

    check("close_session returns True", success)
    new_content = trace_path.read_text()
    new_session_count = len(parse_trace_sessions(new_content))
    check("trace.md has one more session after close_session",
         new_session_count == original_session_count + 1,
         f"was {original_session_count}, now {new_session_count}")

    state_content = current_state_path.read_text()
    check("current-state.md regenerated with new latest session",
         "New session" in state_content)
    check("current-state.md has no Previous session blocks",
         "## Previous session" not in state_content)


def test_generate_current_state_missing_trace():
    """generate_current_state should return 1 (error) when trace.md missing."""
    result = generate_current_state(
        trace_path=Path("/nonexistent/trace.md"),
        graph_spec_path=Path("/nonexistent/spec.yaml"),
        output_path=Path("/tmp/test-output.md"),
    )
    check("generate_current_state returns 1 on missing trace", result == 1)


if __name__ == "__main__":
    print("=== test_graph_session.py ===")
    print()
    test_parse_trace_sessions()
    test_extract_latest_session()
    test_generate_current_state()
    test_archive_trace()
    test_archive_trace_no_archival_needed()
    test_close_session()
    test_generate_current_state_missing_trace()
    print()
    print(f"  {_passed} passed, {_failed} failed")
    sys.exit(0 if _failed == 0 else 1)
