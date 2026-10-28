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


def test_script_is_executable():
    # The workflow calls it through `python3`, but every other script in
    # scripts/ is executable; keep the convention.
    mode = SCRIPT.stat().st_mode
    assert mode & 0o111, f"{SCRIPT} is not executable"
