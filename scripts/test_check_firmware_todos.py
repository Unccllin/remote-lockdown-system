"""Tests for scripts/check-firmware-todos.py.

The check has to be strict enough that its green actually means something. The
shell pipeline it replaced accepted any line containing the substring ``C1``,
``C2``, ``REQ``, ``STUB`` or ``Agent`` — so a hex literal, a filename, or the
word "REQuest" satisfied it, and ``C5`` was not accepted at all. These tests
pin the replacement's behaviour in both directions: recognised references pass,
and look-alike substrings do not.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).parent / "check-firmware-todos.py"
REPO_ROOT = Path(__file__).parent.parent


def load_module():
    spec = importlib.util.spec_from_file_location("check_firmware_todos", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_module()


def write_tree(tmp_path: Path, name: str, body: str) -> Path:
    """Create a one-file scan tree and return its root."""
    root = tmp_path / "PblPkg"
    root.mkdir()
    (root / name).write_text(body, encoding="utf-8")
    return root


class TestAcceptedReferences:
    """Every documented reference form must pass."""

    def test_contract_section_with_dot(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO (C2 §5.2): cache write\n")
        assert mod.find_violations(root) == []

    def test_contract_section_plain(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: see C1 §7 steps\n")
        assert mod.find_violations(root) == []

    def test_c5_is_accepted(self, tmp_path):
        # The shell pipeline this replaced never accepted C5 at all.
        root = write_tree(tmp_path, "A.c", "// FIXME (C5 §3): beacon jitter\n")
        assert mod.find_violations(root) == []

    def test_dotted_contract_form(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO C3.4 hostname check\n")
        assert mod.find_violations(root) == []

    def test_numbered_requirement(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO REQ-05 session setup\n")
        assert mod.find_violations(root) == []

    def test_debt_ledger_item(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: ES256 path, see D-205\n")
        assert mod.find_violations(root) == []

    def test_explicit_stub_marker(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: STUB for the network path\n")
        assert mod.find_violations(root) == []

    def test_named_agent_owner(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: Agent B owns this\n")
        assert mod.find_violations(root) == []

    def test_reference_on_the_following_line_of_a_comment_block(self, tmp_path):
        # Deferrals are routinely spelled out over two or three comment lines.
        root = write_tree(
            tmp_path,
            "A.c",
            "  // TODO: implement Ed25519 when BaseCryptLib supports it.\n"
            "  //       Tracked by C1 §1.1 and D-205.\n",
        )
        assert mod.find_violations(root) == []


class TestRejectedLookalikes:
    """Substrings that used to satisfy the regex must not satisfy this one."""

    def test_bare_contract_token_is_not_a_reference(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: because C1 says so\n")
        violations = mod.find_violations(root)
        assert len(violations) == 1

    def test_hex_literal_is_not_a_reference(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: NV attr 0xC1 means nothing\n")
        violations = mod.find_violations(root)
        assert len(violations) == 1

    def test_bare_request_word_is_not_a_reference(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: REQuest path unwritten\n")
        violations = mod.find_violations(root)
        assert len(violations) == 1

    def test_agentless_token_is_not_a_reference(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: agency handling\n")
        violations = mod.find_violations(root)
        assert len(violations) == 1

    def test_reference_far_below_the_marker_does_not_launder_it(self, tmp_path):
        root = write_tree(
            tmp_path,
            "A.c",
            "// TODO: implement this\n"
            "// filler\n"
            "// filler\n"
            "// filler\n"
            "// filler\n"
            "// unrelated: see C1 §7\n",
        )
        violations = mod.find_violations(root)
        assert len(violations) == 1


class TestCoverage:
    """The scan scope must be wider than the shell pipeline's."""

    def test_fixme_is_checked_like_todo(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// FIXME: no reference here\n")
        assert len(mod.find_violations(root)) == 1

    def test_lowercase_marker_is_checked(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// todo: no reference here\n")
        assert len(mod.find_violations(root)) == 1

    def test_headers_are_scanned(self, tmp_path):
        # The shell pipeline only globbed PblApp/*.c, so a header escaped it.
        root = write_tree(tmp_path, "A.h", "// TODO: unwind this, no reference\n")
        assert len(mod.find_violations(root)) == 1

    def test_nested_module_directories_are_scanned(self, tmp_path):
        root = tmp_path / "PblPkg"
        (root / "OtherDxe").mkdir(parents=True)
        (root / "OtherDxe" / "B.c").write_text(
            "// TODO: outside PblApp, no reference\n", encoding="utf-8"
        )
        assert len(mod.find_violations(root)) == 1

    def test_non_source_files_are_ignored(self, tmp_path):
        root = write_tree(tmp_path, "notes.md", "TODO: still no reference\n")
        assert mod.find_violations(root) == []

    def test_violation_reports_real_line_number(self, tmp_path):
        root = write_tree(
            tmp_path, "A.c", "// line one\n// line two\n// TODO: bare marker\n"
        )
        violations = mod.find_violations(root)
        assert len(violations) == 1
        assert violations[0][1] == 3


class TestReport:
    def test_clean_report_is_empty(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// nothing to do\n")
        assert mod.format_report(mod.find_violations(root), root) == ""

    def test_report_names_file_and_line(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: bare marker\n")
        report = mod.format_report(mod.find_violations(root), root)
        assert "A.c:1:" in report
        assert "docs/adr/PBL-DEBT-LEDGER.md" in report

    def test_report_is_pluralised_correctly(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: bare\n")
        report = mod.format_report(mod.find_violations(root), root)
        assert "1 firmware TODO/FIXME marker carry" in report


class TestCli:
    def run(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )

    def test_clean_tree_exits_zero(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO (C1 §7): fine\n")
        result = self.run("--root", str(root))
        assert result.returncode == 0
        assert "OK:" in result.stdout

    def test_violation_exits_one(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: bare\n")
        result = self.run("--root", str(root))
        assert result.returncode == 1
        assert "A.c:1:" in result.stdout

    def test_missing_root_exits_two(self, tmp_path):
        result = self.run("--root", str(tmp_path / "nope"))
        assert result.returncode == 2
        assert "does not exist" in result.stderr

    def test_annotate_emits_escaped_workflow_command(self, tmp_path):
        root = write_tree(tmp_path, "A.c", "// TODO: 100% bare\n")
        result = self.run("--root", str(root), "--annotate")
        assert "::error title=Firmware TODO contract reference::" in result.stdout
        # The annotation body must be percent-escaped or GitHub truncates it
        # at the first newline and the operator sees one line of advice.
        body = result.stdout.split("::error title=", 1)[1]
        assert "%0A" in body
        assert "%25" in body

    def test_real_repository_is_clean(self):
        # The gate that PBL CI runs. If a new firmware deferral lands without a
        # reference, this test fails locally instead of only in CI.
        result = self.run()
        assert result.returncode == 0, result.stdout


def test_script_is_executable():
    assert SCRIPT.stat().st_mode & 0o111


def test_every_script_test_suite_has_a_runner():
    """Every scripts/test_*.py must be runnable by `make test-scripts`.

    The loop in the Makefile executes each file directly, so a suite without a
    ``__main__`` runner imports its tests, runs none, and exits 0. That silently
    cost 44 memory tests (AGENTS.md) and then 13 ci-annotate tests. This test is
    the guard: a new suite that forgets its runner fails here instead of going
    quietly green.
    """
    missing = [
        path.name
        for path in sorted(Path(__file__).parent.glob("test_*.py"))
        if '__name__ == "__main__"' not in path.read_text(encoding="utf-8")
    ]
    assert missing == [], f"suite(s) with no __main__ runner: {missing}"


if __name__ == "__main__":
    # Shared runner; see scripts/script_test_runner.py for why a `__main__`
    # block is mandatory here and why the import is not at module level.
    from script_test_runner import run

    raise SystemExit(run(__file__))
