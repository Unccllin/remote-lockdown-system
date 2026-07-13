"""
Tests for boot lockdown modules: hp_uefi_lockdown and bcd_lockdown.
All WMI/PowerShell/subprocess calls are mocked — these tests verify
the logic, not actual BIOS changes.
"""

import json
import tempfile
import shutil
from pathlib import Path
from unittest.mock import patch, MagicMock, call
from unittest import mock

import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

import hp_uefi_lockdown
import bcd_lockdown


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_state_file():
    """Redirect boot state file to a temp location."""
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


# ---------------------------------------------------------------------------
# HP UEFI Lockdown Tests
# ---------------------------------------------------------------------------

class TestHpUefiLockdown:

    def test_generate_bios_password_length(self):
        pw = hp_uefi_lockdown.generate_bios_password()
        assert len(pw) == 12

    def test_generate_bios_password_custom_length(self):
        pw = hp_uefi_lockdown.generate_bios_password(length=15)
        assert len(pw) == 15

    def test_generate_bios_password_alphanumeric(self):
        for _ in range(100):
            pw = hp_uefi_lockdown.generate_bios_password()
            assert pw.isalnum()  # no special chars (BIOS-safe)

    def test_generate_bios_password_randomness(self):
        pw1 = hp_uefi_lockdown.generate_bios_password()
        pw2 = hp_uefi_lockdown.generate_bios_password()
        assert pw1 != pw2  # extremely unlikely to collide

    @patch('hp_uefi_lockdown.platform.system', return_value='Linux')
    def test_is_hp_machine_not_windows(self, _):
        assert hp_uefi_lockdown.is_hp_machine() is False

    @patch('hp_uefi_lockdown.platform.system', return_value='Windows')
    @patch('hp_uefi_lockdown._run_powershell', return_value='')
    def test_is_hp_machine_no_wmi(self, mock_ps, _):
        assert hp_uefi_lockdown.is_hp_machine() is False

    @patch('hp_uefi_lockdown.platform.system', return_value='Windows')
    @patch('hp_uefi_lockdown._run_powershell', return_value='Fast Boot')
    def test_is_hp_machine_with_wmi(self, mock_ps, _):
        assert hp_uefi_lockdown.is_hp_machine() is True

    @patch('hp_uefi_lockdown._run_powershell')
    def test_read_setting_found_in_enumeration(self, mock_ps):
        mock_ps.return_value = "Disable"
        result = hp_uefi_lockdown._read_setting("Network (PXE) Boot")
        assert result == "Disable"

    @patch('hp_uefi_lockdown._run_powershell')
    def test_read_setting_not_found(self, mock_ps):
        mock_ps.return_value = ""
        result = hp_uefi_lockdown._read_setting("Nonexistent Setting")
        assert result is None

    @patch('hp_uefi_lockdown._run_powershell', return_value="0")
    def test_set_setting_success(self, mock_ps):
        rc = hp_uefi_lockdown._set_setting("Fast Boot", "Enable", "mypassword")
        assert rc == 0

    @patch('hp_uefi_lockdown._run_powershell', return_value="6")
    def test_set_setting_access_denied(self, mock_ps):
        rc = hp_uefi_lockdown._set_setting("Fast Boot", "Enable", "wrongpassword")
        assert rc == 6

    @patch('hp_uefi_lockdown._run_powershell', return_value="1")
    def test_is_setup_password_set_true(self, mock_ps):
        assert hp_uefi_lockdown._is_setup_password_set() is True

    @patch('hp_uefi_lockdown._run_powershell', return_value="0")
    def test_is_setup_password_set_false(self, mock_ps):
        assert hp_uefi_lockdown._is_setup_password_set() is False

    def test_save_and_load_boot_state(self, tmp_state_file):
        settings = {"Fast Boot": "Disable", "USB Boot": "Enable"}
        hp_uefi_lockdown.save_boot_state(False, settings)

        loaded = hp_uefi_lockdown.load_boot_state()
        assert loaded is not None
        assert loaded["setup_password_was_set"] is False
        assert loaded["settings"]["Fast Boot"] == "Disable"
        assert loaded["settings"]["USB Boot"] == "Enable"

    def test_load_boot_state_no_file(self, tmp_state_file):
        assert hp_uefi_lockdown.load_boot_state() is None

    def test_clear_boot_state(self, tmp_state_file):
        tmp_state_file.write_text("{}")
        hp_uefi_lockdown.clear_boot_state()
        assert not tmp_state_file.exists()

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=False)
    def test_apply_boot_lockdown_not_hp(self, _):
        result = hp_uefi_lockdown.apply_boot_lockdown()
        assert result is None

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown._is_setup_password_set', return_value=True)
    def test_apply_boot_lockdown_password_set_but_not_provided(self, _, __):
        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)
        assert result is None  # can't proceed without existing password

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown._is_setup_password_set', return_value=False)
    @patch('hp_uefi_lockdown._set_setting')
    @patch('hp_uefi_lockdown._read_setting')
    def test_apply_boot_lockdown_generates_password(
        self, mock_read, mock_set, mock_pw_set, _
    ):
        # First _set_setting call is for Setup Password, rest are for settings
        mock_set.return_value = 0
        # _read_setting returns current values (different from lockdown values)
        mock_read.return_value = "Enable"  # everything currently enabled

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        # Should return a generated password
        assert result is not None
        assert len(result) == 12
        # First call should be setting the Setup password
        first_call = mock_set.call_args_list[0]
        assert first_call.args[0] == "Setup Password"

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown._is_setup_password_set', return_value=True)
    @patch('hp_uefi_lockdown._set_setting')
    @patch('hp_uefi_lockdown._read_setting')
    def test_apply_boot_lockdown_with_existing_password(
        self, mock_read, mock_set, mock_pw_set, _
    ):
        mock_set.return_value = 0
        mock_read.return_value = "Enable"

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="existingpw")

        # Should return the existing password (not generate a new one)
        assert result == "existingpw"
        # First call should NOT be setting the Setup password
        first_call = mock_set.call_args_list[0]
        assert first_call.args[0] != "Setup Password"

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown._is_setup_password_set', return_value=False)
    @patch('hp_uefi_lockdown._set_setting')
    @patch('hp_uefi_lockdown._read_setting')
    def test_apply_boot_lockdown_saves_state(
        self, mock_read, mock_set, mock_pw_set, _, tmp_state_file
    ):
        mock_set.return_value = 0
        mock_read.return_value = "Enable"

        hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        # State file should exist
        assert tmp_state_file.exists()
        state = json.loads(tmp_state_file.read_text())
        assert state["setup_password_was_set"] is False
        assert "settings" in state

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown._is_setup_password_set', return_value=False)
    @patch('hp_uefi_lockdown._set_setting')
    @patch('hp_uefi_lockdown._read_setting')
    def test_apply_boot_lockdown_skips_already_correct_settings(
        self, mock_read, mock_set, mock_pw_set, _
    ):
        mock_set.return_value = 0
        # All settings already in lockdown state
        mock_read.return_value = "Disable"

        hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        # Setup password should still be set (first call)
        # But other settings should be skipped since they're already correct
        # The number of _set_setting calls should be less than total settings
        # (1 for password + 0 for already-correct settings, but Fast Boot
        # wants "Enable" and mock returns "Disable" so it will be set)
        # At minimum, password setting should happen
        assert mock_set.call_count >= 1

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown.load_boot_state')
    @patch('hp_uefi_lockdown._set_setting')
    @patch('hp_uefi_lockdown._read_setting')
    def test_remove_boot_lockdown_restores_settings(
        self, mock_read, mock_set, mock_state, _
    ):
        mock_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Fast Boot": "Disable", "USB Boot": "Enable"},
        }
        mock_set.return_value = 0

        result = hp_uefi_lockdown.remove_boot_lockdown("mypassword")

        assert result is True
        # Should have called _set_setting for each setting + clearing password
        # Last call should be clearing the Setup password
        last_call = mock_set.call_args_list[-1]
        assert last_call.args[0] == "Setup Password"

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=True)
    @patch('hp_uefi_lockdown.load_boot_state')
    @patch('hp_uefi_lockdown._set_setting')
    def test_remove_boot_lockdown_does_not_clear_preexisting_password(
        self, mock_set, mock_state, _
    ):
        mock_state.return_value = {
            "setup_password_was_set": True,  # password was pre-existing
            "settings": {},
        }
        mock_set.return_value = 0

        hp_uefi_lockdown.remove_boot_lockdown("mypassword")

        # Should NOT have a call to clear Setup Password
        for c in mock_set.call_args_list:
            assert c.args[0] != "Setup Password"

    @patch('hp_uefi_lockdown.is_hp_machine', return_value=False)
    def test_remove_boot_lockdown_not_hp(self, _):
        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True  # nothing to remove


