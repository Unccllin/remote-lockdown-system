"""
Tests for BitLocker TPM+PIN PBA module (T9 — Phase 3).

All WMI/PowerShell/subprocess calls are mocked — these tests verify
the logic, not actual BitLocker protector management.

Covers:
  - check_bitlocker_status (enabled, disabled, not-Windows, dry-run)
  - _generate_pin (length, numeric)
  - add_tpm_pin_protector (success, failure, dry-run)
  - get_recovery_password (success, not-found, dry-run)
  - remove_tpm_pin_protector (success, failure, dry-run)
  - enable_pba (success, BitLocker off Q7=A, already has PIN, with custom PIN)
  - disable_pba (success, no state file, with explicit protector_id)
  - state persistence (save/load/clear)
"""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import bitlocker_pba

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_state_file(tmp_path, monkeypatch):
    """Redirect the PBA state file to a temp path."""
    state_file = tmp_path / "bitlocker_pba_state.json"
    monkeypatch.setattr(bitlocker_pba, "_BITLOCKER_PBA_STATE_FILE", state_file)
    yield state_file


# ---------------------------------------------------------------------------
# check_bitlocker_status tests
# ---------------------------------------------------------------------------


class TestCheckBitlockerStatus:
    """check_bitlocker_status — BitLocker status detection."""

    def test_dry_run_enabled(self):
        """Dry-run returns enabled=True when flag set."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            bitlocker_pba._DRY_RUN_BITLOCKER_ENABLED = True
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is True
            assert result["has_tpm_protector"] is True
            assert result["has_pin_protector"] is False
            assert result["error"] is None

    def test_dry_run_disabled(self):
        """Dry-run returns enabled=False when flag unset."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            bitlocker_pba._DRY_RUN_BITLOCKER_ENABLED = False
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is False

    @patch("bitlocker_pba.platform.system", return_value="Linux")
    def test_non_windows_returns_disabled(self, _):
        """Non-Windows returns enabled=False."""
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is False
            assert result["error"] is None

    @patch("bitlocker_pba._run_powershell")
    @patch("bitlocker_pba._run_cmd")
    @patch("bitlocker_pba.platform.system", return_value="Windows")
    def test_windows_enabled_with_tpm(self, mock_sys, mock_cmd, mock_ps, tmp_state_file):
        """Windows with Protection On + TPM protector."""
        mock_cmd.return_value = (
            0,
            "    Protection Status:    Protection On\n    Conversion Status:    100% Encrypted",
            "",
        )
        # WMI returns TPM-only protector (Type=1)
        mock_ps.return_value = "ID={TPM-ONLY-001};Type=1"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is True
            assert result["has_tpm_protector"] is True
            assert result["has_pin_protector"] is False

    @patch("bitlocker_pba._run_powershell")
    @patch("bitlocker_pba._run_cmd")
    @patch("bitlocker_pba.platform.system", return_value="Windows")
    def test_windows_enabled_with_pin(self, mock_sys, mock_cmd, mock_ps, tmp_state_file):
        """Windows with Protection On + TPM+PIN protector (Type=4)."""
        mock_cmd.return_value = (
            0,
            "    Protection Status:    Protection On\n    Conversion Status:    100% Encrypted",
            "",
        )
        mock_ps.return_value = "ID={TPM-ONLY-001};Type=1\nID={TPM-PIN-001};Type=4"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is True
            assert result["has_tpm_protector"] is True
            assert result["has_pin_protector"] is True

    @patch("bitlocker_pba._run_cmd")
    @patch("bitlocker_pba.platform.system", return_value="Windows")
    def test_windows_protection_off(self, mock_sys, mock_cmd, tmp_state_file):
        """Windows with Protection Off returns enabled=False."""
        mock_cmd.return_value = (
            0,
            "    Protection Status:    Protection Off\n    Conversion Status:    0% Encrypted",
            "",
        )
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is False

    @patch("bitlocker_pba._run_cmd")
    @patch("bitlocker_pba.platform.system", return_value="Windows")
    def test_windows_manage_bde_fails(self, mock_sys, mock_cmd, tmp_state_file):
        """manage-bde failure returns error."""
        mock_cmd.return_value = (-1, "", "Command not found: manage-bde")
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.check_bitlocker_status()
            assert result["enabled"] is False
            assert result["error"] is not None
            assert "manage-bde failed" in result["error"]


