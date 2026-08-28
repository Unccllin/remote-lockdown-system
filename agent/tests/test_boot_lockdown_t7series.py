"""
Tests for boot lockdown modules: hp_uefi_lockdown and bcd_lockdown.
All WMI/PowerShell/subprocess calls are mocked — these tests verify
the logic, not actual BIOS changes.

Phase 4 tests cover:
  - Admin check (fail-fast before state writes)
  - BCD state save/restore (.bcd_state round-trip)
  - Critical/best-effort split (CC19)
  - Rollback on critical failure (CC18)
  - HP password NOT cleared on rollback (CC18)
  - Verification re-reads (Phase 4.5)
  - Rollback-during-rollback (non-fatal rollback errors)
  - Key file survives rollback (rollback scoped to boot-state files only)
"""

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import bcd_lockdown
import hp_uefi_lockdown

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_state_file():
    """Redirect HP boot state file to a temp location."""
    original = hp_uefi_lockdown.BOOT_STATE_FILE
    tmp = Path(tempfile.mktemp())
    hp_uefi_lockdown.BOOT_STATE_FILE = tmp
    yield tmp
    if tmp.exists():
        tmp.unlink()
    hp_uefi_lockdown.BOOT_STATE_FILE = original


@pytest.fixture
def tmp_bcd_sentinel():
    """Redirect BCD sentinel to a temp location."""
    original = bcd_lockdown.BCD_LOCK_SENTINEL
    tmp = Path(tempfile.mktemp())
    bcd_lockdown.BCD_LOCK_SENTINEL = tmp
    yield tmp
    if tmp.exists():
        tmp.unlink()
    bcd_lockdown.BCD_LOCK_SENTINEL = original


@pytest.fixture
def tmp_bcd_state_file():
    """Redirect BCD state file to a temp location."""
    original = bcd_lockdown.BCD_STATE_FILE
    tmp = Path(tempfile.mktemp())
    bcd_lockdown.BCD_STATE_FILE = tmp
    yield tmp
    if tmp.exists():
        tmp.unlink()
    bcd_lockdown.BCD_STATE_FILE = original


@pytest.fixture
def tmp_bcd_files(tmp_bcd_sentinel, tmp_bcd_state_file):
    """Redirect both BCD sentinel and state file to temp locations."""
    return {"sentinel": tmp_bcd_sentinel, "state": tmp_bcd_state_file}


@pytest.fixture
def mock_resolve_settings():
    """D-009: Mock _resolve_setting_names to return the hardcoded lists.

    This bypasses the model-aware resolution so existing tests that mock
    _read_setting continue to work without the extra reads from
    _resolve_setting_names() consuming their read count budget.
    """
    with patch.object(
        hp_uefi_lockdown,
        "_resolve_setting_names",
        return_value=(
            hp_uefi_lockdown.HP_CRITICAL_SETTINGS,
            hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS,
        ),
    ):
        yield


# ---------------------------------------------------------------------------
# HP UEFI Lockdown Tests
# ---------------------------------------------------------------------------


