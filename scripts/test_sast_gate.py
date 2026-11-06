"""Tests for scripts/sast-gate.py.

The gate exists because the previous policy ("fail on ERROR only") left 40 WARNING
findings printed on every run and acted on by nobody — a summary line nobody reads.
These tests pin both directions of the replacement policy:

* a finding with no reviewed entry fails the build, and
* an entry that no longer describes the code fails the build too,

so "expected" always points at a line someone actually looked at. Each test drives
the real CLI in a temporary tree, because the exit code is the contract CI depends
on and a unit-level call would not prove the argument handling works.
"""

import importlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

# pytest lives in agent/.venv, not on this interpreter's path, so a top-level
# `import pytest` is unresolvable when the suite is read by a static analyser —
# the same reason scripts/test_cross_surface_contract.py imports it this way.
pytest: Any = importlib.import_module("pytest")

SCRIPT = Path(__file__).resolve().parent / "sast-gate.py"
REPO_ROOT = SCRIPT.parent.parent

RULE_PATH = (
    "javascript.lang.security.audit.path-traversal."
    "path-join-resolve-traversal.path-join-resolve-traversal"
)
RULE_UTIL = "python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected"
LONG_REASON = "Reviewed: the URL is a literal localhost constant in the lab harness."


def run_gate(report, tree, exceptions, *extra):
    """Write both inputs, run the gate, return (exit code, stdout+stderr)."""
    report_path = tree / "semgrep.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    exceptions_path = tree / "exceptions.json"
    exceptions_path.write_text(json.dumps({"exceptions": exceptions}), encoding="utf-8")
    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            str(report_path),
            "--repo-root",
            str(tree),
            "--exceptions",
            str(exceptions_path),
            *extra,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stdout + proc.stderr


def finding(rule, path, line, severity="WARNING"):
    return {
        "check_id": rule,
        "path": path,
        "start": {"line": line, "col": 1},
        "extra": {"severity": severity},
    }


def entry(rule, path, match, occurrence=1, **overrides):
    data = {
        "rule": rule,
        "path": path,
        "match": match,
        "occurrence": occurrence,
        "disposition": "false-positive",
        "reason": LONG_REASON,
        "reviewed": "S251",
    }
    data.update(overrides)
    return data


@pytest.fixture()
def tree(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.js").write_text(
        "const a = 1;\nconst b = path.join(dir, name);\n", encoding="utf-8"
    )
    return tmp_path


LINE = "const b = path.join(dir, name);"


class TestGating:
    def test_clean_report_passes(self, tree):
        code, out = run_gate({"results": []}, tree, [])
        assert code == 0, out
        assert "every finding is either fixed or carries a reviewed reason" in out

    def test_unclassified_warning_fails(self, tree):
        code, out = run_gate({"results": [finding(RULE_PATH, "src/app.js", 2)]}, tree, [])
        assert code == 1, out
        # The message has to name the state and the next action, or the next agent
        # re-learns this from scratch.
        assert "1 finding(s) are unclassified" in out
        assert "sast-exceptions.json" in out
        assert "src/app.js:2" in out

    def test_error_finding_fails_without_any_exception(self, tree):
        code, out = run_gate(
            {"results": [finding(RULE_PATH, "src/app.js", 2, severity="ERROR")]}, tree, []
        )
        assert code == 1, out
        assert "ERROR is not exceptionable" in out

    def test_error_finding_cannot_be_excepted(self, tree):
        exceptions = [entry(RULE_PATH, "src/app.js", LINE)]
        code, out = run_gate(
            {"results": [finding(RULE_PATH, "src/app.js", 2, severity="ERROR")]},
            tree,
            exceptions,
        )
        assert code == 1, out
        assert "cannot cover" in out

    def test_lenient_reports_but_does_not_fail(self, tree):
        code, out = run_gate(
            {"results": [finding(RULE_PATH, "src/app.js", 2, severity="ERROR")]},
            tree,
            [],
            "--lenient",
        )
        assert code == 0, out
        assert "lenient" in out