# ---------------------------------------------------------------------------
# _generate_pin tests
# ---------------------------------------------------------------------------


class TestGeneratePin:
    """_generate_pin — PIN generation."""

    def test_default_length_6(self):
        pin = bitlocker_pba._generate_pin()
        assert len(pin) == 6
        assert pin.isdigit()

    def test_custom_length(self):
        pin = bitlocker_pba._generate_pin(length=8)
        assert len(pin) == 8
        assert pin.isdigit()

    def test_different_pins(self):
        """Two calls produce different PINs (with overwhelming probability)."""
        pins = {bitlocker_pba._generate_pin() for _ in range(20)}
        assert len(pins) > 1


# ---------------------------------------------------------------------------
# add_tpm_pin_protector tests
# ---------------------------------------------------------------------------


class TestAddTpmPinProtector:
    """add_tpm_pin_protector — WMI protector creation."""

    def test_dry_run_returns_simulated_id(self):
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            result = bitlocker_pba.add_tpm_pin_protector("123456")
            assert result == bitlocker_pba._DRY_RUN_PROTECTOR_ID

    @patch("bitlocker_pba._run_powershell")
    def test_success_returns_protector_id(self, mock_ps):
        mock_ps.return_value = "{ABC-123-DEF}"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.add_tpm_pin_protector("123456")
            assert result == "{ABC-123-DEF}"

    @patch("bitlocker_pba._run_powershell")
    def test_empty_id_raises(self, mock_ps):
        mock_ps.return_value = ""
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            with pytest.raises(RuntimeError, match="empty protector ID"):
                bitlocker_pba.add_tpm_pin_protector("123456")

    @patch("bitlocker_pba._run_powershell")
    def test_powershell_failure_raises(self, mock_ps):
        mock_ps.side_effect = RuntimeError("PowerShell failed (exit 1): access denied")
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            with pytest.raises(RuntimeError, match="PowerShell failed"):
                bitlocker_pba.add_tpm_pin_protector("123456")


# ---------------------------------------------------------------------------
# get_recovery_password tests
# ---------------------------------------------------------------------------


class TestGetRecoveryPassword:
    """get_recovery_password — 48-digit recovery key retrieval."""

    def test_dry_run_returns_simulated_password(self):
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            result = bitlocker_pba.get_recovery_password()
            assert result == bitlocker_pba._DRY_RUN_RECOVERY_PASSWORD

    @patch("bitlocker_pba._run_powershell")
    def test_success_returns_password(self, mock_ps):
        mock_ps.return_value = "111111-222222-333333-444444-555555-666666-777777-888888"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.get_recovery_password()
            assert "111111" in result

    @patch("bitlocker_pba._run_powershell")
    def test_empty_password_raises(self, mock_ps):
        mock_ps.return_value = ""
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            with pytest.raises(RuntimeError, match="No numerical recovery"):
                bitlocker_pba.get_recovery_password()


# ---------------------------------------------------------------------------
# remove_tpm_pin_protector tests
# ---------------------------------------------------------------------------


class TestRemoveTpmPinProtector:
    """remove_tpm_pin_protector — WMI protector deletion."""

    def test_dry_run_returns_true(self):
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            result = bitlocker_pba.remove_tpm_pin_protector("{ABC-123}")
            assert result is True

    @patch("bitlocker_pba._run_powershell")
    def test_success_returns_true(self, mock_ps):
        mock_ps.return_value = "0"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.remove_tpm_pin_protector("{ABC-123}")
            assert result is True

    @patch("bitlocker_pba._run_powershell")
    def test_failure_raises(self, mock_ps):
        mock_ps.side_effect = RuntimeError("DeleteKeyProtector failed: 1")
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            with pytest.raises(RuntimeError, match="DeleteKeyProtector"):
                bitlocker_pba.remove_tpm_pin_protector("{ABC-123}")


