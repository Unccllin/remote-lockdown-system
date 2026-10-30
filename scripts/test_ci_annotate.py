"""Tests for scripts/ci-annotate.py.

The tool exists because job logs need admin rights while check-run annotations
do not, so the escaping and truncation have to be exactly right: a broken
annotation is indistinguishable from a job that never annotated at all.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "ci-annotate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("ci_annotate", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_module()


class TestEscape:
    def test_escapes_percent_first(self):
        assert mod.escape("100%") == "100%25"

    def test_escapes_carriage_return_and_newline(self):
        assert mod.escape("a\r\nb") == "a%0D%0Ab"

    def test_leaves_colons_and_backslashes_literal(self):
        # A stack trace must stay readable in the annotation.
        assert mod.escape("Error: boom at C:\\x\\y.js:12") == (
            "Error: boom at C:\\x\\y.js:12"
        )

    def test_double_escape_is_not_reintroduced(self):
        # '%' is escaped before '\n', so a literal '%0A' in the input must not
        # become a newline when GitHub unescapes.
        assert mod.escape("%0A") == "%250A"


class TestTail:
    def test_keeps_last_lines_in_order(self):
        text = "\n".join(f"line{i}" for i in range(1, 11))
        assert mod.tail(text, 3) == "line8\nline9\nline10"

    def test_short_input_is_returned_whole(self):
        assert mod.tail("one\ntwo", 10) == "one\ntwo"

    def test_zero_or_negative_lines_yields_empty(self):
        for value in (0, -5):
            assert mod.tail("a\nb", value) == ""


class TestBuildAnnotation:
    def test_produces_single_error_command(self):
        out = mod.build_annotation("boom\nfailed", "pytest")
        assert out.startswith("::error title=pytest::")
        assert "boom%0Afailed" in out
        assert "\n" not in out

    def test_truncates_oversized_tails(self):
        out = mod.build_annotation("x" * (mod.MAX_MESSAGE * 2), "big")
        payload = out.split("::", 2)[2]
        assert len(payload) <= mod.MAX_MESSAGE

    def test_defaults_to_error_level(self):
        assert mod.build_annotation("boom", "t").startswith("::error title=t::")

    def test_warning_level_is_selectable(self):
        # PBL CI surfaces advisory cppcheck output this way: the findings have
        # to be visible on the check run, but they must not fail the job.
        out = mod.build_annotation("style: unused var", "cpp", level="warning")
        assert out.startswith("::warning title=cpp::")
        assert "style: unused var" in out


class TestCli:
    def test_writes_annotation_for_file(self, tmp_path):
        log = tmp_path / "log.txt"
        log.write_text("Tests: 1 failed\n  Error: nope\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(log), "ci-output"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.startswith("::error title=ci-output::")
        assert "Error: nope" in result.stdout

    def test_missing_file_annotates_instead_of_failing(self, tmp_path):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(tmp_path / "absent.log")],
            capture_output=True,
            text=True,
            check=True,  # must exit 0: a diagnostics failure must not mask CI
        )
        assert "::error title=ci-annotate::" in result.stdout

    def test_usage_error_on_no_arguments(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT)], capture_output=True, text=True
        )
        assert result.returncode == 2
        assert "usage:" in result.stderr

    def test_warning_flag_emits_warning_command(self, tmp_path):
        log = tmp_path / "cpp.log"
        log.write_text("App.c:12: style: unused variable\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--warning", str(log), "cppcheck"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert result.stdout.startswith("::warning title=cppcheck::")
        assert "unused variable" in result.stdout

    def test_warning_flag_still_keeps_positional_order(self, tmp_path):
        log = tmp_path / "cpp.log"
        log.write_text("one\ntwo\nthree\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--warning", str(log), "t", "2"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert "two%0Athree" in result.stdout
        assert "one" not in result.stdout

    def test_non_numeric_line_count_is_a_usage_error(self, tmp_path):
        log = tmp_path / "log.txt"
        log.write_text("x\n")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(log), "t", "not-a-number"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 2
        assert "invalid line count" in result.stderr


def test_script_is_executable():
    # The workflow calls it through `python3`, but every other script in
    # scripts/ is executable; keep the convention.
    mode = SCRIPT.stat().st_mode
    assert mode & 0o111, f"{SCRIPT} is not executable"


if __name__ == "__main__":
    # `make test-scripts` runs each scripts/test_*.py directly. Without this
    # block the module imports the tests, runs none of them, and exits 0 — the
    # exact failure AGENTS.md records for test_memory.py. It had recurred here:
    # all 13 tests below were unreachable from `make test-scripts`.
    from script_test_runner import run

    raise SystemExit(run(__file__))
