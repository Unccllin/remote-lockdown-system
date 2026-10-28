#!/usr/bin/env python3
"""
graph_session.py — Session lifecycle tool for the node graph.

This tool makes current-state.md a GENERATED artifact (derived from
trace.md + GRAPH-SPEC.yaml) instead of a manually maintained file.
This prevents the bloat that occurs when agents append "Previous session"
blocks without removing old ones.

Subcommands:
  generate-current-state  — Regenerate current-state.md from trace.md + graph spec.
                             Extracts only the latest session block, combines it
                             with convergence status from GRAPH-SPEC.yaml, and
                             writes a compact (~70-120 line) file.
  archive-trace           — Rotate old session blocks from trace.md into
                             trace-archive-YYYY-MM.md files when trace.md
                             exceeds a line threshold. Keeps only the latest
                             N sessions in the active trace.
  close-session           — Append a session-end block (from a file or stdin)
                             to trace.md, then regenerate current-state.md.
                             This is the single command agents run at session end.

Usage:
  python3 scripts/graph_session.py generate-current-state
  python3 scripts/graph_session.py archive-trace --threshold 3000 --keep 5
  python3 scripts/graph_session.py close-session --block-file /tmp/session-block.md
  python3 scripts/graph_session.py close-session --block-stdin < /tmp/block.md

Exit codes:
  0 — success
  1 — error (file not found, parse failure, etc.)
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add graph directory to path for graph_loader import
_GRAPH_DIR = Path(__file__).resolve().parent.parent / ".devin" / "graph"
sys.path.insert(0, str(_GRAPH_DIR))

from graph_loader import (
    get_closed_debt_items,
    get_enforcement_paths,
    get_open_debt_items,
    get_phase_nodes,
    load_graph,
)

# ---------------------------------------------------------------------------
# File paths
# ---------------------------------------------------------------------------

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TRACE_PATH = _PROJECT_ROOT / ".devin" / "graph" / "trace.md"
_CURRENT_STATE_PATH = _PROJECT_ROOT / ".devin" / "graph" / "current-state.md"
_GRAPH_SPEC_PATH = _GRAPH_DIR / "GRAPH-SPEC.yaml"
_ARCHIVE_DIR = _GRAPH_DIR

# ---------------------------------------------------------------------------
# Trace parsing
# ---------------------------------------------------------------------------

# Session headers in trace.md: "## Session ...", "## Session: ..."
_SESSION_HEADER_RE = re.compile(r"^##\s+Session[:\s]", re.MULTILINE)


def parse_trace_sessions(trace_content: str) -> list[dict]:
    """Split trace.md into session blocks.

    Returns a list of dicts: {header, body, start_pos, end_pos}.
    The header is the full "## Session ..." line.
    The body is everything between the header and the next "---" or "## " header.
    """
    sessions = []
    # Find all session header positions
    for match in _SESSION_HEADER_RE.finditer(trace_content):
        header_start = match.start()
        # Find the header line end
        header_end = trace_content.index("\n", match.end()) + 1
        header_line = trace_content[header_start:header_end].strip()

        # Find the end of this session block: next "---" line or next "## " header
        # after the header line
        rest = trace_content[header_end:]
        end_match = re.search(r"^---\s*$|^##\s", rest, re.MULTILINE)
        if end_match:
            body_end_relative = end_match.start()
        else:
            body_end_relative = len(rest)

        body = trace_content[header_end:header_end + body_end_relative].rstrip()
        sessions.append({
            "header": header_line,
            "body": body,
            "start_pos": header_start,
            "end_pos": header_end + body_end_relative,
        })
    return sessions


# Only these `###` sections are carried into current-state.md. Everything else
# in a session block (RULE-ZERO reading lists, IMPLEMENT changelogs, long
# VERIFY transcripts) is history and belongs in trace.md.
#
# Why a whitelist: the generator used to copy the *entire* latest session block,
# so every addendum inflated current-state.md until it breached the 300-line
# compactness invariant and had to be split by hand — twice in one session. The
# file's own purpose is "latest status, open items, next session opening", which
# is exactly this list.
_STATE_SECTIONS = (
    "fog cleared",
    "fog remaining",
    "debt items closed",
    "debt items still open",
    "blockers",
    "session artifacts",
    "failure attribution",
    "verify",
    "next session",
)

# Optional sections are dropped first when the file would exceed the cap.
_OPTIONAL_SECTIONS = ("session artifacts", "failure attribution", "verify")

# Leave margin under the invariant's hard limit of 300.
_MAX_LINES = 260

_SECTION_RE = re.compile(r"^###\s+(.*)$", re.MULTILINE)


def extract_state_sections(body: str) -> list[tuple[str, str]]:
    """Return [(heading, text)] for the whitelisted sections of a session body.

    Text includes the heading line. Order is preserved as written.
    """
    matches = list(_SECTION_RE.finditer(body))
    sections: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        heading = m.group(1).strip()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        text = body[m.start():end].rstrip()
        if any(heading.lower().startswith(name) for name in _STATE_SECTIONS):
            sections.append((heading, text))
    return sections


def fit_to_cap(
    sections: list[tuple[str, str]], budget: int = _MAX_LINES, trailer: str = ""
) -> str:
    """Render state sections, dropping optional detail until they fit `budget`.

    1. Optional sections (artifacts, failure attribution, verify) are dropped first.
    2. If still too long, remaining section bodies are truncated line-wise, newest
       content cut from the end, with an explicit marker.
    The marker always names trace.md so the reader knows where the detail went.
    """
    marker = "_Truncated to keep current-state compact — full detail in `.devin/graph/trace.md`._"

    def render(secs: list[tuple[str, str]]) -> str:
        parts = [t for _h, t in secs]
        if trailer:
            parts.append(trailer)
        return "\n\n".join(parts)

    kept = list(sections)
    dropped: list[str] = []
    for name in _OPTIONAL_SECTIONS:
        if not kept:
            break
        if "\n".join(render(kept).splitlines()).count("\n") + 1 <= budget:
            break
        for i, (heading, _text) in enumerate(kept):
            if heading.lower().startswith(name):
                dropped.append(heading)
                kept.pop(i)
                break

    text = render(kept)
    if dropped:
        text = render(kept) + "\n\n" + marker + " Dropped: " + ", ".join(dropped) + "."

    line_count = text.count("\n") + 1
    if line_count > budget:
        lines = text.splitlines()
        keep = max(budget - 2, 10)
        text = "\n".join(lines[:keep]) + "\n\n" + marker
    return text


def extract_latest_session(trace_content: str) -> str:
    """Extract the latest session block from trace.md.

    Returns the full session block (header + body) as a string.
    Returns empty string if no sessions found.
    """
    sessions = parse_trace_sessions(trace_content)
    if not sessions:
        return ""
    latest = sessions[-1]
    return f"{latest['header']}\n{latest['body']}\n"


# ---------------------------------------------------------------------------
# Convergence status generation
# ---------------------------------------------------------------------------

def generate_convergence_status(graph: dict) -> str:
    """Generate the convergence status section from GRAPH-SPEC.yaml.

    Counts phases, debt items, and enforcement paths by status.
    """
    phases = get_phase_nodes(graph)
    phases_complete = sum(1 for p in phases if p.get("status") == "COMPLETE")
    phases_total = len(phases)

    debt_open = get_open_debt_items(graph)
    debt_closed = get_closed_debt_items(graph)
    debt_total = len(debt_open) + len(debt_closed)

    enforcement = get_enforcement_paths(graph)
    hw_verified = [e for e in enforcement if e.get("status") == "verified-on-hardware"]
    unit_tested = [e for e in enforcement if e.get("status") == "verified-in-unit-test"]
    hw_count = len(hw_verified)
    enforcement_total = len(enforcement)

    phases_converged = "✓" if phases_complete == phases_total else "✗"
    debt_converged = "✓" if len(debt_open) == 0 else "✗"
    enforce_converged = "✓" if hw_count == enforcement_total else "✗"

    lines = [
        "## Convergence status (read this first)",
        "",
        "> Auto-generated by `scripts/graph_session.py generate-current-state`.",
        "> Run `make graph-status` for the live version.",
        "",
        "| Dimension | Done | Total | Converged? |",
        "|-----------|------|-------|------------|",
        f"| Phases (P0–P16) | {phases_complete} | {phases_total} | {phases_converged} |",
        f"| Debt items | {len(debt_closed)} | {debt_total} | {debt_converged} |",
        f"| Enforcement paths (on hardware) | {hw_count} | {enforcement_total} | {enforce_converged} |",
        "",
    ]

    if enforce_converged == "✗":
        debt_status = ("all debt is closed" if debt_total > 0 and len(debt_closed) == debt_total
                       else f"{len(debt_closed)} of {debt_total} debt items are closed")
        lines.append(f"**The project is NOT converged.** All phases are complete and "
                      f"{debt_status}, but **{len(unit_tested)} of {enforcement_total} "
                      f"enforcement paths are only `verified-in-unit-test`**, "
                      f"not `verified-on-hardware`. Graph invariant I3 blocks marking them "
                      f"`verified-on-hardware` without a real hardware artifact.")
        lines.append("")

        if unit_tested:
            lines.append(f"**The {len(unit_tested)} enforcement paths that still need "
                         f"hardware verification:**")
            lines.append("")
            lines.append("| ID | Name | Status | Blocker |")
            lines.append("|----|------|--------|---------|")
            for e in unit_tested:
                risk = e.get("risk_notes", "Needs hardware verification")
                # Truncate risk notes for table readability
                if len(risk) > 80:
                    risk = risk[:77] + "..."
                lines.append(f"| {e['id']} | {e['name']} | {e['status']} | {risk} |")
            lines.append("")

        if hw_verified:
            lines.append(f"**The {hw_count} already verified on hardware:**")
            lines.append("")
            lines.append("| ID | Name | Artifact |")
            lines.append("|----|------|----------|")
            for e in hw_verified:
                artifact = e.get("hardware_artifact_ref", "—")
                lines.append(f"| {e['id']} | {e['name']} | {artifact} |")
            lines.append("")
    else:
        lines.append(f"**The project IS converged.** All {phases_total} phases complete, "
                      f"all {debt_total} debt items closed, all {enforcement_total} "
                      f"enforcement paths verified on hardware.")
        lines.append("")

    lines.append("---")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Open debt items section
# ---------------------------------------------------------------------------

def generate_open_debt_section(graph: dict) -> str:
    """Generate the open debt items section from GRAPH-SPEC.yaml."""
    open_debt = get_open_debt_items(graph)
    closed_debt = get_closed_debt_items(graph)

    if not open_debt:
        return (f"## Open debt items\n\n"
                f"None. All {len(closed_debt)} debt items are CLOSED.\n"
                f"See `docs/adr/DEBT-LEDGER.md` and `docs/adr/PBL-DEBT-LEDGER.md` for the full ledger.\n\n---\n")

    lines = ["## Open debt items", ""]
    lines.append("| ID | Description | Status | Blocks |")
    lines.append("|----|-------------|--------|--------|")
    for d in open_debt:
        desc = d.get("description", "")[:60]
        blocks = ", ".join(d.get("blocks", [])) or "—"
        lines.append(f"| {d['id']} | {desc} | {d['status']} | {blocks} |")
    lines.append("")
    lines.append("See `docs/adr/DEBT-LEDGER.md` (D-001..D-021) and "
                 "`docs/adr/PBL-DEBT-LEDGER.md` (D-100..D-130) for close criteria.")
    lines.append("")
    lines.append("---")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Full current-state.md generation
# ---------------------------------------------------------------------------

_HEADER = """# current-state.md — Compact Session State