# ---------------------------------------------------------------------------
# State persistence tests
# ---------------------------------------------------------------------------


class TestStatePersistence:
    """_save_pba_state / _load_pba_state / _clear_pba_state."""

    def test_save_and_load(self, tmp_state_file):
        bitlocker_pba._save_pba_state("{PROTO-001}", "123456", "REC-PW")
        state = bitlocker_pba._load_pba_state()
        assert state is not None
        assert state["protector_id"] == "{PROTO-001}"
        assert state["pin"] == "123456"
        assert state["recovery_password"] == "REC-PW"

    def test_load_no_file_returns_none(self, tmp_state_file):
        assert not tmp_state_file.exists()
        state = bitlocker_pba._load_pba_state()
        assert state is None

    def test_clear_removes_file(self, tmp_state_file):
        bitlocker_pba._save_pba_state("{PROTO-001}", "123456", "REC-PW")
        assert tmp_state_file.exists()
        bitlocker_pba._clear_pba_state()
        assert not tmp_state_file.exists()

    def test_clear_no_file_is_noop(self, tmp_state_file):
        """Clearing when no state file exists doesn't error."""
        bitlocker_pba._clear_pba_state()
        assert not tmp_state_file.exists()

    def test_load_corrupt_file_returns_none(self, tmp_state_file):
        tmp_state_file.write_text("not valid json")
        state = bitlocker_pba._load_pba_state()
        assert state is None


# ---------------------------------------------------------------------------
# enable_pba tests
# ---------------------------------------------------------------------------


