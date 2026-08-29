"""D-003: Unit tests for the hardware test harness v2.0.

These tests verify the harness logic (environment detection, test result
tracking, artifact generation, tri-mode, tag filtering, service gating)
without requiring real Windows/HP hardware. The actual enforcement path
tests are skipped on non-Windows platforms.
"""

import json
import sys
from pathlib import Path
from unittest.mock import patch

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

    def test_detect_environment_includes_agent_hash(self):
        """v2.0: detect_environment includes agent_binary_hash."""
        env = hw_test_harness.detect_environment()
        assert "agent_binary_hash" in env

    def test_detect_environment_includes_hostname(self):
        """v2.0: detect_environment includes hostname."""
        env = hw_test_harness.detect_environment()
        assert "hostname" in env


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

    def test_test_result_ctrf_format(self):
        """v2.0: TestResult can convert to CTRF format."""
        result = hw_test_harness.TestResult("E-TEST-01", "E-TEST", "Test name")
        result.start()
        result.finish("PASS", "All good")
        ctrf = result.to_ctrf()
        assert ctrf["name"] == "E-TEST-01"
        assert ctrf["status"] == "passed"
        assert ctrf["duration"] >= 0
        assert ctrf["extra"]["enforcement_path"] == "E-TEST"

    def test_test_result_evidence_capture(self):
        """v2.0: TestResult supports evidence before/after."""
        result = hw_test_harness.TestResult("E-TEST-01", "E-TEST", "Test name")
        result.evidence_before = {"label": "before", "files": {}}
        result.evidence_after = {"label": "after", "files": {}}
        d = result.to_dict()
        assert d["evidence_before"] is not None
        assert d["evidence_after"] is not None


# ---------------------------------------------------------------------------
# Pattern tests (v2.0 features)
# ---------------------------------------------------------------------------


class TestPatterns:
    def test_capture_state_returns_dict(self):
        """Pattern 11: capture_state returns a dict with label and timestamp."""
        state = hw_test_harness.capture_state("test-label")
        assert state["label"] == "test-label"
        assert "timestamp" in state
        assert "files" in state

    def test_capture_state_with_files(self, tmp_path):
        """Pattern 11: capture_state records file sizes and hashes."""
        (tmp_path / "test.txt").write_text("test content")
        state = hw_test_harness.capture_state("test", [tmp_path / "test.txt"])
        assert str(tmp_path / "test.txt") in state["files"]
        assert state["files"][str(tmp_path / "test.txt")]["size"] == 12
        assert "sha256" in state["files"][str(tmp_path / "test.txt")]

    def test_rollback_context(self):
        """Pattern 12: RollbackContext captures and restores."""
        captured = []
        restored = []

        def capture_fn():
            captured.append(True)
            return {"state": "before"}

        def restore_fn(state):
            restored.append(state)

        with hw_test_harness.RollbackContext("test", capture_fn, restore_fn) as rb:
            assert rb.before == {"state": "before"}

        # capture_fn is called twice: once on enter (before), once on exit (after)
        assert len(captured) == 2
        assert len(restored) == 1
        assert restored[0] == {"state": "before"}

    def test_compute_agent_hash_returns_string(self):
        """Pattern 4: compute_agent_hash returns a hash string."""
        h = hw_test_harness.compute_agent_hash()
        # On Linux, it hashes agent.py source — should return a hex string
        if h is not None:
            assert len(h) == 64  # SHA-256 hex
            assert all(c in "0123456789abcdef" for c in h)

    def test_check_services_windows(self):
        """Pattern 2: check_services returns availability dict."""
        env = {"platform": "Windows", "is_hp": True, "is_admin": True, "tpm_present": True}
        svc = hw_test_harness.check_services(["hp", "admin", "windows"], env)
        assert svc["hp"] is True
        assert svc["admin"] is True
        assert svc["windows"] is True

    def test_check_services_missing(self):
        """Pattern 2: check_services detects missing services."""
        env = {"platform": "Linux", "is_hp": False, "is_admin": False, "tpm_present": None}
        svc = hw_test_harness.check_services(["hp", "admin", "windows"], env)
        assert svc["hp"] is False
        assert svc["admin"] is False
        assert svc["windows"] is False


# ---------------------------------------------------------------------------
# Harness run tests (v2.0 API)
# ---------------------------------------------------------------------------


