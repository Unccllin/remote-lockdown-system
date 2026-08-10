"""D-003: Unit tests for the hardware test harness.

These tests verify the harness logic (environment detection, test result
tracking, artifact generation) without requiring real Windows/HP hardware.
The actual enforcement path tests are skipped on non-Windows platforms.
"""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Add agent dir to path
_AGENT_DIR = Path(__file__).parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

import hw_test_harness  # noqa: E402

# ---------------------------------------------------------------------------
# Environment detection tests
# ---------------------------------------------------------------------------


class TestDetectEnvironment:
    def test_detect_environment_non_windows(self):
        """detect_environment returns platform=Linux on Linux."""
        with patch.object(hw_test_harness.platform, "system", return_value="Linux"):
            env = hw_test_harness.detect_environment()
        assert env["platform"] == "Linux"
        assert env["is_hp"] is False
        assert env["hp_model"] is None
        assert env["is_admin"] is False

    def test_detect_environment_includes_python_version(self):
        """detect_environment includes the Python version."""
        env = hw_test_harness.detect_environment()
        assert "python_version" in env
        assert "3." in env["python_version"]


# ---------------------------------------------------------------------------
# TestResult tests
# ---------------------------------------------------------------------------


class TestTestResult:
    def test_test_result_initial_state(self):
        result = hw_test_harness.TestResult("E-TEST-01", "E-TEST", "Test name")
        assert result.test_id == "E-TEST-01"
        assert result.enforcement_path == "E-TEST"
        assert result.name == "Test name"
        assert result.status == "SKIP"
        assert result.duration_ms == 0
        assert result.error is None

    def test_test_result_finish_pass(self):
        result = hw_test_harness.TestResult("E-TEST-01", "E-TEST", "Test name")
        result.start()
        result.finish("PASS", "All good")
        d = result.to_dict()
        assert d["status"] == "PASS"
        assert d["detail"] == "All good"
        assert d["error"] is None
        assert d["duration_ms"] >= 0

    def test_test_result_finish_fail(self):
        result = hw_test_harness.TestResult("E-TEST-01", "E-TEST", "Test name")
        result.start()
        result.finish("FAIL", "Something went wrong", "error details")
        d = result.to_dict()
        assert d["status"] == "FAIL"
        assert d["error"] == "error details"


# ---------------------------------------------------------------------------
# Harness run tests
# ---------------------------------------------------------------------------


class TestRunHarness:
    def test_run_harness_dry_run_skips_all(self):
        """Dry run should skip all tests and generate artifact."""
        artifact = hw_test_harness.run_harness(dry_run=True)
        assert artifact["harness_version"] == "1.0"
        assert "timestamp" in artifact
        assert "environment" in artifact
        assert "results" in artifact
        assert "summary" in artifact
        assert artifact["summary"]["total"] == 5
        # On Linux, all should be skipped (except encrypt which is dry-run skipped)
        assert artifact["summary"]["passed"] == 0
        assert artifact["summary"]["failed"] == 0

    def test_run_harness_encrypt_passes_on_linux(self):
        """The encrypt test should pass on Linux (Fernet + filesystem)."""
        artifact = hw_test_harness.run_harness(only="encrypt")
        assert artifact["summary"]["total"] == 1
        assert artifact["summary"]["passed"] == 1
        assert artifact["results"][0]["test_id"] == "E-ENCRYPT-01"
        assert artifact["results"][0]["status"] == "PASS"

    def test_run_harness_lock_screen_skipped_on_linux(self):
        """Lock screen test should be skipped on Linux."""
        artifact = hw_test_harness.run_harness(only="lock-screen")
        assert artifact["summary"]["total"] == 1
        assert artifact["summary"]["skipped"] == 1
        assert "Not Windows" in artifact["results"][0]["detail"]

    def test_run_harness_bcd_skipped_on_linux(self):
        """BCD lockdown test should be skipped on Linux."""
        artifact = hw_test_harness.run_harness(only="bcd")
        assert artifact["summary"]["skipped"] == 1

    def test_run_harness_hp_uefi_skipped_on_linux(self):
        """HP UEFI test should be skipped on Linux."""
        artifact = hw_test_harness.run_harness(only="hp-uefi")
        assert artifact["summary"]["skipped"] == 1

    def test_run_harness_artifact_written_to_file(self, tmp_path):
        """Artifact should be written to the specified path."""
        artifact_path = tmp_path / "artifact.json"
        hw_test_harness.run_harness(dry_run=True, artifact_path=str(artifact_path))
        assert artifact_path.exists()
        data = json.loads(artifact_path.read_text())
        assert data["harness_version"] == "1.0"
        assert "results" in data

    def test_run_harness_unknown_test_exits(self):
        """Unknown test name should cause exit."""
        with pytest.raises(SystemExit) as exc_info:
            hw_test_harness.run_harness(only="nonexistent")
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# Test registry tests
# ---------------------------------------------------------------------------


class TestTestRegistry:
    def test_all_tests_defined(self):
        """All 5 enforcement path tests should be registered."""
        test_names = [t[0] for t in hw_test_harness.ALL_TESTS]
        assert "encrypt" in test_names
        assert "lock-screen" in test_names
        assert "guardian" in test_names
        assert "bcd" in test_names
        assert "hp-uefi" in test_names
        assert len(hw_test_harness.ALL_TESTS) == 5

    def test_each_test_has_callable(self):
        """Each test entry should have a callable function."""
        for name, fn in hw_test_harness.ALL_TESTS:
            assert callable(fn), f"Test {name} function is not callable"
