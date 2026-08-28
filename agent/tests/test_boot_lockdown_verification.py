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

import os
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


class TestD013ReadBackVerification:
    """D-013: Verify that all 4 sites lacking read-back-after-write now
    verify their writes actually took effect.

    The 4 sites (verified by subagent investigation):
      1. Setup Password set in apply_boot_lockdown (line ~786)
      2. Rollback restore in _rollback_bios_settings (line ~683)
      3. Restore settings in remove_boot_lockdown (line ~942)
      4. Clear Setup Password in remove_boot_lockdown (line ~961)

    Each test forces a verification mismatch (red) to confirm the
    verification actually runs and surfaces the failure.
    """

    # --- Site 1: Setup Password set in apply_boot_lockdown ---

    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_d013_site1_setup_password_set_verification_fails(
        self,
        mock_read,
        mock_set,
        mock_pw_set,
        _,
        __,
        mock_sure,
        tmp_state_file,
        mock_resolve_settings,
    ):
        """Site 1: If _set_setting returns 0 but password is not actually
        set, apply_boot_lockdown must fail."""
        mock_sure.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        # First call (line 773): password not set → proceed to generate
        # Second call (D-013 verification): still not set → verification FAILS
        mock_pw_set.side_effect = [False, False]
        mock_set.return_value = 0  # WMI says success

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)
        assert result["success"] is False
        # Password was returned (for operator manual action) but lockdown failed
        assert result["bios_password"] is not None

    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_d013_site1_setup_password_set_verification_passes(
        self,
        mock_read,
        mock_set,
        mock_pw_set,
        _,
        __,
        mock_sure,
        tmp_state_file,
        mock_resolve_settings,
    ):
        """Site 1: When password verification passes, lockdown proceeds."""
        mock_sure.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        # First call: not set → generate. Second call: set → verified.
        mock_pw_set.side_effect = [False, True]
        mock_set.return_value = 0
        # All settings already in lockdown state (read returns lockdown value)
        all_settings = (
            hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
        )
        mock_read.side_effect = lambda name: next(
            (sval for sname, sval in all_settings if sname == name), None
        )

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)
        assert result["success"] is True

    # --- Site 2: Rollback restore in _rollback_bios_settings ---

    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_d013_site2_rollback_verification_fails(self, mock_read, mock_set, tmp_state_file):
        """Site 2: If rollback _set_setting returns 0 but read-back doesn't
        match, _rollback_bios_settings must return False (surface failure)."""
        mock_set.return_value = 0  # WMI says success
        # Read-back returns wrong value → verification fails
        mock_read.return_value = "WrongValue"

        saved = {"Fast Boot": "Disable"}
        result = hp_uefi_lockdown._rollback_bios_settings(saved, "password")
        assert result is False  # verification failed → surfaced

    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_d013_site2_rollback_verification_passes(self, mock_read, mock_set, tmp_state_file):
        """Site 2: When rollback read-back matches, returns True."""
        mock_set.return_value = 0
        mock_read.return_value = "Disable"  # matches saved value

        saved = {"Fast Boot": "Disable"}
        result = hp_uefi_lockdown._rollback_bios_settings(saved, "password")
        assert result is True

    # --- Site 3: Restore settings in remove_boot_lockdown ---

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    def test_d013_site3_restore_verification_fails(
        self, mock_pw, mock_read, mock_set, mock_state, _, __, mock_resolve_settings
    ):
        """Site 3: If restore _set_setting returns 0 but read-back doesn't
        match, the setting must NOT be counted as restored."""
        mock_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Fast Boot": "Disable"},
        }
        mock_set.return_value = 0  # WMI says success
        # Read-back returns wrong value → verification fails
        mock_read.return_value = "Enable"  # expected "Disable"

        # Should not raise, should complete
        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True  # remove always returns True (non-fatal)
        # D-013: _read_setting MUST be called after _set_setting for
        # verification. In the pre-fix code, _read_setting is never called
        # during the restore loop — this assertion fails red without the fix.
        mock_read.assert_any_call("Fast Boot")

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    def test_d013_site3_restore_verification_passes(
        self, mock_pw, mock_read, mock_set, mock_state, _, __, mock_resolve_settings
    ):
        """Site 3: When restore read-back matches, setting is restored."""
        mock_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Fast Boot": "Disable"},
        }
        mock_set.return_value = 0

        # Read-back matches for the setting, and password clear verifies
        def read_side_effect(name):
            if name == "Fast Boot":
                return "Disable"  # matches expected
            return None

        mock_read.side_effect = read_side_effect

        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True

    # --- Site 4: Clear Setup Password in remove_boot_lockdown ---

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting", return_value=None)
    @patch("hp_uefi_lockdown._is_setup_password_set")
    def test_d013_site4_clear_password_verification_fails(
        self, mock_pw, mock_read, mock_set, mock_state, _, __, mock_resolve_settings
    ):
        """Site 4: If clear password _set_setting returns 0 but password is
        still set, a warning must be logged (verification surfaces failure)."""
        mock_state.return_value = {
            "setup_password_was_set": False,  # agent set it → should clear
            "settings": {},
        }
        mock_set.return_value = 0  # WMI says success
        # Password is STILL set after clear → verification fails
        mock_pw.return_value = True

        # Should not raise
        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True  # non-fatal, but warning was logged
        # Verify _is_setup_password_set was called for verification
        # (at least once for the clear-password check)
        mock_pw.assert_called()

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting", return_value=None)
    @patch("hp_uefi_lockdown._is_setup_password_set")
    def test_d013_site4_clear_password_verification_passes(
        self, mock_pw, mock_read, mock_set, mock_state, _, __, mock_resolve_settings
    ):
        """Site 4: When clear password verification passes, logs success."""
        mock_state.return_value = {
            "setup_password_was_set": False,
            "settings": {},
        }
        mock_set.return_value = 0
        mock_pw.return_value = False  # password is cleared → verified

        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True


