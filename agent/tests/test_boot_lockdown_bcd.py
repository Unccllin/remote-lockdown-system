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

import json
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


class TestBcdLockdown:
    # --- Phase 4: _is_admin() check ---

    @patch("bcd_lockdown._is_admin", return_value=False)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    def test_apply_bcd_lockdown_not_admin_fail_fast(self, _, __, tmp_bcd_files):
        """Phase 4.1: Admin check fails fast before any state writes."""
        result = bcd_lockdown.apply_bcd_lockdown()
        assert result["success"] is False
        assert result["rolled_back"] is False  # nothing to roll back
        # Sentinel should NOT be written
        assert not tmp_bcd_files["sentinel"].exists()
        # State file should NOT be written (fail-fast before state save)
        assert not tmp_bcd_files["state"].exists()

    # --- Phase 4: dict return type ---

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Linux")
    def test_apply_bcd_lockdown_not_windows(self, _, __, tmp_bcd_files):
        result = bcd_lockdown.apply_bcd_lockdown()
        assert result["success"] is True  # nothing to do

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_apply_bcd_lockdown_success(self, mock_read, mock_run, _, __, tmp_bcd_files):
        """All critical + best-effort settings succeed."""

        # reagentc /disable succeeds, bcdedit /set succeeds. Verification no
        # longer parses /query output here; it goes through _read_bcd_setting.
        def run_side_effect(cmd, timeout=15):
            return (0, "", "")

        mock_run.side_effect = run_side_effect

        # _read_bcd_setting returns the lockdown value (verification passes).
        # It is the single verification path for both scopes now, so bootmgr
        # settings ({bootmgr} timeout) must be covered here too.
        def read_side_effect(setting):
            tables = (
                bcd_lockdown.BCD_CRITICAL_COMMANDS,
                bcd_lockdown.BCD_BEST_EFFORT_COMMANDS,
                bcd_lockdown.BCD_BOOTMGR_COMMANDS,
            )
            for table in tables:
                for sname, sval, _ in table:
                    if setting == sname:
                        return sval
            return None

        mock_read.side_effect = read_side_effect

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is True
        assert result["partial"] is False
        assert result["rolled_back"] is False
        assert tmp_bcd_files["sentinel"].exists()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_apply_bcd_lockdown_all_critical_fail(self, mock_read, mock_run, _, __, tmp_bcd_files):
        """All critical settings fail → rollback, no sentinel."""
        # reagentc /disable fails, bcdedit /set fails
        mock_run.return_value = (1, "", "Access denied")
        mock_read.return_value = "Yes"  # verification fails (expected "No")

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is False
        assert result["rolled_back"] is True
        assert not tmp_bcd_files["sentinel"].exists()  # sentinel not written

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_apply_bcd_lockdown_best_effort_failure_no_rollback(
        self, mock_read, mock_run, _, __, tmp_bcd_files
    ):
        """Best-effort failure does NOT trigger rollback."""

        # reagentc succeeds, critical bcdedit succeeds, best-effort fails
        def run_side_effect(cmd):
            # reagentc /disable succeeds
            if "reagentc" in cmd and "/disable" in cmd:
                return (0, "", "")
            # bcdedit /set — check if it's a best-effort setting
            cmd_str = " ".join(cmd)
            for sname, _sval, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS:
                if sname in cmd_str:
                    return (1, "", "OEM-locked")  # best-effort fails
            return (0, "", "")  # critical succeeds

        mock_run.side_effect = run_side_effect

        def read_side_effect(setting):
            for sname, sval, _ in bcd_lockdown.BCD_CRITICAL_COMMANDS:
                if setting == sname:
                    return sval  # critical verifies OK
            # best-effort: return old value (verification fails)
            for sname, sval, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS:
                if setting == sname:
                    return "Legacy" if sval == "Standard" else "DisplayAllFailures"
            return None

        mock_read.side_effect = read_side_effect

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is True
        assert result["partial"] is True
        assert result["rolled_back"] is False
        assert result["best_effort_failed"] > 0
        assert tmp_bcd_files["sentinel"].exists()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_apply_bcd_lockdown_partial_critical_failure_triggers_rollback(
        self, mock_read, mock_run, _, __, tmp_bcd_files
    ):
        """One critical setting fails → rollback ALL changes."""
        call_count = [0]

        def run_side_effect(cmd):
            call_count[0] += 1
            # reagentc /disable succeeds (critical 1)
            if "reagentc" in cmd and "/disable" in cmd:
                return (0, "", "")
            # reagentc /enable (rollback) succeeds
            if "reagentc" in cmd and "/enable" in cmd:
                return (0, "", "")
            # First bcdedit /set (recoveryenabled) succeeds
            if "recoveryenabled" in " ".join(cmd):
                return (0, "", "")
            # Second bcdedit /set (displaybootmenu) FAILS
            if "displaybootmenu" in " ".join(cmd):
                return (1, "", "Access denied")
            return (0, "", "")

        mock_run.side_effect = run_side_effect

        def read_side_effect(setting):
            if setting == "recoveryenabled":
                return "No"  # verified
            if setting == "displaybootmenu":
                return "Yes"  # verification fails (expected "No")
            # For state save (before apply): return original values
            return "Yes"

        mock_read.side_effect = read_side_effect

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is False
        assert result["rolled_back"] is True
        assert not tmp_bcd_files["sentinel"].exists()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_remove_bcd_lockdown_success(self, mock_read, mock_run, _, __, tmp_bcd_files):
        # Create sentinel + state file first
        tmp_bcd_files["sentinel"].write_text("locked")
        state = {
            "winre_enabled": True,
            "settings": {"recoveryenabled": "Yes", "displaybootmenu": "Yes"},
        }
        tmp_bcd_files["state"].write_text(json.dumps(state))
        mock_run.return_value = (0, "", "")

        result = bcd_lockdown.remove_bcd_lockdown()

        assert result is True
        assert not tmp_bcd_files["sentinel"].exists()
        assert not tmp_bcd_files["state"].exists()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    def test_remove_bcd_lockdown_no_sentinel(self, mock_run, _, __, tmp_bcd_files):
        result = bcd_lockdown.remove_bcd_lockdown()
        assert result is True
        assert mock_run.call_count == 0  # no commands run

    @patch("bcd_lockdown._is_admin", return_value=False)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    def test_remove_bcd_lockdown_not_admin(self, _, __, tmp_bcd_files):
        """Phase 4.1: Admin check for removal too."""
        tmp_bcd_files["sentinel"].write_text("locked")
        result = bcd_lockdown.remove_bcd_lockdown()
        assert result is False

    @patch("bcd_lockdown._run")
    def test_disable_winre_success(self, mock_run):
        mock_run.return_value = (0, "", "")
        assert bcd_lockdown._disable_winre() is True
        assert mock_run.call_args.args[0] == ["reagentc", "/disable"]

    @patch("bcd_lockdown._run")
    def test_disable_winre_already_disabled(self, mock_run):
        mock_run.return_value = (1, "", "already disabled")
        assert bcd_lockdown._disable_winre() is False

    @patch("bcd_lockdown._run")
    def test_enable_winre_success(self, mock_run):
        mock_run.return_value = (0, "", "")
        assert bcd_lockdown._enable_winre() is True
        assert mock_run.call_args.args[0] == ["reagentc", "/enable"]

    @patch("bcd_lockdown._run")
    def test_is_winre_enabled_true(self, mock_run):
        mock_run.return_value = (0, "Windows RE status: Enabled", "")
        assert bcd_lockdown._is_winre_enabled() is True

    @patch("bcd_lockdown._run")
    def test_is_winre_enabled_false(self, mock_run):
        mock_run.return_value = (0, "Windows RE status: Disabled", "")
        assert bcd_lockdown._is_winre_enabled() is False

    def test_run_command_not_found(self):
        rc, stdout, stderr = bcd_lockdown._run(["nonexistent_cmd_12345"])
        assert rc == -1
        assert "not found" in stderr.lower()

    def test_run_success(self):
        rc, stdout, stderr = bcd_lockdown._run(["echo", "hello"])
        assert rc == 0
        assert "hello" in stdout

    # --- Phase 4: BCD state save/restore round-trip ---

    @patch("bcd_lockdown._is_winre_enabled", return_value=True)
    @patch("bcd_lockdown._read_bcd_setting")
    def test_bcd_state_save_and_restore_round_trip(self, mock_read, mock_winre, tmp_bcd_state_file):
        """Phase 4.2: BCD state save/restore round-trip via .bcd_state file."""
        # Simulate current BCD values
        mock_read.return_value = "Yes"

        # Save state
        state = bcd_lockdown.save_bcd_state()
        assert state["winre_enabled"] is True
        assert "settings" in state
        assert tmp_bcd_state_file.exists()

        # Load state
        loaded = bcd_lockdown.load_bcd_state()
        assert loaded is not None
        assert loaded["winre_enabled"] is True
        assert loaded["settings"] == state["settings"]

        # Clear state
        bcd_lockdown.clear_bcd_state()
        assert not tmp_bcd_state_file.exists()

    def test_bcd_state_load_no_file(self, tmp_bcd_state_file):
        assert bcd_lockdown.load_bcd_state() is None

    # --- Phase 4: Verification re-reads ---

    @patch("bcd_lockdown._read_bcd_setting", return_value="No")
    @patch("bcd_lockdown._run")
    def test_set_bcd_setting_verify_success(self, mock_run, mock_read):
        """Phase 4.5: _set_bcd_setting returns True when verification matches."""
        mock_run.return_value = (0, "", "")
        result = bcd_lockdown._set_bcd_setting("recoveryenabled", "No")
        assert result is True

    @patch("bcd_lockdown._read_bcd_setting", return_value="Yes")
    @patch("bcd_lockdown._run")
    def test_set_bcd_setting_verify_failure(self, mock_run, mock_read):
        """Phase 4.5: _set_bcd_setting returns False when verification fails."""
        mock_run.return_value = (0, "", "")  # set succeeded
        # but verification reads "Yes" (didn't change)
        result = bcd_lockdown._set_bcd_setting("recoveryenabled", "No")
        assert result is False

    @patch("bcd_lockdown._run")
    def test_set_bcd_setting_set_fails(self, mock_run):
        """Phase 4.5: _set_bcd_setting returns False when bcdedit fails."""
        mock_run.return_value = (1, "", "Access denied")
        result = bcd_lockdown._set_bcd_setting("recoveryenabled", "No")
        assert result is False

    # --- Phase 4: Rollback is non-fatal ---

    @patch("bcd_lockdown._enable_winre", return_value=False)
    @patch("bcd_lockdown._run")
    def test_rollback_non_fatal(self, mock_run, mock_winre):
        """CC18: Rollback failures are non-fatal (no raise)."""
        # bcdedit /set fails during rollback
        mock_run.return_value = (1, "", "error")

        state = {"winre_enabled": True, "settings": {"recoveryenabled": "Yes"}}
        # Should not raise
        result = bcd_lockdown._rollback_bcd(state)
        assert result is False  # failed, but didn't raise

    # --- Phase 4: Key file survives rollback ---

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_key_file_survives_bcd_rollback(self, mock_read, mock_run, _, __, tmp_bcd_files):
        """Rollback is scoped to boot-state files — must NOT touch key files."""
        key_file = Path(tempfile.mktemp())
        key_file.write_text("fake-key-material")

        # All critical settings fail
        mock_run.return_value = (1, "", "error")
        mock_read.return_value = "Yes"  # verification fails

        bcd_lockdown.apply_bcd_lockdown()

        # Key file must still exist (rollback didn't touch it)
        assert key_file.exists()
        assert key_file.read_text() == "fake-key-material"
        key_file.unlink()

    # --- Phase 4: CC19 critical/best-effort classification ---

    def test_cc19_displaybootmenu_is_critical(self):
        """CC19: displaybootmenu No is CRITICAL (promoted from best-effort)."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_CRITICAL_COMMANDS]
        assert "displaybootmenu" in settings

    def test_cc19_bootstatuspolicy_is_best_effort(self):
        """CC19: bootstatuspolicy IgnoreAllFailures is BEST-EFFORT (demoted from critical)."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS]
        assert "bootstatuspolicy" in settings

    def test_cc19_recoveryenabled_is_critical(self):
        """CC19: recoveryenabled No is CRITICAL."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_CRITICAL_COMMANDS]
        assert "recoveryenabled" in settings

    def test_cc19_hp_f12_boot_menu_is_critical(self):
        """CC19: F12 Boot Menu is CRITICAL for HP (added to critical set)."""
        settings = [s for s, _ in hp_uefi_lockdown.HP_CRITICAL_SETTINGS]
        assert "F12 Boot Menu" in settings
        assert "One-Time Boot Menu" in settings

    def test_cc19_hp_fast_boot_is_best_effort(self):
        """CC19: Fast Boot is BEST-EFFORT for HP."""
        settings = [s for s, _ in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS]
        assert "Fast Boot" in settings

    # --- D-008: BitLocker awareness ---

    def test_d008_check_bitlocker_not_windows(self):
        """D-008: _check_bitlocker returns disabled on non-Windows."""
        with patch("bcd_lockdown.platform.system", return_value="Linux"):
            with patch("bcd_lockdown._DRY_RUN", False):
                result = bcd_lockdown._check_bitlocker()
        assert result["enabled"] is False
        assert result["error"] is None

    def test_d008_check_bitlocker_dry_run_disabled(self):
        """D-008: _check_bitlocker in dry-run with BitLocker disabled."""
        with patch("bcd_lockdown._DRY_RUN", True):
            with patch("bcd_lockdown._DRY_RUN_BITLOCKER_ENABLED", False):
                result = bcd_lockdown._check_bitlocker()
        assert result["enabled"] is False
        assert result["percentage"] == "0%"

    def test_d008_check_bitlocker_dry_run_enabled(self):
        """D-008: _check_bitlocker in dry-run with BitLocker enabled."""
        with patch("bcd_lockdown._DRY_RUN", True):
            with patch("bcd_lockdown._DRY_RUN_BITLOCKER_ENABLED", True):
                result = bcd_lockdown._check_bitlocker()
        assert result["enabled"] is True
        assert result["percentage"] == "100%"

    def test_d008_check_bitlocker_parses_protection_on(self):
        """D-008: _check_bitlocker parses manage-bde output with Protection On."""
        fake_output = (
            "BitLocker Drive Encryption: Configuration Tool version 10.0.19041\n"
            "Copyright (C) Microsoft Corporation. All rights reserved.\n\n"
            "Volume C:\n"
            "    Conversion Status:    100% Encrypted\n"
            "    Percentage Encrypted: 100%\n"
            "    Encryption Method:    XTS-AES 128\n"
            "    Protection Status:    Protection On\n"
            "    Lock Status:          Unlocked\n"
            "    Key Protectors:\n"
            "        Numerical Password\n"
        )
        with patch("bcd_lockdown.platform.system", return_value="Windows"):
            with patch("bcd_lockdown._DRY_RUN", False):
                with patch("bcd_lockdown._run", return_value=(0, fake_output, "")):
                    result = bcd_lockdown._check_bitlocker()
        assert result["enabled"] is True
        assert result["percentage"] == "100%"
        assert result["error"] is None

    def test_d008_check_bitlocker_parses_protection_off(self):
        """D-008: _check_bitlocker parses manage-bde output with Protection Off."""
        fake_output = (
            "Volume C:\n"
            "    Conversion Status:    Fully Decrypted\n"
            "    Protection Status:    Protection Off\n"
        )
        with patch("bcd_lockdown.platform.system", return_value="Windows"):
            with patch("bcd_lockdown._DRY_RUN", False):
                with patch("bcd_lockdown._run", return_value=(0, fake_output, "")):
                    result = bcd_lockdown._check_bitlocker()
        assert result["enabled"] is False

    def test_d008_suspend_bitlocker_dry_run(self):
        """D-008: _suspend_bitlocker in dry-run mode."""
        with patch("bcd_lockdown._DRY_RUN", True):
            with patch("bcd_lockdown._DRY_RUN_BITLOCKER_ENABLED", True):
                result = bcd_lockdown._suspend_bitlocker()
        assert result is True

    def test_d008_resume_bitlocker_dry_run(self):
        """D-008: _resume_bitlocker in dry-run mode."""
        with patch("bcd_lockdown._DRY_RUN", True):
            with patch("bcd_lockdown._DRY_RUN_BITLOCKER_ENABLED", True):
                result = bcd_lockdown._resume_bitlocker()
        assert result is True

    def test_d008_suspend_bitlocker_not_windows(self):
        """D-008: _suspend_bitlocker returns True on non-Windows."""
        with patch("bcd_lockdown.platform.system", return_value="Linux"):
            with patch("bcd_lockdown._DRY_RUN", False):
                result = bcd_lockdown._suspend_bitlocker()
        assert result is True

    def test_d008_resume_bitlocker_not_windows(self):
        """D-008: _resume_bitlocker returns True on non-Windows."""
        with patch("bcd_lockdown.platform.system", return_value="Linux"):
            with patch("bcd_lockdown._DRY_RUN", False):
                result = bcd_lockdown._resume_bitlocker()
        assert result is True

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._resume_bitlocker")
    @patch("bcd_lockdown._suspend_bitlocker", return_value=True)
    @patch("bcd_lockdown._check_bitlocker")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_d008_apply_suspends_and_resumes_bitlocker(
        self, mock_read, mock_run, mock_check, mock_suspend, mock_resume, _, __, tmp_bcd_files
    ):
        """D-008: apply_bcd_lockdown suspends BitLocker before, resumes after."""
        # BitLocker is enabled
        mock_check.return_value = {
            "enabled": True,
            "suspended": False,
            "percentage": "100%",
            "error": None,
        }
        # All BCD settings succeed
        mock_run.return_value = (0, "", "")

        def read_side_effect(setting):
            for sname, sval, _ in bcd_lockdown.BCD_CRITICAL_COMMANDS:
                if setting == sname:
                    return sval
            for sname, sval, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS:
                if setting == sname:
                    return sval
            return None

        mock_read.side_effect = read_side_effect

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is True
        assert result["bitlocker_status"]["enabled"] is True
        # BitLocker should have been suspended and resumed
        mock_suspend.assert_called_once()
        mock_resume.assert_called_once()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._resume_bitlocker")
    @patch("bcd_lockdown._suspend_bitlocker", return_value=True)
    @patch("bcd_lockdown._check_bitlocker")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_d008_apply_resumes_bitlocker_on_rollback(
        self, mock_read, mock_run, mock_check, mock_suspend, mock_resume, _, __, tmp_bcd_files
    ):
        """D-008: BitLocker is resumed even when critical failure triggers rollback."""
        mock_check.return_value = {
            "enabled": True,
            "suspended": False,
            "percentage": "100%",
            "error": None,
        }
        # All BCD settings fail
        mock_run.return_value = (1, "", "error")
        mock_read.return_value = "Yes"  # verification fails

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is False
        assert result["rolled_back"] is True
        # BitLocker should still have been resumed
        mock_suspend.assert_called_once()
        mock_resume.assert_called_once()

    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown.platform.system", return_value="Windows")
    @patch("bcd_lockdown._resume_bitlocker")
    @patch("bcd_lockdown._suspend_bitlocker")
    @patch("bcd_lockdown._check_bitlocker")
    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._read_bcd_setting")
    def test_d008_apply_no_bitlocker_no_suspend(
        self, mock_read, mock_run, mock_check, mock_suspend, mock_resume, _, __, tmp_bcd_files
    ):
        """D-008: BitLocker not enabled → no suspend/resume calls."""
        mock_check.return_value = {
            "enabled": False,
            "suspended": False,
            "percentage": "0%",
            "error": None,
        }
        mock_run.return_value = (0, "", "")

        def read_side_effect(setting):
            for sname, sval, _ in bcd_lockdown.BCD_CRITICAL_COMMANDS:
                if setting == sname:
                    return sval
            for sname, sval, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS:
                if setting == sname:
                    return sval
            return None

        mock_read.side_effect = read_side_effect

        result = bcd_lockdown.apply_bcd_lockdown()

        assert result["success"] is True
        assert result["bitlocker_status"]["enabled"] is False
        # No suspend/resume when BitLocker is not enabled
        mock_suspend.assert_not_called()


class TestReadBcdSetting:
    """Tests for _read_bcd_setting against realistic `bcdedit /enum` output.

    This function was mocked in every other test, which is how it kept using
    `bcdedit /query <entry> <element>` — a syntax Windows rejects with
    "An unknown command was specified". Every verification read therefore failed
    and every lockdown rolled back, on Azure, on HP hardware and on a Windows
    Server 2022 VM alike. These tests run it against real output shapes.
    """

    ENUM_LOADER = """Windows Boot Loader