class TestT7PowerOnPassword:
    """T7: HP Power-On Password set/clear/supported."""

    def test_t7_power_on_password_supported_dry_run(self):
        """_is_power_on_password_supported returns True in dry-run."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            assert hp_uefi_lockdown._is_power_on_password_supported() is True

    @patch("hp_uefi_lockdown.platform.system", return_value="Linux")
    def test_t7_power_on_password_supported_not_windows(self, _):
        """_is_power_on_password_supported returns False on non-Windows."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", False):
            assert hp_uefi_lockdown._is_power_on_password_supported() is False

    def test_t7_power_on_password_not_set_dry_run(self):
        """_is_power_on_password_set returns False in dry-run default state."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = False
            assert hp_uefi_lockdown._is_power_on_password_set() is False

    def test_t7_power_on_password_set_dry_run(self):
        """_is_power_on_password_set returns True when dry-run state is set."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = True
            assert hp_uefi_lockdown._is_power_on_password_set() is True
            # Reset for other tests
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = False

    def test_t7_set_power_on_password_dry_run(self):
        """set_power_on_password updates dry-run state."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = False
            rc = hp_uefi_lockdown.set_power_on_password("TestP@ss1", "SetupPw")
            assert rc == 0
            assert hp_uefi_lockdown._is_power_on_password_set() is True
            # Cleanup
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = False

    def test_t7_clear_power_on_password_dry_run(self):
        """clear_power_on_password clears dry-run state."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BIOS_STATE["Power-On Password"]["is_set"] = True
            rc = hp_uefi_lockdown.clear_power_on_password("SetupPw")
            assert rc == 0
            assert hp_uefi_lockdown._is_power_on_password_set() is False

    @patch("hp_uefi_lockdown._run_powershell")
    def test_t7_is_power_on_password_set_true(self, mock_ps):
        """_is_power_on_password_set parses '1' as True."""
        mock_ps.return_value = "1"
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", False):
            assert hp_uefi_lockdown._is_power_on_password_set() is True

    @patch("hp_uefi_lockdown._run_powershell")
    def test_t7_is_power_on_password_set_false(self, mock_ps):
        """_is_power_on_password_set parses '0' as False."""
        mock_ps.return_value = "0"
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", False):
            assert hp_uefi_lockdown._is_power_on_password_set() is False

    @patch("hp_uefi_lockdown._run_powershell")
    def test_t7_is_power_on_password_supported_wmi(self, mock_ps):
        """_is_power_on_password_supported returns True when WMI finds the setting."""
        mock_ps.return_value = "Power-On Password"
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            assert hp_uefi_lockdown._is_power_on_password_supported() is True

    @patch("hp_uefi_lockdown._run_powershell")
    def test_t7_is_power_on_password_supported_not_found(self, mock_ps):
        """_is_power_on_password_supported returns False when WMI finds nothing."""
        mock_ps.return_value = ""
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            assert hp_uefi_lockdown._is_power_on_password_supported() is False