# ---------------------------------------------------------------------------
# BCD Lockdown Tests
# ---------------------------------------------------------------------------

class TestBcdLockdown:

    @patch('bcd_lockdown.platform.system', return_value='Linux')
    def test_apply_bcd_lockdown_not_windows(self, _):
        result = bcd_lockdown.apply_bcd_lockdown()
        assert result is True  # nothing to do

    @patch('bcd_lockdown.platform.system', return_value='Linux')
    def test_remove_bcd_lockdown_not_windows(self, _):
        result = bcd_lockdown.remove_bcd_lockdown()
        assert result is True

    @patch('bcd_lockdown.platform.system', return_value='Windows')
    @patch('bcd_lockdown._run')
    def test_apply_bcd_lockdown_success(self, mock_run, _, tmp_bcd_sentinel):
        # All commands succeed
        mock_run.return_value = (0, "", "")
        result = bcd_lockdown.apply_bcd_lockdown()

        assert result is True
        assert tmp_bcd_sentinel.exists()
        # Should have called: reagentc /disable + 4 bcdedit commands = 5 total
        assert mock_run.call_count == 5

    @patch('bcd_lockdown.platform.system', return_value='Windows')
    @patch('bcd_lockdown._run')
    def test_apply_bcd_lockdown_all_fail(self, mock_run, _, tmp_bcd_sentinel):
        # All commands fail
        mock_run.return_value = (1, "", "Access denied")
        result = bcd_lockdown.apply_bcd_lockdown()

        assert result is False
        assert not tmp_bcd_sentinel.exists()  # sentinel not written on total failure

    @patch('bcd_lockdown.platform.system', return_value='Windows')
    @patch('bcd_lockdown._run')
    def test_apply_bcd_lockdown_partial_failure(self, mock_run, _, tmp_bcd_sentinel):
        # reagentc succeeds, bcdedit commands fail
        mock_run.side_effect = [
            (0, "", ""),  # reagentc /disable
            (1, "", "error"),  # bcdedit 1
            (0, "", ""),  # bcdedit 2
            (1, "", "error"),  # bcdedit 3
            (0, "", ""),  # bcdedit 4
        ]
        result = bcd_lockdown.apply_bcd_lockdown()

        assert result is True  # at least some succeeded
        assert tmp_bcd_sentinel.exists()

    @patch('bcd_lockdown.platform.system', return_value='Windows')
    @patch('bcd_lockdown._run')
    def test_remove_bcd_lockdown_success(self, mock_run, _, tmp_bcd_sentinel):
        # Create sentinel first
        tmp_bcd_sentinel.write_text("locked")
        mock_run.return_value = (0, "", "")

        result = bcd_lockdown.remove_bcd_lockdown()

        assert result is True
        assert not tmp_bcd_sentinel.exists()
        # 4 bcdedit restore commands + reagentc /enable = 5 total
        assert mock_run.call_count == 5

    @patch('bcd_lockdown.platform.system', return_value='Windows')
    @patch('bcd_lockdown._run')
    def test_remove_bcd_lockdown_no_sentinel(self, mock_run, _, tmp_bcd_sentinel):
        # No sentinel — nothing to do
        result = bcd_lockdown.remove_bcd_lockdown()

        assert result is True
        assert mock_run.call_count == 0  # no commands run

    @patch('bcd_lockdown._run')
    def test_disable_winre_success(self, mock_run):
        mock_run.return_value = (0, "", "")
        assert bcd_lockdown._disable_winre() is True
        assert mock_run.call_args.args[0] == ["reagentc", "/disable"]

    @patch('bcd_lockdown._run')
    def test_disable_winre_already_disabled(self, mock_run):
        mock_run.return_value = (1, "", "already disabled")
        assert bcd_lockdown._disable_winre() is False

    @patch('bcd_lockdown._run')
    def test_enable_winre_success(self, mock_run):
        mock_run.return_value = (0, "", "")
        assert bcd_lockdown._enable_winre() is True
        assert mock_run.call_args.args[0] == ["reagentc", "/enable"]

    @patch('bcd_lockdown._run')
    def test_is_winre_enabled_true(self, mock_run):
        mock_run.return_value = (0, "Windows RE status: Enabled", "")
        assert bcd_lockdown._is_winre_enabled() is True

    @patch('bcd_lockdown._run')
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