-------------------
identifier              {default}
device                  partition=C:
path                    \\Windows\\system32\\winload.efi
description             Windows Server
recoveryenabled         Yes
bootstatuspolicy        IgnoreAllFailures
"""

    ENUM_BOOTMGR = """Windows Boot Manager
--------------------
identifier              {bootmgr}
displaybootmenu         No
timeout                 0
"""

    @patch("bcd_lockdown._run")
    def test_reads_a_loader_element(self, mock_run):
        mock_run.return_value = (0, self.ENUM_LOADER, "")
        assert bcd_lockdown._read_bcd_setting("recoveryenabled") == "Yes"

    @patch("bcd_lockdown._run")
    def test_uses_enum_not_query(self, mock_run):
        """Regression: `/query <entry> <element>` is not a supported command."""
        mock_run.return_value = (0, self.ENUM_LOADER, "")
        bcd_lockdown._read_bcd_setting("recoveryenabled")
        cmd = mock_run.call_args[0][0]
        assert "/enum" in cmd
        assert "/query" not in cmd

    @patch("bcd_lockdown._run")
    def test_reads_a_bootmgr_element_from_the_bootmgr_entry(self, mock_run):
        mock_run.return_value = (0, self.ENUM_BOOTMGR, "")
        assert bcd_lockdown._read_bcd_setting("displaybootmenu") == "No"
        cmd = mock_run.call_args[0][0]
        assert "{bootmgr}" in cmd

    @patch("bcd_lockdown._run")
    def test_returns_none_for_an_absent_element(self, mock_run):
        """Must not return a junk token from the header lines."""
        mock_run.return_value = (0, self.ENUM_LOADER, "")
        assert bcd_lockdown._read_bcd_setting("nointegritychecks") is None

    @patch("bcd_lockdown._run")
    def test_returns_none_when_bcdedit_fails(self, mock_run):
        mock_run.return_value = (1, "", "Access denied")
        assert bcd_lockdown._read_bcd_setting("recoveryenabled") is None

    @patch("bcd_lockdown._run")
    def test_value_comes_from_the_element_line_not_a_header(self, mock_run):
        """The old parser returned the last token of the first two-token line.

        For real /enum output that line is the header ("Windows Boot Manager"), so
        it answered "Manager" — or "Loader" — instead of the requested value.
        """
        mock_run.return_value = (0, self.ENUM_BOOTMGR, "")
        assert bcd_lockdown._read_bcd_setting("displaybootmenu") == "No"
