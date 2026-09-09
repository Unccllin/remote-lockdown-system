"""Tests for BitLocker PCR sealing enrollment (D-211 — C2 §4.4).

Tests the Python wrapper around the PowerShell enrollment script.
All tests run in dry-run mode — no real BitLocker or TPM needed.
"""

from pathlib import Path

import pytest

import bitlocker_pcr_seal
from bitlocker_pcr_seal import (
    enroll_pcr_sealing,
    enroll_tracking_pcr,
    get_enrollment_state,
    remove_pcr_sealing,
    set_dry_run,
)


@pytest.fixture(autouse=True)
def _dry_run_and_state(tmp_path, monkeypatch):
    """Enable dry-run mode and use a temporary state file."""
    set_dry_run(True)
    state_file = tmp_path / "bitlocker_pcr_state.json"
    # Patch the module-level state file path
    monkeypatch.setattr(bitlocker_pcr_seal, "_STATE_FILE", state_file)
    yield state_file
    set_dry_run(False)


def test_enroll_pcr_sealing_dry_run():
    """Dry-run enrollment should succeed and return a normal PCR 12."""
    result = enroll_pcr_sealing()
    assert result["success"] is True
    assert result["normal_pcr12"] is not None
    assert len(result["normal_pcr12"]) == 64
    assert result["sealing_tier"] == "high-assurance"
    assert result["error"] is None


def test_enroll_pcr_sealing_with_tracking_pcr():
    """Enrollment with tracking PCR 12 should store both values."""
    tracking_pcr = "b" * 64
    result = enroll_pcr_sealing(tracking_pcr12=tracking_pcr)
    assert result["success"] is True
    assert result["normal_pcr12"] is not None
    assert result["tracking_pcr12"] == tracking_pcr


def test_enroll_state_persisted(_dry_run_and_state):
    """Enrollment state should be persisted to the state file."""
    tracking_pcr = "c" * 64
    enroll_pcr_sealing(tracking_pcr12=tracking_pcr)
    state = get_enrollment_state()
    assert state is not None
    assert state["tracking_pcr12"] == tracking_pcr
    assert state["sealing_tier"] == "high-assurance"


def test_enroll_tracking_pcr(_dry_run_and_state):
    """Second-boot enrollment should add the tracking protector."""
    # First, do normal enrollment
    enroll_pcr_sealing()
    # Then, enroll tracking PCR
    tracking_pcr = "d" * 64
    result = enroll_tracking_pcr(tracking_pcr)
    assert result["success"] is True
    assert result["error"] is None


def test_enroll_tracking_pcr_already_enrolled(_dry_run_and_state):
    """If tracking PCR is already enrolled, skip and return already_enrolled."""
    tracking_pcr = "e" * 64
    enroll_pcr_sealing(tracking_pcr12=tracking_pcr)
    result = enroll_tracking_pcr(tracking_pcr)
    assert result["success"] is True
    assert result["already_enrolled"] is True


def test_remove_pcr_sealing(_dry_run_and_state):
    """Remove should clear the state file."""
    enroll_pcr_sealing()
    assert get_enrollment_state() is not None
    result = remove_pcr_sealing()
    assert result["success"] is True
    assert get_enrollment_state() is None


def test_enroll_non_windows_returns_error(monkeypatch):
    """On non-Windows, enrollment should fail gracefully."""
    set_dry_run(False)  # Disable dry-run to test the non-Windows path
    monkeypatch.setattr("platform.system", lambda: "Linux")
    result = enroll_pcr_sealing()
    assert result["success"] is False
    assert "Not Windows" in result["error"]
    set_dry_run(True)  # Re-enable for other tests


def test_enroll_script_exists():
    """The PowerShell enrollment script should exist."""
    script = Path(__file__).parent.parent / "scripts" / "enroll-bitlocker-pcr.ps1"
    assert script.exists(), f"Enrollment script not found: {script}"
    # Verify it has the expected content
    content = script.read_text()
    assert "BitLocker PCR sealing" in content
    assert "PCR 12" in content
    assert "high-assurance" in content
    assert "TrackingPcr12" in content