class TestRunHarness:
    def test_run_harness_dry_run_skips_all(self):
        """Dry run should skip all tests and generate artifact."""
        artifact = hw_test_harness.run_harness(mode="dry-run", fmt="legacy")
        assert artifact["harness_version"] == "2.0"
        assert "timestamp" in artifact
        assert "environment" in artifact
        assert "results" in artifact
        assert "summary" in artifact
        assert artifact["summary"]["total"] == 12
        # On Linux, all should be skipped
        assert artifact["summary"]["passed"] == 0
        assert artifact["summary"]["failed"] == 0

    def test_run_harness_encrypt_passes_on_linux(self):
        """The encrypt test should pass on Linux (Fernet + filesystem)."""
        artifact = hw_test_harness.run_harness(mode="simulate", tags=["E-ENCRYPT"], fmt="legacy")
        assert artifact["summary"]["total"] == 1
        assert artifact["summary"]["passed"] == 1
        assert artifact["results"][0]["test_id"] == "E-ENCRYPT-01"
        assert artifact["results"][0]["status"] == "PASS"

    def test_run_harness_lock_screen_skipped_on_linux(self):
        """Lock screen test should be skipped on Linux."""
        artifact = hw_test_harness.run_harness(
            mode="simulate", tags=["E-LOCK-SCREEN"], fmt="legacy"
        )
        assert artifact["summary"]["total"] == 1
        assert artifact["summary"]["skipped"] == 1
        assert "Not Windows" in artifact["results"][0]["detail"]

    def test_run_harness_bcd_skipped_on_linux(self):
        """BCD lockdown test should be skipped on Linux (no admin)."""
        artifact = hw_test_harness.run_harness(mode="simulate", tags=["E-BCD"], fmt="legacy")
        assert artifact["summary"]["skipped"] == 1

    def test_run_harness_hp_uefi_skipped_on_linux(self):
        """HP UEFI test should be skipped on Linux."""
        artifact = hw_test_harness.run_harness(mode="simulate", tags=["E-HP-UEFI"], fmt="legacy")
        assert artifact["summary"]["skipped"] == 1

    def test_run_harness_artifact_written_to_file(self, tmp_path):
        """Artifact should be written to the specified path."""
        artifact_path = tmp_path / "artifact.json"
        hw_test_harness.run_harness(mode="dry-run", artifact_path=str(artifact_path), fmt="legacy")
        assert artifact_path.exists()
        data = json.loads(artifact_path.read_text())
        assert data["harness_version"] == "2.0"
        assert "results" in data

    def test_run_harness_ctrf_format(self, tmp_path):
        """v2.0: CTRF format produces standardized test report."""
        artifact_path = tmp_path / "ctrf.json"
        hw_test_harness.run_harness(mode="dry-run", artifact_path=str(artifact_path), fmt="ctrf")
        data = json.loads(artifact_path.read_text())
        assert "results" in data
        assert data["results"]["tool"]["name"] == "hw-test-harness"
        assert data["results"]["tool"]["version"] == "2.0"
        assert "summary" in data["results"]
        assert "tests" in data["results"]

    def test_run_harness_junit_format(self, tmp_path):
        """v2.0: JUnit XML format produces valid XML."""
        artifact_path = tmp_path / "junit.xml"
        hw_test_harness.run_harness(mode="dry-run", artifact_path=str(artifact_path), fmt="junit")
        assert artifact_path.exists()
        content = artifact_path.read_text()
        assert "<testsuite" in content
        assert "hw-test-harness" in content

    def test_run_harness_check_mode(self):
        """v2.0: check mode reports eligibility without running tests."""
        artifact = hw_test_harness.run_harness(mode="check")
        assert artifact["mode"] == "check"
        assert "environment" in artifact

    def test_run_harness_tag_filtering(self):
        """v2.0: tag-based filtering selects only matching tests."""
        artifact = hw_test_harness.run_harness(
            mode="dry-run", tags=["E-ENCRYPT", "E-HWID"], fmt="legacy"
        )
        assert artifact["summary"]["total"] == 2
        test_ids = [r["test_id"] for r in artifact["results"]]
        assert "E-ENCRYPT-01" in test_ids
        assert "E-HWID-01" in test_ids

    def test_run_harness_duress_skipped_on_linux(self):
        """v2.0: duress test should be skipped on Linux (Windows-only)."""
        artifact = hw_test_harness.run_harness(mode="simulate", tags=["E-DURESS"], fmt="legacy")
        assert artifact["summary"]["skipped"] == 1

    def test_run_harness_hidden_file_passes_on_linux(self):
        """v2.0: hidden file trigger test should pass on Linux."""
        artifact = hw_test_harness.run_harness(
            mode="simulate", tags=["E-HIDDEN-FILE"], fmt="legacy"
        )
        assert artifact["summary"]["passed"] == 1

    def test_run_harness_hwid_passes_on_linux(self):
        """v2.0: hardware ID collection test should pass on Linux."""
        artifact = hw_test_harness.run_harness(mode="simulate", tags=["E-HWID"], fmt="legacy")
        assert artifact["summary"]["passed"] == 1


# ---------------------------------------------------------------------------
# Test registry tests
# ---------------------------------------------------------------------------


class TestTestRegistry:
    def test_all_tests_defined(self):
        """v2.0: All 12 enforcement path tests should be registered."""
        test_ids = [t.test_id for t in hw_test_harness.ALL_TESTS]
        assert "E-ENCRYPT-01" in test_ids
        assert "E-LOCK-SCREEN-01" in test_ids
        assert "E-GUARDIAN-01" in test_ids
        assert "E-BCD-01" in test_ids
        assert "E-HP-UEFI-01" in test_ids
        assert "E-DURESS-01" in test_ids
        assert "E-HIDDEN-FILE-01" in test_ids
        assert "E-TAMPER-01" in test_ids
        assert "E-TPM-01" in test_ids
        assert "E-ENROLL-01" in test_ids
        assert "E-HWID-01" in test_ids
        assert "E-INTEGRATION-01" in test_ids
        assert len(hw_test_harness.ALL_TESTS) == 12

    def test_each_test_is_hardware_test_instance(self):
        """v2.0: Each test should be a HardwareTest instance."""
        for test in hw_test_harness.ALL_TESTS:
            assert isinstance(test, hw_test_harness.HardwareTest)
            assert test.test_id
            assert test.enforcement_path
            assert test.name
            assert len(test.tags) > 0

    def test_destructive_tests_have_rollback(self):
        """v2.0: Destructive tests should be marked as such."""
        destructive = [t for t in hw_test_harness.ALL_TESTS if t.is_destructive]
        # BCD and HP-UEFI are destructive
        test_ids = [t.test_id for t in destructive]
        assert "E-BCD-01" in test_ids
        assert "E-HP-UEFI-01" in test_ids

    def test_network_tests_have_retry(self):
        """v2.0: Network tests should be marked as such."""
        network = [t for t in hw_test_harness.ALL_TESTS if t.is_network]
        test_ids = [t.test_id for t in network]
        assert "E-ENROLL-01" in test_ids
        assert "E-INTEGRATION-01" in test_ids