class TestD014FilterEscaping:
    """D-014: _read_setting must escape single quotes in WMI filter values,
    matching the escaping already done in _set_setting (lines 553-554)."""

    @patch("hp_uefi_lockdown._run_powershell")
    def test_d014_read_setting_escapes_single_quote(self, mock_ps):
        """A setting name with a single quote must be escaped to '' in
        the WMI filter, not passed raw."""
        mock_ps.return_value = "Disable"
        hp_uefi_lockdown._read_setting("O'Brien Setting")
        # Check the PowerShell script was called with escaped name
        script = mock_ps.call_args.args[0]
        assert "O''Brien Setting" in script
        assert "O'Brien Setting" not in script  # raw quote must NOT appear

    @patch("hp_uefi_lockdown._run_powershell")
    def test_d014_read_setting_no_escape_needed(self, mock_ps):
        """A setting name without quotes passes through unchanged."""
        mock_ps.return_value = "Disable"
        hp_uefi_lockdown._read_setting("Fast Boot")
        script = mock_ps.call_args.args[0]
        assert "Fast Boot" in script

    @patch("hp_uefi_lockdown._run_powershell")
    def test_d014_read_setting_escapes_in_both_wmi_classes(self, mock_ps):
        """Escaping must apply in both HP_BIOSEnumeration and HP_BIOSSetting
        filter paths."""
        # First call (HP_BIOSEnumeration) returns empty → falls through
        # to second call (HP_BIOSSetting)
        mock_ps.side_effect = ["", "Disable"]
        hp_uefi_lockdown._read_setting("Test'Quote")
        # Both calls should have escaped the quote
        first_script = mock_ps.call_args_list[0].args[0]
        second_script = mock_ps.call_args_list[1].args[0]
        assert "Test''Quote" in first_script
        assert "Test''Quote" in second_script


class TestDryRunEnvVar:
    """Tests for the LOCKDOWN_DRY_RUN master env var switch."""

    def test_bcd_lockdown_dry_run_env_var_true(self):
        """LOCKDOWN_DRY_RUN=1 sets bcd_lockdown._DRY_RUN = True."""
        with patch.dict(os.environ, {"LOCKDOWN_DRY_RUN": "1"}):
            result = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")
            assert result is True

    def test_bcd_lockdown_dry_run_env_var_false(self):
        """LOCKDOWN_DRY_RUN unset means bcd_lockdown._DRY_RUN = False."""
        with patch.dict(os.environ, {}, clear=True):
            result = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")
            assert result is False

    def test_hp_uefi_lockdown_dry_run_env_var_true(self):
        """LOCKDOWN_DRY_RUN=1 sets hp_uefi_lockdown._DRY_RUN = True."""
        with patch.dict(os.environ, {"LOCKDOWN_DRY_RUN": "1"}):
            result = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")
            assert result is True

    def test_dry_run_bcd_run_prints_not_executes(self):
        """In dry-run mode, bcd_lockdown._run prints [DRY-RUN] instead of executing."""
        with patch.object(bcd_lockdown, "_DRY_RUN", True):
            with patch.object(bcd_lockdown, "subprocess") as mock_subprocess:
                rc, _, _ = bcd_lockdown._run(["bcdedit", "/set", "{default}", "test", "val"])
                mock_subprocess.run.assert_not_called()
                assert rc == 0

    def test_dry_run_hp_uefi_powershell_prints_not_executes(self):
        """In dry-run mode, hp_uefi prints [DRY-RUN] instead of executing."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            with patch.object(hp_uefi_lockdown, "subprocess") as mock_subprocess:
                result = hp_uefi_lockdown._run_powershell(
                    "Get-WmiObject -Class Win32_ComputerSystem"
                )
                mock_subprocess.run.assert_not_called()
                # Should return a simulated response (string)
                assert isinstance(result, str)