class TestEnablePba:
    """enable_pba — orchestrator tests."""

    def test_dry_run_success(self, tmp_state_file):
        """Dry-run enable_pba returns success with simulated credentials."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            bitlocker_pba._DRY_RUN_BITLOCKER_ENABLED = True
            result = bitlocker_pba.enable_pba()
            assert result["success"] is True
            assert result["pin"] is not None
            assert len(result["pin"]) == 6
            assert result["recovery_password"] is not None
            assert result["protector_id"] is not None
            assert result["error"] is None

    def test_dry_run_with_custom_pin(self, tmp_state_file):
        """Dry-run enable_pba with custom PIN uses that PIN."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            bitlocker_pba._DRY_RUN_BITLOCKER_ENABLED = True
            result = bitlocker_pba.enable_pba(pin="999888")
            assert result["success"] is True
            assert result["pin"] == "999888"

    def test_bitlocker_not_enabled_returns_failure(self, tmp_state_file):
        """Q7=A: BitLocker off → failure with clear error."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            bitlocker_pba._DRY_RUN_BITLOCKER_ENABLED = False
            result = bitlocker_pba.enable_pba()
            assert result["success"] is False
            assert result["pin"] is None
            assert "BitLocker is not enabled" in result["error"]
            assert "Q7=A" in result["error"]

    @patch("bitlocker_pba.check_bitlocker_status")
    def test_already_has_pin_returns_failure(self, mock_status, tmp_state_file):
        """If a TPM+PIN protector already exists, refuse to add a second."""
        mock_status.return_value = {
            "enabled": True,
            "has_tpm_protector": True,
            "has_pin_protector": True,
            "error": None,
        }
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.enable_pba()
            assert result["success"] is False
            assert "already exists" in result["error"]

    @patch("bitlocker_pba.get_recovery_password")
    @patch("bitlocker_pba.add_tpm_pin_protector")
    @patch("bitlocker_pba.check_bitlocker_status")
    def test_success_persists_state(self, mock_status, mock_add, mock_rec, tmp_state_file):
        """enable_pba success saves state to disk."""
        mock_status.return_value = {
            "enabled": True,
            "has_tpm_protector": True,
            "has_pin_protector": False,
            "error": None,
        }
        mock_add.return_value = "{PROTO-XYZ}"
        mock_rec.return_value = "111111-222222-333333-444444-555555-666666-777777-888888"
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.enable_pba(pin="123456")
            assert result["success"] is True
            assert result["protector_id"] == "{PROTO-XYZ}"
            assert result["pin"] == "123456"
            # Verify state was persisted
            state = bitlocker_pba._load_pba_state()
            assert state["protector_id"] == "{PROTO-XYZ}"

    @patch("bitlocker_pba.add_tpm_pin_protector")
    @patch("bitlocker_pba.check_bitlocker_status")
    def test_add_protector_failure_returns_error(self, mock_status, mock_add, tmp_state_file):
        """If add_tpm_pin_protector raises, enable_pba returns failure."""
        mock_status.return_value = {
            "enabled": True,
            "has_tpm_protector": True,
            "has_pin_protector": False,
            "error": None,
        }
        mock_add.side_effect = RuntimeError("WMI access denied")
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.enable_pba()
            assert result["success"] is False
            assert "WMI access denied" in result["error"]


# ---------------------------------------------------------------------------
# disable_pba tests
# ---------------------------------------------------------------------------


class TestDisablePba:
    """disable_pba — orchestrator tests."""

    def test_dry_run_success(self, tmp_state_file):
        """Dry-run disable_pba with state file returns success."""
        with patch.object(bitlocker_pba, "_DRY_RUN", True):
            # Save state first (dry-run enable_pba does this)
            bitlocker_pba._save_pba_state(bitlocker_pba._DRY_RUN_PROTECTOR_ID, "123456", "REC")
            result = bitlocker_pba.disable_pba()
            assert result["success"] is True
            assert result["error"] is None

    def test_no_state_file_returns_failure(self, tmp_state_file):
        """disable_pba with no state file returns clear error."""
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.disable_pba()
            assert result["success"] is False
            assert "No PBA state file" in result["error"]

    @patch("bitlocker_pba.remove_tpm_pin_protector")
    def test_with_explicit_protector_id(self, mock_remove, tmp_state_file):
        """disable_pba with explicit protector_id doesn't need state file."""
        mock_remove.return_value = True
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.disable_pba(protector_id="{EXPLICIT-001}")
            assert result["success"] is True
            mock_remove.assert_called_once_with("{EXPLICIT-001}")

    @patch("bitlocker_pba.remove_tpm_pin_protector")
    def test_success_clears_state_file(self, mock_remove, tmp_state_file):
        """disable_pba success clears the state file."""
        bitlocker_pba._save_pba_state("{PROTO-001}", "123456", "REC")
        mock_remove.return_value = True
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.disable_pba()
            assert result["success"] is True
            assert not tmp_state_file.exists()

    @patch("bitlocker_pba.remove_tpm_pin_protector")
    def test_remove_failure_returns_error(self, mock_remove, tmp_state_file):
        """If remove_tpm_pin_protector raises, disable_pba returns failure."""
        bitlocker_pba._save_pba_state("{PROTO-001}", "123456", "REC")
        mock_remove.side_effect = RuntimeError("DeleteKeyProtector failed")
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.disable_pba()
            assert result["success"] is False
            assert "DeleteKeyProtector failed" in result["error"]

    def test_state_file_without_protector_id(self, tmp_state_file):
        """State file with missing protector_id returns clear error."""
        tmp_state_file.write_text(json.dumps({"pin": "123456"}))
        with patch.object(bitlocker_pba, "_DRY_RUN", False):
            result = bitlocker_pba.disable_pba()
            assert result["success"] is False
            assert "no protector_id" in result["error"]


# ---------------------------------------------------------------------------
# set_dry_run tests
# ---------------------------------------------------------------------------


class TestSetDryRun:
    """set_dry_run — master switch propagation."""

    def test_set_dry_run_true(self):
        bitlocker_pba.set_dry_run(True)
        assert bitlocker_pba._DRY_RUN is True

    def test_set_dry_run_false(self):
        bitlocker_pba.set_dry_run(False)
        assert bitlocker_pba._DRY_RUN is False
