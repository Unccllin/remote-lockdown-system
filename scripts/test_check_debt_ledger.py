#!/usr/bin/env python3
"""Tests for scripts/check_debt_ledger.py (S248).

The ledger states every PBL debt item's status twice: a summary table, and a detailed entry
whose blocker justifies it. On 2026-11-05 23 of the 46 items present in both disagreed, with
the table calling items CLOSED that their own entry calls OPEN — a reader trusting the table
would believe twenty-plus items were finished. This guard compares the two and treats the
detailed entry as authoritative.
"""

# pyright: reportMissingImports=false  (pytest lives in the component venv, not
# in the checker's interpreter — the same convention as firmware/PblPkg/test-d205.py)
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_debt_ledger as ledger  # noqa: E402

LEDGER_TEMPLATE = """# Ledger

### D-001 — an item
- **Status**: {detail}

| ID | Description | Status | Type |
|----|-------------|--------|------|
| D-001 | an item | {table} | TEST |
"""


def write(path: Path, text: str) -> Path:
    path.write_text(text)
    return path


@pytest.fixture
def paths(tmp_path, monkeypatch):
    md = tmp_path / "ledger.md"
    baseline = tmp_path / "baseline.txt"
    monkeypatch.setattr(ledger, "LEDGER", md)
    monkeypatch.setattr(ledger, "BASELINE", baseline)
    return md, baseline


def test_parses_both_sources(paths):
    md, _ = paths
    write(md, LEDGER_TEMPLATE.format(detail="OPEN", table="CLOSED"))
    table, detail = ledger.parse_ledger(md.read_text())
    assert table == {"D-001": "CLOSED"}
    assert detail == {"D-001": "OPEN"}


def test_qualifiers_do_not_count_as_drift():
    assert ledger.normalise("CLOSED (with a note)") == "CLOSED"
    assert ledger.normalise("open — blocked") == "OPEN"
    assert ledger.normalise("PARTIAL (2 of 5)") == "PARTIAL"


def test_a_new_mismatch_fails(paths, capsys):
    md, _ = paths  # no baseline file at all
    write(md, LEDGER_TEMPLATE.format(detail="OPEN", table="CLOSED"))

    assert ledger.main([]) == 1
    assert "[NEW] D-001" in capsys.readouterr().out


def test_a_recorded_mismatch_passes(paths):
    md, baseline = paths
    write(md, LEDGER_TEMPLATE.format(detail="OPEN", table="CLOSED"))
    write(baseline, "D-001 detail=OPEN table=CLOSED\n")

    assert ledger.main([]) == 0


def test_a_reconciled_item_makes_its_baseline_line_stale(paths, capsys):
    md, baseline = paths
    # Both sources now say OPEN — reconciled — but the baseline still claims drift.
    write(md, LEDGER_TEMPLATE.format(detail="OPEN", table="OPEN"))
    write(baseline, "D-001 detail=OPEN table=CLOSED\n")

    assert ledger.main([]) == 1
    assert "[STALE BASELINE]" in capsys.readouterr().out


def test_agreement_passes_without_a_baseline(paths):
    md, _ = paths
    write(md, LEDGER_TEMPLATE.format(detail="CLOSED", table="CLOSED"))
    assert ledger.main([]) == 0


def test_unparsable_ledger_exits_2(paths, capsys):
    md, _ = paths
    write(md, "not a ledger at all\n")
    assert ledger.main([]) == 2
    assert "could not parse" in capsys.readouterr().err


def test_update_baseline_rewrites_from_current_state(paths):
    md, baseline = paths
    write(md, LEDGER_TEMPLATE.format(detail="OPEN", table="CLOSED"))
    assert ledger.main(["--update-baseline"]) == 0
    assert "D-001 detail=OPEN table=CLOSED" in baseline.read_text()
    # and the freshly written baseline then passes
    assert ledger.main([]) == 0


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
