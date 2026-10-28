"""Tests for graph_assert.py quality assertions (Goodhart's Law defense).

Tests the strengthened I4, I5, I7 assertions that check for structural
quality minimums, not just presence. Each test has a pass case and a fail
case to verify the assertion catches shallow compliance.

Debt items covered:
- D-006: Graph spec + assertion engine — these tests verify the
  strengthened assertions (Q1 Goodhart's Law defense) that were added
  on top of the original I4/I5/I7 invariant checks.
"""

import json
import sys
from pathlib import Path

# Add graph directory to path
_GRAPH_DIR = Path(__file__).resolve().parent.parent.parent / ".devin" / "graph"
sys.path.insert(0, str(_GRAPH_DIR))
from graph_assert import (  # noqa: E402
    GraphViolationError,
    artifact_supports_claim,
    assert_artifact_quality,
    assert_enforcement_path_status,
    assert_rule_zero_quality,
    assert_session_end_quality,
)


class TestI5RuleZeroQuality:
    """I5 strengthened: RULE-ZERO must have >=2 file paths + >=1 Finding/Read line."""

    def test_passes_with_good_rule_zero(self, tmp_path):
        """Good RULE-ZERO: 2+ file paths + Finding line."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "## Session\n"
            "### RULE-ZERO — Understanding logged before code changes\n"
            "- **Read**: `src/main.py` (100 lines)\n"
            "- **Read**: `src/utils.py` (50 lines)\n"
            "- **Finding**: The code uses pattern X\n"
        )
        assert_rule_zero_quality(trace)  # should not raise

    def test_fails_with_no_file_paths(self, tmp_path):
        """Shallow RULE-ZERO: no file path references."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "## Session\n"
            "### RULE-ZERO — Understanding logged before code changes\n"
            "I read the code and understood it.\n"
        )
        try:
            assert_rule_zero_quality(trace)
            raise AssertionError("Should have raised")
        except GraphViolationError as e:
            assert "I5" in str(e)
            assert "file path" in str(e).lower()

    def test_fails_with_only_one_file_path(self, tmp_path):
        """Insufficient RULE-ZERO: only 1 file path."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "## Session\n"
            "### RULE-ZERO — Understanding logged before code changes\n"
            "- **Read**: `src/main.py` (100 lines)\n"
        )
        try:
            assert_rule_zero_quality(trace)
            raise AssertionError("Should have raised")
        except GraphViolationError as e:
            assert "I5" in str(e)
            assert "1" in str(e)

    def test_fails_with_no_finding_line(self, tmp_path):
        """RULE-ZERO with file paths but no Finding/Read line."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "## Session\n"
            "### RULE-ZERO — Understanding logged before code changes\n"
            "- `src/main.py`\n"
            "- `src/utils.py`\n"
        )
        try:
            assert_rule_zero_quality(trace)
            raise AssertionError("Should have raised")
        except GraphViolationError as e:
            assert "I5" in str(e)
            assert "Finding" in str(e) or "Read" in str(e)

    def test_uses_last_rule_zero_entry(self, tmp_path):
        """When multiple RULE-ZERO entries exist, check the last one."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "### RULE-ZERO — Old session\n"
            "- **Read**: `src/old.py`\n"
            "- **Read**: `src/old2.py`\n"
            "- **Finding**: old finding\n"
            "\n---\n\n"
            "### RULE-ZERO — New session\n"
            "- **Read**: `src/new.py`\n"
        )
        try:
            assert_rule_zero_quality(trace)
            raise AssertionError("Should have raised — last entry has only 1 file path")
        except GraphViolationError as e:
            assert "I5" in str(e)
            assert "1" in str(e)


class TestI4SessionEndQuality:
    """I4 strengthened: each session-end section must have >=1 line of content."""

    def test_passes_with_all_sections_populated(self, tmp_path):
        """Good session-end block: all 6 sections have content."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "### Fog cleared\n"
            "- Found the bug in line 42\n"
            "### Fog remaining\n"
            "- Unsure about edge case X\n"
            "### Debt items closed\n"
            "None\n"
            "### Debt items still open\n"
            "None\n"
            "### Blockers\n"
            "None\n"
            "### Next session\n"
            "Fix the bug in line 42\n"
        )
        assert_session_end_quality(trace)  # should not raise

    def test_fails_with_empty_section(self, tmp_path):
        """Shallow session-end: one section has no content."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "### Fog cleared\n"
            "- Found the bug\n"
            "### Fog remaining\n"
            "- Unsure about X\n"
            "### Debt items closed\n"
            "None\n"
            "### Debt items still open\n"
            "None\n"
            "### Blockers\n"
            "\n"
            "### Next session\n"
            "Fix the bug\n"
        )
        try:
            assert_session_end_quality(trace)
            raise AssertionError("Should have raised — Blockers section is empty")
        except GraphViolationError as e:
            assert "I4" in str(e)
            assert "Blockers" in str(e)

    def test_fails_with_missing_section(self, tmp_path):
        """Session-end block missing a required section entirely."""
        trace = tmp_path / "trace.md"
        trace.write_text("### Fog cleared\n- Found the bug\n### Fog remaining\n- Unsure about X\n")
        try:
            assert_session_end_quality(trace)
            raise AssertionError("Should have raised — missing sections")
        except GraphViolationError as e:
            assert "I4" in str(e)

    def test_uses_last_session_block(self, tmp_path):
        """When multiple session-end blocks exist, check the last one."""
        trace = tmp_path / "trace.md"
        trace.write_text(
            "### Fog cleared\n"
            "- Old session found bug\n"
            "### Fog remaining\n"
            "- Old fog\n"
            "### Debt items closed\n"
            "D-001\n"
            "### Debt items still open\n"
            "D-002\n"
            "### Blockers\n"
            "None\n"
            "### Next session\n"
            "Continue work\n"
            "\n---\n\n"
            "### Fog cleared\n"
            "- New session\n"
            "### Fog remaining\n"
            "- New fog\n"
            "### Debt items closed\n"
            "None\n"
            "### Debt items still open\n"
            "None\n"
            "### Blockers\n"
            "\n"
            "### Next session\n"
            "Done\n"
        )
        try:
            assert_session_end_quality(trace)
            raise AssertionError("Should have raised — last Blockers section is empty")
        except GraphViolationError as e:
            assert "I4" in str(e)
            assert "Blockers" in str(e)


class TestI7ArtifactQuality:
    """I7 strengthened: .complete files must have commit hash + test count."""

    def test_passes_with_commit_and_test_count(self, tmp_path):
        """Good .complete file: has commit hash + test count."""
        results = tmp_path / "results"
        results.mkdir()
        (results / "phase-0.complete").write_text(
            "commit: c8b0db1\nartifact: Build verified\ntest_count: 564 tests passing\n"
        )
        assert_artifact_quality(results)  # should not raise

    def test_fails_without_commit_hash(self, tmp_path):
        """Shallow .complete: no commit hash."""
        results = tmp_path / "results"
        results.mkdir()
        (results / "phase-0.complete").write_text("artifact: Build verified\ntests: all pass\n")
        try:
            assert_artifact_quality(results)
            raise AssertionError("Should have raised — no commit hash")
        except GraphViolationError as e:
            assert "I7" in str(e)
            assert "commit hash" in str(e).lower()

    def test_fails_without_test_count(self, tmp_path):
        """Shallow .complete: commit hash but no test count."""
        results = tmp_path / "results"
        results.mkdir()
        (results / "phase-0.complete").write_text("commit: c8b0db1\nartifact: Build verified\n")
        try:
            assert_artifact_quality(results)
            raise AssertionError("Should have raised — no test count")
        except GraphViolationError as e:
            assert "I7" in str(e)
            assert "test count" in str(e).lower()

    def test_fails_with_only_qualitative_tests(self, tmp_path):
        """.complete with 'tests pass' but no digit count — should fail."""
        results = tmp_path / "results"
        results.mkdir()
        (results / "phase-0.complete").write_text("commit: c8b0db1\ntests: all tests pass\n")
        try:
            assert_artifact_quality(results)
            raise AssertionError("Should have raised — no digit-based test count")
        except GraphViolationError as e:
            assert "I7" in str(e)
            assert "test count" in str(e).lower()

    def test_passes_with_multiple_files(self, tmp_path):
        """Multiple .complete files, all with commit + test count."""
        results = tmp_path / "results"
        results.mkdir()
        for i in range(3):
            (results / f"phase-{i}.complete").write_text(
                f"commit: abcdef{i}\ntest_count: 100 tests pass\n"
            )
        assert_artifact_quality(results)  # should not raise

    def test_fails_if_one_file_lacks_quality(self, tmp_path):
        """One file out of many lacks test count — should fail."""
        results = tmp_path / "results"
        results.mkdir()
        (results / "phase-0.complete").write_text("commit: c8b0db1\ntest_count: 100 tests pass\n")
        (results / "phase-1.complete").write_text("commit: bf4bde8\nartifact: No tests run\n")
        try:
            assert_artifact_quality(results)
            raise AssertionError("Should have raised — phase-1 lacks test count")
        except GraphViolationError as e:
            assert "I7" in str(e)
            assert "phase-1" in str(e)


class TestI3ArtifactClaim:
    """I3 strengthened: an artifact reference must contain the claim.

    Before this check existed, `hardware_artifact_ref` only had to be a
    non-empty string. E-BCD was marked `verified-on-hardware` while citing an
    artifact that recorded `E-BCD-01 FAIL` — the graph asserted a hardware
    verification that the cited evidence contradicted.
    """

    def _write(self, tmp_path, name, payload):
        path = tmp_path / name
        path.write_text(json.dumps(payload) if not isinstance(payload, str) else payload)
        return path

    def _legacy(self, status):
        return {"harness_version": "1.0", "results": [{"test_id": "E-BCD-01", "status": status}]}

    def test_pass_in_legacy_schema_supports_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("PASS"))
        ok, reason = artifact_supports_claim("E-BCD", str(art), tmp_path)
        assert ok, reason

    def test_fail_in_legacy_schema_refutes_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("FAIL"))
        ok, reason = artifact_supports_claim("E-BCD", str(art), tmp_path)
        assert not ok
        assert "does not record a PASS" in reason
        assert "FAIL" in reason

    def test_skip_does_not_support_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("SKIP"))
        ok, _ = artifact_supports_claim("E-BCD", str(art), tmp_path)
        assert not ok

    def test_missing_artifact_refutes_claim(self, tmp_path):
        ok, reason = artifact_supports_claim("E-BCD", str(tmp_path / "nope.json"), tmp_path)
        assert not ok
        assert "does not exist" in reason

    def test_ctrf_schema_supports_claim(self, tmp_path):
        art = self._write(
            tmp_path,
            "ctrf.json",
            {"results": {"tests": [{"name": "E-RECOVERY-01", "status": "passed"}]}},
        )
        ok, reason = artifact_supports_claim("E-RECOVERY", str(art), tmp_path)
        assert ok, reason

    def test_ctrf_failed_status_refutes_claim(self, tmp_path):
        art = self._write(
            tmp_path,
            "ctrf.json",
            {"results": {"tests": [{"name": "E-RECOVERY-01", "status": "failed"}]}},
        )
        ok, _ = artifact_supports_claim("E-RECOVERY", str(art), tmp_path)
        assert not ok

    def test_live_agent_schema_supports_claim(self, tmp_path):
        art = self._write(
            tmp_path,
            "live.json",
            {"harness_version": "live-agent-test", "enforcement_paths": {"E-ENCRYPT": "PASS"}},
        )
        ok, reason = artifact_supports_claim("E-ENCRYPT", str(art), tmp_path)
        assert ok, reason

    def test_fragment_names_the_result_inside_the_file(self, tmp_path):
        art = self._write(
            tmp_path,
            "multi.json",
            {
                "results": [
                    {"test_id": "E-ENCRYPT-01", "status": "PASS"},
                    {"test_id": "E-BCD-01", "status": "FAIL"},
                ]
            },
        )
        ok, _ = artifact_supports_claim("E-BCD", f"{art}#E-BCD-01", tmp_path)
        assert not ok
        ok, reason = artifact_supports_claim("E-BCD", f"{art}#E-ENCRYPT-01", tmp_path)
        assert ok, reason

    def test_fragment_absent_from_artifact_refutes_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("PASS"))
        ok, reason = artifact_supports_claim("E-BCD", f"{art}#E-DEADMAN-01", tmp_path)
        assert not ok
        assert "no 'E-DEADMAN-01' result" in reason

    def test_artifact_with_no_result_for_this_path_refutes_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("PASS"))
        ok, reason = artifact_supports_claim("E-DEADMAN", str(art), tmp_path)
        assert not ok
        assert "no result for E-DEADMAN" in reason

    def test_non_json_evidence_requires_the_fragment(self, tmp_path):
        log = tmp_path / "serial.log"
        log.write_text("[OK] Verdict signature verified (ES256)\n")
        ok, reason = artifact_supports_claim("E-ENCRYPT", f"{log}#E-ENCRYPT-01", tmp_path)
        assert not ok
        assert "no 'E-ENCRYPT-01' entry" in reason
        ok, reason = artifact_supports_claim("E-ENCRYPT", str(log), tmp_path)
        assert ok, reason

    def test_unreadable_json_refutes_claim(self, tmp_path):
        art = tmp_path / "broken.json"
        art.write_text("{not json")
        ok, reason = artifact_supports_claim("E-BCD", str(art), tmp_path)
        assert not ok
        assert "not readable JSON" in reason

    def test_assert_enforcement_path_status_raises_on_contradicted_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("FAIL"))
        graph = {
            "enforcement_paths": [
                {
                    "id": "E-BCD",
                    "status": "verified-on-hardware",
                    "hardware_artifact_ref": str(art),
                }
            ],
            "debt_items": [],
        }
        try:
            assert_enforcement_path_status(graph)
        except GraphViolationError as exc:
            assert "hardware_artifact_must_support_claim" in str(exc)
            assert "E-BCD" in str(exc)
        else:  # pragma: no cover — the assertion must fire
            raise AssertionError("contradicted hardware claim was accepted")

    def test_assert_enforcement_path_status_accepts_supported_claim(self, tmp_path):
        art = self._write(tmp_path, "hw.json", self._legacy("PASS"))
        graph = {
            "enforcement_paths": [
                {
                    "id": "E-BCD",
                    "status": "verified-on-hardware",
                    "hardware_artifact_ref": str(art),
                }
            ],
            "debt_items": [],
        }
        assert_enforcement_path_status(graph)  # must not raise

    def test_demoted_path_may_still_cite_its_failed_attempt(self, tmp_path):
        """A demoted path keeps the ref as evidence-of-attempt; no PASS required."""
        art = self._write(tmp_path, "hw.json", self._legacy("FAIL"))
        graph = {
            "enforcement_paths": [
                {
                    "id": "E-BCD",
                    "status": "verified-in-unit-test",
                    "hardware_artifact_ref": str(art),
                }
            ],
            "debt_items": [],
        }
        assert_enforcement_path_status(graph)  # must not raise