class TestT7ApplyBootLockdownPBA:
    """T7: apply_boot_lockdown with enable_pba flag."""

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._set_and_verify")
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown._is_power_on_password_supported", return_value=True)
    @patch("hp_uefi_lockdown._is_power_on_password_set")
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    def test_t7_enable_pba_sets_power_on_password(
        self,
        mock_resolve,
        mock_bsp,
        mock_bitlocker,
        mock_secure_boot,
        mock_sure_admin,
        mock_admin,
        mock_hp,
        mock_pop_set,
        mock_pop_supported,
        mock_setup_set,
        mock_set_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """apply_boot_lockdown(enable_pba=True) sets Power-On Password."""
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_sure_admin.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
        # First call: check if setup password already set (False = no)
        # Second call: verify setup password was set (True = yes)
        mock_setup_set.side_effect = [False, True]
        # First call: check if power-on password already set (False = no)
        # Second call: verify power-on password was set (True = yes)
        mock_pop_set.side_effect = [False, True]
        mock_pop_supported.return_value = True
        mock_read.return_value = "Disable"  # Current value for all settings
        mock_set.return_value = 0  # Success
        mock_set_verify.return_value = True  # Verification passes

        result = hp_uefi_lockdown.apply_boot_lockdown(enable_pba=True)

        assert result["success"] is True
        assert result["bios_password"] is not None
        assert result["power_on_password"] is not None
        # Verify set_power_on_password was called (via _set_setting with "Power-On Password")
        pop_calls = [c for c in mock_set.call_args_list if "Power-On Password" in str(c)]
        assert len(pop_calls) > 0

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._set_and_verify")
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown._is_power_on_password_supported", return_value=True)
    @patch("hp_uefi_lockdown._is_power_on_password_set", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    def test_t7_enable_pba_false_no_power_on_password(
        self,
        mock_resolve,
        mock_bsp,
        mock_bitlocker,
        mock_secure_boot,
        mock_sure_admin,
        mock_admin,
        mock_hp,
        mock_pop_set,
        mock_pop_supported,
        mock_setup_set,
        mock_set_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """apply_boot_lockdown(enable_pba=False) does NOT set Power-On Password."""
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_sure_admin.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
        # First call: check if setup password already set (False = no)
        # Second call: verify setup password was set (True = yes)
        mock_setup_set.side_effect = [False, True]
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        mock_set_verify.return_value = True

        result = hp_uefi_lockdown.apply_boot_lockdown(enable_pba=False)

        assert result["success"] is True
        assert result["bios_password"] is not None
        assert result["power_on_password"] is None  # PBA not enabled
        # Verify set_power_on_password was NOT called
        pop_calls = [c for c in mock_set.call_args_list if "Power-On Password" in str(c)]
        assert len(pop_calls) == 0

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._set_and_verify")
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown._is_power_on_password_supported", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    def test_t7_enable_pba_not_supported(
        self,
        mock_resolve,
        mock_bsp,
        mock_bitlocker,
        mock_secure_boot,
        mock_sure_admin,
        mock_admin,
        mock_hp,
        mock_pop_supported,
        mock_setup_set,
        mock_set_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """apply_boot_lockdown(enable_pba=True) on unsupported model — no PBA."""
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_sure_admin.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
        # First call: check if setup password already set (False = no)
        # Second call: verify setup password was set (True = yes)
        mock_setup_set.side_effect = [False, True]
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        mock_set_verify.return_value = True

        result = hp_uefi_lockdown.apply_boot_lockdown(enable_pba=True)

        assert result["success"] is True
        assert result["power_on_password"] is None  # Not supported
        # Setup password should still be set
        assert result["bios_password"] is not None


class TestT7SureAdminReportBlocked:
    """T7 (Q3=B): Sure Admin blocks BIOS changes and reports blocked."""

    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    def test_t7_sure_admin_blocks_bios_changes(
        self,
        mock_hp,
        mock_sure_admin,
        mock_secure_boot,
    ):
        """apply_boot_lockdown with Sure Admin detected blocks BIOS changes."""
        mock_sure_admin.return_value = {
            "sure_admin_detected": True,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": True,
            "warning": "Sure Admin detected",
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }

        result = hp_uefi_lockdown.apply_boot_lockdown()

        assert result["bios_lockdown_blocked"] is True
        assert result["success"] is False
        assert result["bios_password"] is None  # No password set
        assert result["sure_admin_status"]["sure_admin_detected"] is True

    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    def test_t7_sure_admin_not_detected_proceeds(
        self,
        mock_hp,
        mock_sure_admin,
        mock_secure_boot,
    ):
        """apply_boot_lockdown without Sure Admin proceeds normally."""
        mock_sure_admin.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }

        with (
            patch.object(hp_uefi_lockdown, "_is_admin", return_value=True),
            patch.object(hp_uefi_lockdown, "_is_setup_password_set", return_value=True),
            patch.object(
                hp_uefi_lockdown,
                "_check_bitlocker",
                return_value={
                    "enabled": False,
                    "suspended": False,
                    "percentage": "0%",
                    "error": None,
                },
            ),
            patch.object(
                hp_uefi_lockdown,
                "_check_sure_start_bsp",
                return_value={"enabled": False, "setting_name": None, "warning": None},
            ),
            patch.object(hp_uefi_lockdown, "_resolve_setting_names", return_value=([], [])),
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="test")

        assert result["bios_lockdown_blocked"] is False
        # With no critical settings, success=False and no_critical_settings=True
        assert result.get("no_critical_settings") is True


class TestT7SureStartBspLockThenSeal:
    """T7 (Q2=A): Sure Start BSP lock-then-seal pattern."""

    @patch("hp_uefi_lockdown._read_setting")
    def test_t7_check_sure_start_bsp_enabled(self, mock_read):
        """_check_sure_start_bsp returns enabled=True when setting is 'Enable'."""
        mock_read.return_value = "Enable"
        result = hp_uefi_lockdown._check_sure_start_bsp()
        assert result["enabled"] is True
        assert result["setting_name"] is not None
        assert result["warning"] is not None

    @patch("hp_uefi_lockdown._read_setting")
    def test_t7_check_sure_start_bsp_disabled(self, mock_read):
        """_check_sure_start_bsp returns enabled=False when setting is 'Disable'."""
        mock_read.return_value = "Disable"
        result = hp_uefi_lockdown._check_sure_start_bsp()
        assert result["enabled"] is False
        assert result["setting_name"] is not None
        assert result["warning"] is None

    @patch("hp_uefi_lockdown._read_setting")
    def test_t7_check_sure_start_bsp_not_found(self, mock_read):
        """_check_sure_start_bsp returns enabled=False when setting not found."""
        mock_read.return_value = None
        result = hp_uefi_lockdown._check_sure_start_bsp()
        assert result["enabled"] is False
        assert result["setting_name"] is None

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    def test_t7_disable_sure_start_bsp(self, mock_set, mock_read):
        """_disable_sure_start_bsp sets the setting to 'Disable'."""
        mock_read.return_value = "Enable"
        mock_set.return_value = 0
        result = hp_uefi_lockdown._disable_sure_start_bsp("SetupPw")
        assert result is True
        # Verify _set_setting was called with "Disable"
        args = mock_set.call_args.args
        assert args[1] == "Disable"

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    def test_t7_enable_sure_start_bsp(self, mock_set, mock_read):
        """_enable_sure_start_bsp sets the setting to 'Enable'."""
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        result = hp_uefi_lockdown._enable_sure_start_bsp("SetupPw")
        assert result is True
        args = mock_set.call_args.args
        assert args[1] == "Enable"

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    def test_t7_disable_sure_start_bsp_not_found(self, mock_set, mock_read):
        """_disable_sure_start_bsp returns True when setting not found (nothing to disable)."""
        mock_read.return_value = None
        result = hp_uefi_lockdown._disable_sure_start_bsp("SetupPw")
        assert result is True
        mock_set.assert_not_called()

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._set_and_verify")
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._disable_sure_start_bsp")
    @patch("hp_uefi_lockdown._enable_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    def test_t7_lock_then_seal_disables_and_re_enables(
        self,
        mock_resolve,
        mock_enable_bsp,
        mock_disable_bsp,
        mock_bsp,
        mock_bitlocker,
        mock_secure_boot,
        mock_sure_admin,
        mock_admin,
        mock_hp,
        mock_setup_set,
        mock_set_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """apply_boot_lockdown with BSP enabled disables before, re-enables after."""
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_sure_admin.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_secure_boot.return_value = {
            "enabled": True,
            "setting_name": "Secure Boot",
            "warning": None,
        }
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {
            "enabled": True,
            "setting_name": "Sure Start BIOS Settings Protection",
            "warning": "BSP enabled",
        }
        mock_disable_bsp.return_value = True
        mock_enable_bsp.return_value = True
        mock_setup_set.return_value = True
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        mock_set_verify.return_value = True

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="test")

        assert result["success"] is True
        # Verify lock-then-seal pattern: disable called before, enable called after
        mock_disable_bsp.assert_called_once()
        mock_enable_bsp.assert_called_once()
        assert result["sure_start_bsp_status"]["enabled"] is True


class TestT7RemoveBootLockdownPBA:
    """T7: remove_boot_lockdown clears Power-On Password when provided."""

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._verify_setting")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    @patch("hp_uefi_lockdown._is_power_on_password_set")
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    @patch("hp_uefi_lockdown.load_boot_state")
    def test_t7_remove_clears_power_on_password(
        self,
        mock_load_state,
        mock_resolve,
        mock_bsp,
        mock_bitlocker,
        mock_admin,
        mock_hp,
        mock_pop_set,
        mock_setup_set,
        mock_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """remove_boot_lockdown with power_on_password clears it."""
        mock_load_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Network (PXE) Boot": "Enable"},
        }
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
        mock_pop_set.return_value = True  # Power-On Password is set
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        mock_verify.return_value = True

        result = hp_uefi_lockdown.remove_boot_lockdown("SetupPw", power_on_password="PopPw")

        assert result is True
        # Verify clear_power_on_password was called
        # (via _set_setting with "Power-On Password" and "")
        pop_calls = [
            c for c in mock_set.call_args_list if "Power-On Password" in str(c) and "" in str(c)
        ]
        assert len(pop_calls) > 0

    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._verify_setting")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown._check_bitlocker")
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._resolve_setting_names")
    @patch("hp_uefi_lockdown.load_boot_state")
    def test_t7_remove_without_power_on_password(
        self,
        mock_load_state,
        mock_resolve,
        mock_bsp,
        mock_bitlocker,
        mock_admin,
        mock_hp,
        mock_setup_set,
        mock_verify,
        mock_set,
        mock_read,
        tmp_state_file,
    ):
        """remove_boot_lockdown without power_on_password doesn't clear PBA."""
        mock_load_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Network (PXE) Boot": "Enable"},
        }
        mock_resolve.return_value = (
            [("Network (PXE) Boot", "Disable")],
            [],
        )
        mock_bitlocker.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
        mock_read.return_value = "Disable"
        mock_set.return_value = 0
        mock_verify.return_value = True

        result = hp_uefi_lockdown.remove_boot_lockdown("SetupPw")

        assert result is True
        # Verify clear_power_on_password was NOT called
        pop_calls = [
            c for c in mock_set.call_args_list if "Power-On Password" in str(c) and "" in str(c)
        ]
        assert len(pop_calls) == 0
