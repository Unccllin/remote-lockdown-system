#!/usr/bin/env python3
"""Fail when a firmware TODO/FIXME carries no traceability reference.

Why this exists
---------------
`PBL CI` used to run this check as an inline shell pipeline:

    ! grep -rn "TODO" firmware/PblPkg/PblApp/*.c | \
      grep -v "C1\\|C2\\|C3\\|C4\\|REQ\\|STUB\\|Agent" || { ... exit 1; }

That check was the *only* reason the Static analysis job was red, and it was
wrong in four ways that all pointed the same direction — it reported a problem
it could not describe, and it accepted evidence it should not:

1. **It could not say why.** The failure surfaced as a job name in the Actions
   UI with no line numbers, and PBL CI did not annotate. Nothing in the
   repository could reproduce the verdict locally either, because the logic
   lived inside a YAML `run:` block. A red job meant "somewhere in PblApp/".
2. **The exclusion was a substring match, not a reference match.** Any
   occurrence of `C1`, `C2`, `C3`, `C4`, `REQ`, `STUB` or `Agent` anywhere in
   the line satisfied it — including a filename, a hex literal like `0xC1`, or
   the word "REQuest". C5 was missing entirely even though
   `docs/adr/PBL-C5-Covert-Tracking.md` exists.
3. **It only read `PblApp/*.c`.** `firmware/PblPkg/PblPersistDxe/` and every
   header were outside the gate, so a TODO added there passed silently.
4. **It only matched uppercase `TODO`** although the step was named
   "TODO/FIXME", so `FIXME:` was never checked.

The rule it now enforces: a deliberate deferral in firmware must name where
the requirement comes from, so the debt is findable from either direction —
from the code to the contract, and from the contract back to the code. An
accepted reference is a contract section (`C1 §5`, `C3 §4.1`), a numbered
requirement (`REQ-05`), a debt item (`D-205`), or an explicit `STUB`/`Agent X`
ownership marker.

Usage:
    scripts/check-firmware-todos.py                 # repo default scope
    scripts/check-firmware-todos.py --root other/   # alternate tree (tests)
    scripts/check-firmware-todos.py --annotate      # GitHub Actions ::error::
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DEFAULT_ROOT = "firmware/PblPkg"

#: Files that can contain firmware source worth gating.
SOURCE_SUFFIXES = (".c", ".h")

#: The deferral markers themselves. `FIXME` is included because the CI step
#: always claimed to check it; case-insensitive because that is how people
#: actually type it.
MARKER_RE = re.compile(r"\b(TODO|FIXME|XXX)\b", re.IGNORECASE)

#: Evidence that a deferral is traceable. Each alternative is anchored to a
#: real identifier shape so a hex literal or a filename cannot satisfy it:
#:
#:   C1 §5        contract section          (docs/adr/PBL-C1-*.md)
#:   C3.4         contract section, dotted
#:   REQ-05       numbered requirement      (PBL-C2 §3 is "REQ-05")
#:   D-205        debt ledger item          (docs/adr/PBL-DEBT-LEDGER.md)
#:   STUB         explicit placeholder marker
#:   Agent B      named owner of the work
REFERENCE_RE = re.compile(
    r"(?:"
    r"\bC[1-5]\s*§\s*\d"          # C1 §5, C2 §5.2
    r"|\bC[1-5]\.\d"              # C3.4
    r"|\bREQ-\d"                  # REQ-05
    r"|\bD-\d{3}\b"               # D-205
    r"|\bSTUB\b"                  # explicit stub marker
    r"|\bAgent\s+[A-Z]\b"         # Agent A..E
    r")"
)


def iter_sources(root: Path) -> list[Path]:
    """Return every gateable source file under *root*, deterministically."""
    if root.is_file():
        return [root]
    if not root.is_dir():
        return []
    files = [
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix in SOURCE_SUFFIXES
    ]
    return sorted(files)


def find_violations(root: Path) -> list[tuple[Path, int, str]]:
    """Return ``(path, lineno, line)`` for each marker without a reference.

    A marker line and the two lines that follow it are searched for the
    reference, because a deferral is routinely spread over a comment block::

        // TODO: Implement Ed25519 verification when BaseCryptLib adds
        //       support. Tracked by C1 §1.1.

    without letting a reference from an *unrelated* later comment launder it —
    the window is deliberately small.
    """
    violations: list[tuple[Path, int, str]] = []
    for path in iter_sources(root):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:  # pragma: no cover - unreadable file
            print(f"warning: cannot read {path}: {exc}", file=sys.stderr)
            continue
        lines = text.splitlines()
        for index, line in enumerate(lines):
            if not MARKER_RE.search(line):
                continue
            window = "\n".join(lines[index : index + 3])
            if REFERENCE_RE.search(window):
                continue
            violations.append((path, index + 1, line.strip()))
    return violations


def format_report(violations: list[tuple[Path, int, str]], root: Path) -> str:
    """Render the human/CI-readable failure message."""
    if not violations:
        return ""
    plural = "s" if len(violations) != 1 else ""
    out = [
        f"ERROR: {len(violations)} firmware TODO/FIXME marker{plural} "
        f"carry no traceability reference.",
        "",
        "Every deferral must name its source so the debt is findable from",
        "either direction. Accepted forms: C1-C5 §<section>, C<n>.<section>,",
        "REQ-<n>, D-<nnn>, STUB, Agent <A-E>.",
        "",
        f"Scanned: {root} (*.c, *.h)",
        "",
    ]
    for path, lineno, line in violations:
        out.append(f"  {path}:{lineno}: {line}")
    out += [
        "",
        "Contracts: docs/adr/PBL-C1-LockVerdict.md .. PBL-C5-Covert-Tracking.md",
        "Debt ledger: docs/adr/PBL-DEBT-LEDGER.md",
    ]
    return "\n".join(out)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Fail when a firmware TODO/FIXME has no contract reference."
    )
    parser.add_argument(
        "--root",
        default=DEFAULT_ROOT,
        help=f"file or directory to scan (default: {DEFAULT_ROOT})",
    )
    parser.add_argument(
        "--annotate",
        action="store_true",
        help="also emit a GitHub Actions ::error:: annotation",
    )
    args = parser.parse_args(argv[1:])

    root = Path(args.root)
    if not root.exists():
        print(f"ERROR: scan root does not exist: {root}", file=sys.stderr)
        return 2

    violations = find_violations(root)
    report = format_report(violations, root)
    if not report:
        print(f"OK: no untraceable TODO/FIXME markers under {root}")
        return 0

    print(report)
    if args.annotate:
        escaped = report.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error title=Firmware TODO contract reference::{escaped}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
