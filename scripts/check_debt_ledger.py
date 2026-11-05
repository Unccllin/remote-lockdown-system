#!/usr/bin/env python3
"""Check that docs/adr/PBL-DEBT-LEDGER.md agrees with itself.

Why this exists
---------------
The ledger carries the same information twice: a **status table** near the bottom, and a
**detailed entry** per item with the blocker text that justifies the status. They drifted:
on 2026-11-05, 23 of the 46 items that appear in both places disagreed — the table calling
items CLOSED that their own entry calls OPEN, and one (D-133) the reverse. A reader trusting
the table would believe twenty-plus items were finished, while the entries that explain *why
they are not* sat a few hundred lines above.

The detailed entry wins, because it carries evidence and a named blocker; the table is the
part that rots. This check therefore compares the two and reports every disagreement.

Exit codes:
  0  no NEW mismatches (recorded ones are in the baseline)
  1  a mismatch that is not in the baseline — fix the ledger or record it deliberately
  2  the ledger could not be parsed (structure changed)

Baseline: .devin/graph/debt-ledger-mismatches.txt — one `D-xxx detail=OPEN table=CLOSED`
line per known disagreement, with the reason. It is shrink-only: entries disappear as items
are reconciled, and a stale entry (no longer mismatched) is reported so the baseline keeps
telling the truth.

Usage:
    python3 scripts/check_debt_ledger.py
    python3 scripts/check_debt_ledger.py --update-baseline   # after reconciling an item
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

LEDGER = pathlib.Path("docs/adr/PBL-DEBT-LEDGER.md")
BASELINE = pathlib.Path(".devin/graph/debt-ledger-mismatches.txt")


def parse_ledger(text: str) -> tuple[dict[str, str], dict[str, str]]:
    """Return (table statuses, detailed statuses) keyed by item id."""
    table: dict[str, str] = {}
    for m in re.finditer(r"^\|\s*(D-\d+)\s*\|([^|]*)\|([^|]*)\|", text, re.M):
        table[m.group(1)] = m.group(3).strip()

    detail: dict[str, str] = {}
    for m in re.finditer(r"^###\s*(D-\d+)\s*—[^\n]*\n(.*?)(?=^###\s*D-|\Z)", text, re.M | re.S):
        status = re.search(r"\*\*Status\*\*:\s*([^\n(]+)", m.group(2))
        if status:
            detail[m.group(1)] = status.group(1).strip()
    return table, detail


def normalise(value: str) -> str:
    """Reduce a status to OPEN / CLOSED / PARTIAL so qualifiers do not count as drift."""
    upper = value.upper()
    if upper.startswith("CLOSED"):
        return "CLOSED"
    if upper.startswith("OPEN"):
        return "OPEN"
    if upper.startswith("PARTIAL"):
        return "PARTIAL"
    return upper.split()[0] if upper else "?"


def find_mismatches(table: dict[str, str], detail: dict[str, str]) -> list[str]:
    out = []
    for item in sorted(set(table) & set(detail)):
        if normalise(table[item]) != normalise(detail[item]):
            out.append(f"{item} detail={normalise(detail[item])} table={normalise(table[item])}")
    return out


def load_baseline() -> list[str]:
    if not BASELINE.exists():
        return []
    entries = []
    for line in BASELINE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entries.append(line)
    return entries


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check the PBL debt ledger agrees with itself")
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="rewrite the baseline from the current mismatches",
    )
    args = parser.parse_args(argv)

    if not LEDGER.exists():
        print(f"ERROR: {LEDGER} not found", file=sys.stderr)
        return 2
    table, detail = parse_ledger(LEDGER.read_text())
    if not table or not detail:
        print(
            f"ERROR: could not parse {LEDGER} (table rows: {len(table)}, entries: {len(detail)})",
            file=sys.stderr,
        )
        return 2

    current = find_mismatches(table, detail)
    known = load_baseline()

    if args.update_baseline:
        header = [
            "# Known disagreements between the PBL debt ledger's summary table and its",
            "# detailed entries. The detailed entry is authoritative: it carries the evidence",
            "# and the named blocker, while the table is the part that rots.",
            "#",
            "# Shrink-only. When an item is reconciled, delete its line here — the check reports",
            "# baseline entries that no longer apply, so this file cannot quietly overstate the",
            "# drift either. Regenerate with: python3 scripts/check_debt_ledger.py --update-baseline",
            "",
        ]
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text("\n".join(header + current) + "\n")
        print(f"baseline written: {len(current)} known mismatch(es) -> {BASELINE}")
        return 0

    new = [m for m in current if m not in known]
    stale = [k for k in known if k not in current]

    for entry in new:
        print(f"  [NEW] {entry}")
    for entry in stale:
        print(f"  [STALE BASELINE] {entry} (reconciled — delete this baseline line)")

    print(
        f"\n  mismatches now: {len(current)} | recorded: {len(known)} | new: {len(new)} | "
        f"stale baseline: {len(stale)}"
    )
    # Nothing new and nothing stale is the pass condition — including the case of no
    # mismatches at all, which the first version of this returned as a failure.
    return 0 if not new and not stale else 1


if __name__ == "__main__":
    raise SystemExit(main())