class TestExceptions:
    def test_reviewed_warning_passes(self, tree):
        exceptions = [entry(RULE_PATH, "src/app.js", LINE, disposition="accepted-risk")]
        code, out = run_gate({"results": [finding(RULE_PATH, "src/app.js", 2)]}, tree, exceptions)
        assert code == 0, out
        assert "accepted-risk" in out

    def test_entry_matching_nothing_fails(self, tree):
        # A fixed finding must lose its entry; otherwise the file accumulates
        # decisions nobody is making any more.
        exceptions = [entry(RULE_PATH, "src/app.js", LINE)]
        code, out = run_gate({"results": []}, tree, exceptions)
        assert code == 1, out
        assert "match no finding" in out

    def test_changed_line_invalidates_the_exception(self, tree):
        exceptions = [entry(RULE_PATH, "src/app.js", LINE)]
        (tree / "src" / "app.js").write_text(
            "const a = 1;\nconst b = path.join(dir, req.query.name);\n", encoding="utf-8"
        )
        code, out = run_gate({"results": [finding(RULE_PATH, "src/app.js", 2)]}, tree, exceptions)
        assert code == 1, out
        assert "unclassified" in out

    def test_line_shift_keeps_the_exception(self, tree):
        # Moving code is not a change of decision: the key is the line text, not
        # the line number.
        exceptions = [entry(RULE_PATH, "src/app.js", LINE)]
        (tree / "src" / "app.js").write_text(
            "// a new comment\n\n\nconst a = 1;\nconst b = path.join(dir, name);\n",
            encoding="utf-8",
        )
        code, out = run_gate({"results": [finding(RULE_PATH, "src/app.js", 5)]}, tree, exceptions)
        assert code == 0, out

    def test_duplicate_flagged_lines_need_distinct_occurrences(self, tree):
        (tree / "src" / "app.js").write_text(
            "const b = path.join(dir, name);\nconst c = 1;\nconst b = path.join(dir, name);\n",
            encoding="utf-8",
        )
        two = [finding(RULE_PATH, "src/app.js", 1), finding(RULE_PATH, "src/app.js", 3)]
        only_first = [entry(RULE_PATH, "src/app.js", LINE, occurrence=1)]
        code, out = run_gate({"results": two}, tree, only_first)
        assert code == 1, out
        assert "1 finding(s) are unclassified" in out

        both = [
            entry(RULE_PATH, "src/app.js", LINE, occurrence=1),
            entry(RULE_PATH, "src/app.js", LINE, occurrence=2),
        ]
        code, out = run_gate({"results": two}, tree, both)
        assert code == 0, out

    def test_entry_for_a_different_rule_does_not_cover(self, tree):
        exceptions = [entry(RULE_UTIL, "src/app.js", LINE)]
        code, out = run_gate({"results": [finding(RULE_PATH, "src/app.js", 2)]}, tree, exceptions)
        assert code == 1, out

    def test_unreadable_source_line_cannot_be_excepted(self, tree):
        exceptions = [entry(RULE_PATH, "src/missing.js", "whatever")]
        code, out = run_gate({"results": [finding(RULE_PATH, "src/missing.js", 2)]}, tree, exceptions)
        assert code == 1, out
        assert "unclassified" in out


class TestExceptionsFileValidation:
    @pytest.mark.parametrize(
        "overrides,expected",
        [
            ({"reason": ""}, "missing reason"),
            ({"disposition": "whatever"}, "expected one of"),
            ({"reason": "too short"}, "too short to review"),
        ],
    )
    def test_invalid_entry_is_a_usage_error(self, tree, overrides, expected):
        exceptions = [entry(RULE_PATH, "src/app.js", LINE, **overrides)]
        code, out = run_gate({"results": []}, tree, exceptions)
        assert code == 2, out
        assert expected in out

    def test_duplicate_entries_are_a_usage_error(self, tree):
        exceptions = [entry(RULE_PATH, "src/app.js", LINE), entry(RULE_PATH, "src/app.js", LINE)]
        code, out = run_gate({"results": []}, tree, exceptions)
        assert code == 2, out
        assert "duplicates" in out

    def test_unreadable_report_is_a_usage_error(self, tmp_path):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(tmp_path / "absent.json")],
            capture_output=True,
            text=True,
            check=False,
        )
        assert proc.returncode == 2
        assert "cannot read" in proc.stdout + proc.stderr


class TestRepositoryExceptions:
    """The committed exception file must stay valid and stay attached to real code."""

    def test_committed_file_is_valid(self):
        spec = importlib.util.spec_from_file_location("sast_gate", SCRIPT)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        entries, problems = module.load_exceptions(SCRIPT.parent / "sast-exceptions.json")
        assert problems == []
        assert entries, "the repository has findings; an empty exception file is suspicious"

    def test_every_entry_match_still_exists_in_its_file(self):
        data = json.loads((SCRIPT.parent / "sast-exceptions.json").read_text(encoding="utf-8"))
        missing = []
        for item in data["exceptions"]:
            path = REPO_ROOT / item["path"]
            if not path.exists():
                missing.append(f"{item['path']} does not exist")
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if item["match"] not in text:
                missing.append(f"{item['path']}: match text not found: {item['match'][:60]}")
        assert missing == [], "\n".join(missing)

    def test_every_entry_names_a_rule_and_a_reviewer(self):
        data = json.loads((SCRIPT.parent / "sast-exceptions.json").read_text(encoding="utf-8"))
        for item in data["exceptions"]:
            assert "." in item["rule"], item
            assert item["reviewed"].startswith("S"), item


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