> **Purpose**: This is the primary file agents read at session start. It
> contains the latest session's **state** — fog, debt, blockers, next opening —
> plus convergence. Implementation logs and RULE-ZERO reading lists stay in
> `.devin/graph/trace.md`; that is why this file no longer grows with block
> length and never needs hand-splitting.
>
> **This file is GENERATED by `scripts/graph_session.py generate-current-state`.**
> Do not edit by hand — your changes will be overwritten. To update, append
> a session block to `trace.md` and re-run `make gen-state`.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` and
> `assert_current_state_updated()` enforce that this file is updated at every
> session end with a status block.

---

"""

_FOOTER = """## Quick reference

- **Graph spec**: `.devin/graph/GRAPH-SPEC.yaml`
- **Full trace history**: `.devin/graph/trace.md` (read on demand)
- **Trace archives**: `.devin/graph/trace-archive-*.md` (rotated old sessions)
- **Debt ledger**: `docs/adr/DEBT-LEDGER.md` (D-001..D-021, all CLOSED)
- **PBL debt ledger**: `docs/adr/PBL-DEBT-LEDGER.md` (D-100..D-130, 31 OPEN)
- **Graph ADR**: `docs/adr/GRAPH-SPEC.md`
- **Verification**: `make graph-check` (runs `graph_assert.py` — all invariants)
- **Clean state**: `make clean-state` (runs 5-condition checklist from L12)
- **Regenerate this file**: `make gen-state` (runs `graph_session.py generate-current-state`)
"""


def generate_current_state(
    trace_path: Path = _TRACE_PATH,
    graph_spec_path: Path = _GRAPH_SPEC_PATH,
    output_path: Path = _CURRENT_STATE_PATH,
) -> int:
    """Regenerate current-state.md from trace.md + GRAPH-SPEC.yaml.

    Returns the number of lines written.
    """
    if not trace_path.exists():
        print(f"ERROR: trace.md not found at {trace_path}", file=sys.stderr)
        return 1
    if not graph_spec_path.exists():
        print(f"ERROR: GRAPH-SPEC.yaml not found at {graph_spec_path}", file=sys.stderr)
        return 1

    trace_content = trace_path.read_text()
    graph = load_graph(graph_spec_path)

    sessions = parse_trace_sessions(trace_content)
    if not sessions:
        print("ERROR: No session blocks found in trace.md", file=sys.stderr)
        return 1
    latest = sessions[-1]

    convergence = generate_convergence_status(graph)
    open_debt = generate_open_debt_section(graph)

    # Rename the latest session header from "## Session" to "## Latest session"
    header_line = re.sub(
        r"^##\s+Session[:\s]*",
        "## Latest session: ",
        latest["header"],
        count=1,
    )

    # Only the state-bearing sections are carried over — see _STATE_SECTIONS.
    sections = extract_state_sections(latest["body"])

    fixed = (
        _HEADER
        + convergence
        + "\n"
        + header_line
        + "\n\n"
        + "\n---\n\n"
        + open_debt
        + "\n"
        + _FOOTER
    )
    budget = max(_MAX_LINES - (fixed.count("\n") + 1), 40)
    body_text = fit_to_cap(sections, budget=budget)
    if not body_text.strip():
        body_text = (
            "_The latest session block has no state sections "
            "(fog/debt/blockers/next) — read `.devin/graph/trace.md`._"
        )

    content = (
        _HEADER
        + convergence
        + "\n"
        + header_line
        + "\n\n"
        + body_text
        + "\n\n---\n\n"
        + open_debt
        + "\n"
        + _FOOTER
    )

    output_path.write_text(content)
    line_count = content.count("\n")
    return line_count


# ---------------------------------------------------------------------------
# Trace archival
# ---------------------------------------------------------------------------


def archive_trace(
    trace_path: Path = _TRACE_PATH,
    archive_dir: Path = _ARCHIVE_DIR,
    threshold: int = 3000,
    keep: int = 5,
) -> str | None:
    """Rotate old session blocks from trace.md into archive files.

    When trace.md exceeds `threshold` lines, moves all but the latest `keep`
    sessions into a trace-archive-YYYY-MM.md file. Returns the archive filename
    if archival happened, None if no archival was needed.
    """
    if not trace_path.exists():
        print(f"ERROR: trace.md not found at {trace_path}", file=sys.stderr)
        return None

    content = trace_path.read_text()
    line_count = content.count("\n")

    if line_count <= threshold:
        print(f"trace.md is {line_count} lines (threshold {threshold}) — no archival needed.")
        return None

    sessions = parse_trace_sessions(content)
    if len(sessions) <= keep:
        print(f"Only {len(sessions)} sessions, keeping {keep} — no archival needed.")
        return None

    # Sessions to archive: all but the latest `keep`
    to_archive = sessions[:-keep]
    to_keep = sessions[-keep:]

    # Determine archive filename from the date range of archived sessions
    # Extract date from first archived session header
    first_header = to_archive[0]["header"]
    date_match = re.search(r"(\d{4}-\d{2})", first_header)
    if date_match:
        archive_month = date_match.group(1)
    else:
        archive_month = datetime.now(tz=timezone.utc).strftime("%Y-%m")

    archive_path = archive_dir / f"trace-archive-{archive_month}.md"

    # Build archive file content
    # Preserve the trace.md header for context
    header_end = content.find("---\n")
    if header_end != -1:
        file_header = content[:header_end + 4] + "\n"
    else:
        file_header = ""

    archive_content = file_header
    archive_content += f"# Archived sessions from trace.md ({archive_month})\n\n"
    archive_content += "> Auto-archived by `scripts/graph_session.py archive-trace`.\n"
    archive_content += "> These sessions were rotated out of trace.md to keep it compact.\n\n"

    for s in to_archive:
        archive_content += f"{s['header']}\n{s['body']}\n\n---\n\n"

    # If archive file already exists, append
    if archive_path.exists():
        existing = archive_path.read_text()
        archive_content = existing + "\n" + archive_content

    archive_path.write_text(archive_content)

    # Rebuild trace.md with only the header + kept sessions
    new_trace = file_header
    for s in to_keep:
        new_trace += f"{s['header']}\n{s['body']}\n\n---\n\n"

    trace_path.write_text(new_trace)

    archived_count = len(to_archive)
    new_lines = new_trace.count("\n")
    print(f"Archived {archived_count} sessions to {archive_path.name}")
    print(f"trace.md is now {new_lines} lines (was {line_count})")
    return archive_path.name


# ---------------------------------------------------------------------------
# Close session
# ---------------------------------------------------------------------------


def close_session(
    block_content: str,
    trace_path: Path = _TRACE_PATH,
    current_state_path: Path = _CURRENT_STATE_PATH,
    graph_spec_path: Path = _GRAPH_SPEC_PATH,
) -> bool:
    """Append a session-end block to trace.md and regenerate current-state.md.

    The block_content should be a full session block starting with
    "## Session: ..." header.

    After appending, automatically runs memory consolidate/decay if the
    raw session count triggers the thresholds (every 5 sessions consolidate,
    every 10 sessions decay). This enforces the cadence that was previously
    only a manual recommendation.
    """
    if not trace_path.exists():
        print(f"ERROR: trace.md not found at {trace_path}", file=sys.stderr)
        return False

    # Ensure the block starts with a session header
    if not _SESSION_HEADER_RE.match(block_content.strip()):
        print("ERROR: session block must start with '## Session' header", file=sys.stderr)
        return False

    # Append to trace.md
    existing = trace_path.read_text()
    if not existing.endswith("\n"):
        existing += "\n"
    if not existing.endswith("---\n\n"):
        existing += "\n---\n\n"

    existing += block_content.strip() + "\n\n---\n"
    trace_path.write_text(existing)

    # Regenerate current-state.md
    lines = generate_current_state(trace_path, graph_spec_path, current_state_path)
    if lines and lines > 0:
        print(f"Appended session to trace.md and regenerated current-state.md ({lines} lines)")
    else:
        print("ERROR: failed to regenerate current-state.md", file=sys.stderr)
        return False

    # Auto-run memory consolidate/decay based on raw session count.
    # This enforces the "every 5 sessions consolidate, every 10 sessions
    # decay" cadence that was previously only a manual recommendation.
    _maybe_auto_consolidate_decay()

    return True


def _maybe_auto_consolidate_decay() -> None:
    """Check raw session count and run consolidate/decay if thresholds are met.

    Consolidate every 5 new raw captures, decay every 10.
    Runs memory.py as a subprocess to avoid import coupling.
    """
    memory_script = Path(__file__).parent / "memory.py"
    raw_dir = Path(__file__).parent.parent / ".devin" / "memory" / "raw"
    if not memory_script.exists() or not raw_dir.exists():
        return

    raw_count = len(list(raw_dir.glob("sess-*.md")))
    if raw_count == 0:
        return

    consolidate_interval = 5
    decay_interval = 10

    if raw_count % consolidate_interval == 0:
        print(f"[memory] {raw_count} raw sessions — running consolidate...")
        import subprocess
        result = subprocess.run(
            ["python3", str(memory_script), "consolidate"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            print(f"[memory] consolidate completed")
        else:
            print(f"[memory] consolidate failed: {result.stderr.strip()}", file=sys.stderr)

    if raw_count % decay_interval == 0:
        print(f"[memory] {raw_count} raw sessions — running decay...")
        import subprocess
        result = subprocess.run(
            ["python3", str(memory_script), "decay"],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            print(f"[memory] decay completed")
        else:
            print(f"[memory] decay failed: {result.stderr.strip()}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Session lifecycle tool for the node graph.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # generate-current-state
    gen_parser = sub.add_parser(
        "generate-current-state",
        help="Regenerate current-state.md from trace.md + GRAPH-SPEC.yaml",
    )
    gen_parser.add_argument("--trace", type=Path, default=_TRACE_PATH, help="Path to trace.md")
    gen_parser.add_argument("--graph-spec", type=Path, default=_GRAPH_SPEC_PATH,
                            help="Path to GRAPH-SPEC.yaml")
    gen_parser.add_argument("--output", type=Path, default=_CURRENT_STATE_PATH,
                            help="Output path for current-state.md")

    # archive-trace
    arch_parser = sub.add_parser(
        "archive-trace",
        help="Rotate old session blocks from trace.md into archive files",
    )
    arch_parser.add_argument("--trace", type=Path, default=_TRACE_PATH, help="Path to trace.md")
    arch_parser.add_argument("--archive-dir", type=Path, default=_ARCHIVE_DIR,
                             help="Directory for archive files")
    arch_parser.add_argument("--threshold", type=int, default=3000,
                             help="Line count threshold to trigger archival (default: 3000)")
    arch_parser.add_argument("--keep", type=int, default=5,
                             help="Number of recent sessions to keep in trace.md (default: 5)")

    # close-session
    close_parser = sub.add_parser(
        "close-session",
        help="Append a session block to trace.md and regenerate current-state.md",
    )
    close_parser.add_argument("--block-file", type=Path, help="File containing the session block")
    close_parser.add_argument("--block-stdin", action="store_true",
                              help="Read session block from stdin")
    close_parser.add_argument("--trace", type=Path, default=_TRACE_PATH, help="Path to trace.md")

    args = parser.parse_args()

    if args.command == "generate-current-state":
        lines = generate_current_state(args.trace, args.graph_spec, args.output)
        if lines and lines > 0:
            print(f"Generated {args.output} ({lines} lines)")
            return 0
        return 1

    elif args.command == "archive-trace":
        archive_trace(args.trace, args.archive_dir, args.threshold, args.keep)
        return 0 if True else 1  # None means no archival needed (success)

    elif args.command == "close-session":
        if args.block_file:
            block = args.block_file.read_text()
        elif args.block_stdin:
            block = sys.stdin.read()
        else:
            print("ERROR: must specify --block-file or --block-stdin", file=sys.stderr)
            return 1
        success = close_session(block, args.trace)
        return 0 if success else 1

    return 1


if __name__ == "__main__":
    sys.exit(main())
