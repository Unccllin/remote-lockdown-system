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

    @patch("hp_uefi_lockdown.platform.system", return_value="Linux")
    def test_is_hp_machine_not_windows(self, _):
        assert hp_uefi_lockdown.is_hp_machine() is False

    @patch("hp_uefi_lockdown.platform.system", return_value="Windows")
    @patch("hp_uefi_lockdown._run_powershell", return_value="")
    def test_is_hp_machine_no_wmi(self, mock_ps, _):
        assert hp_uefi_lockdown.is_hp_machine() is False

    @patch("hp_uefi_lockdown.platform.system", return_value="Windows")
    @patch("hp_uefi_lockdown._run_powershell", return_value="Fast Boot")
    def test_is_hp_machine_with_wmi(self, mock_ps, _):
        assert hp_uefi_lockdown.is_hp_machine() is True

    @patch("hp_uefi_lockdown._run_powershell")
    def test_read_setting_found_in_enumeration(self, mock_ps):
        mock_ps.return_value = "Disable"
        result = hp_uefi_lockdown._read_setting("Network (PXE) Boot")
        assert result == "Disable"

    @patch("hp_uefi_lockdown._run_powershell")
    def test_read_setting_not_found(self, mock_ps):
        mock_ps.return_value = ""
        result = hp_uefi_lockdown._read_setting("Nonexistent Setting")
        assert result is None

    @patch("hp_uefi_lockdown._run_powershell")
    def test_set_setting_success(self, mock_ps):
        # _set_setting returns the WMI return code
        mock_ps.return_value = "0"
        rc = hp_uefi_lockdown._set_setting("Fast Boot", "Enable", "mypassword")
        assert rc == 0

    @patch("hp_uefi_lockdown._run_powershell")
    def test_set_setting_access_denied(self, mock_ps):
        mock_ps.return_value = "6"
        rc = hp_uefi_lockdown._set_setting("Fast Boot", "Enable", "wrongpassword")
        assert rc == 6

    @patch("hp_uefi_lockdown._run_powershell")
    def test_is_setup_password_set_true(self, mock_ps):
        mock_ps.return_value = "1"
        assert hp_uefi_lockdown._is_setup_password_set() is True

    @patch("hp_uefi_lockdown._run_powershell")
    def test_is_setup_password_set_false(self, mock_ps):
        mock_ps.return_value = "0"
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

    # --- Phase 4: _is_admin() check ---

    @patch("hp_uefi_lockdown._is_admin", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    def test_apply_boot_lockdown_not_admin_fail_fast(self, _, __):
        """Phase 4.1: Admin check fails fast before any state writes."""
        result = hp_uefi_lockdown.apply_boot_lockdown()
        assert result["success"] is False
        assert result["bios_password"] is None
        assert result["rolled_back"] is False  # nothing to roll back

    # --- Phase 4: dict return type ---

    @patch("hp_uefi_lockdown.is_hp_machine", return_value=False)
    def test_apply_boot_lockdown_not_hp(self, _):
        result = hp_uefi_lockdown.apply_boot_lockdown()
        assert result["not_hp"] is True
        assert result["success"] is True  # not an error
        assert result["bios_password"] is None

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    def test_apply_boot_lockdown_password_set_but_not_provided(self, _, __, ___):
        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)
        assert result["success"] is False
        assert result["bios_password"] is None  # can't proceed

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_generates_password(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        # _set_setting for Setup Password returns 0 (success)
        # For other settings, _set_and_verify calls _set_setting then _read_setting
        # Setup _set_setting to return 0 for all
        mock_set.return_value = 0
        # Track read calls: state save + apply loop = old value, verification = lockdown value
        read_counts = {}

        def smart_read(name):
            for sname, sval in (
                hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
            ):
                if name == sname:
                    count = read_counts.get(name, 0)
                    read_counts[name] = count + 1
                    if count < 2:
                        return "Enable" if sval == "Disable" else "Disable"
                    return sval
            return None

        mock_read.side_effect = smart_read

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        assert result["success"] is True
        assert result["bios_password"] is not None
        assert len(result["bios_password"]) == 12
        # First call should be setting the Setup password
        first_call = mock_set.call_args_list[0]
        assert first_call.args[0] == "Setup Password"

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._check_secure_boot", return_value={"enabled": False, "warning": None})
    @patch(
        "hp_uefi_lockdown._check_sure_admin",
        return_value={
            "sure_admin_detected": False,
            "any_sure_feature": False,
            "warning": None,
        },
    )
    def test_missing_uefi_password_records_the_reason(self, *_):
        """A dead end must name the next action, not just report zero layers.

        Measured on MOLE (S271): the ACK carried boot_lock_status=partial with every layer at
        0 and no field explaining why, so "boot lock did not apply" was unactionable. The
        cause — the firmware already has a Setup password and the agent has none configured —
        was only in the log.
        """
        result = hp_uefi_lockdown.apply_boot_lockdown()

        assert result["reason"] == "existing_bios_password_without_uefi_password"
        assert "uefi_password" in result["next_action"]
        assert result["critical_applied"] == 0

    @patch("hp_uefi_lockdown._is_admin", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._check_secure_boot", return_value={"enabled": False, "warning": None})
    @patch(
        "hp_uefi_lockdown._check_sure_admin",
        return_value={"sure_admin_detected": False, "any_sure_feature": False, "warning": None},
    )
    def test_missing_admin_records_the_reason(self, *_):
        result = hp_uefi_lockdown.apply_boot_lockdown()
        assert result["reason"] == "requires_admin"

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_with_existing_password(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        mock_set.return_value = 0
        # Track read calls per setting:
        # Call 0: state save loop → return old value
        # Call 1: apply loop check → return old value (so _set_and_verify is called)
        # Call 2+: verification re-read → return lockdown value
        read_counts = {}

        def smart_read(name):
            for sname, sval in (
                hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
            ):
                if name == sname:
                    count = read_counts.get(name, 0)
                    read_counts[name] = count + 1
                    if count < 2:
                        # State save + apply loop check: return old value
                        return "Enable" if sval == "Disable" else "Disable"
                    else:
                        # Verification re-read: return lockdown value
                        return sval
            return None

        mock_read.side_effect = smart_read

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="existingpw")

        assert result["success"] is True
        # A pre-existing password is NOT echoed back (S271): the operator supplied it, and
        # reporting it made the backend serve an unverified credential as this device's own.
        assert result.get("bios_password") is None
        # First call should NOT be setting the Setup password (password already set)
        first_call = mock_set.call_args_list[0]
        assert first_call.args[0] != "Setup Password"

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_saves_state(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        mock_set.return_value = 0
        read_counts = {}

        def smart_read(name):
            for sname, sval in (
                hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
            ):
                if name == sname:
                    count = read_counts.get(name, 0)
                    read_counts[name] = count + 1
                    if count < 2:
                        return "Enable" if sval == "Disable" else "Disable"
                    return sval
            return None

        mock_read.side_effect = smart_read

        hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        assert tmp_state_file.exists()
        state = json.loads(tmp_state_file.read_text())
        assert state["setup_password_was_set"] is False
        assert "settings" in state

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_skips_already_correct_settings(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        mock_set.return_value = 0

        # All settings already in lockdown state — return lockdown value on ALL reads
        def read_side_effect(name):
            for sname, sval in (
                hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
            ):
                if name == sname:
                    return sval
            return None

        mock_read.side_effect = read_side_effect

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)
        assert result["success"] is True
        # Setup password should still be set (first call)
        assert mock_set.call_count >= 1

    # --- Phase 4: Critical failure + rollback (CC18) ---

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_critical_failure_triggers_rollback(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """CC18: a REFUSED critical write triggers rollback of all BIOS changes.

        A write the firmware accepts but has not committed yet is `pending_reboot`, not a
        failure — see test_apply_boot_lockdown_pending_reboot_is_not_a_rollback (S271).
        """
        critical_names = {name for name, _ in hp_uefi_lockdown.HP_CRITICAL_SETTINGS}

        def set_side_effect(name, value, password):
            # Refused by the firmware for the critical settings; password write is fine.
            return 6 if name in critical_names else 0

        mock_set.side_effect = set_side_effect

        def read_side_effect(name):
            if name == "Setup Password":
                return None  # password is a dict, not readable
            # Return the OPPOSITE of lockdown value (verification fails)
            for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                if name == sname:
                    return "Enable" if sval == "Disable" else "Disable"
            for sname, sval in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS:
                if name == sname:
                    return sval  # best-effort verifies OK
            return None

        mock_read.side_effect = read_side_effect

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        assert result["success"] is False
        assert result["rolled_back"] is True
        # CC18: Password is STILL returned even on critical failure
        assert result["bios_password"] is not None
        assert len(result["bios_password"]) == 12

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting", return_value=0)
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_pending_reboot_is_not_a_rollback(
        self, mock_read, _set, _pw_set, __, ___, tmp_state_file, mock_resolve_settings
    ):
        """Accepted writes that have not committed yet must not be undone.

        Measured on MOLE (S271): five settings were written and accepted (no `failed:` warning
        for any), the read-back showed the old values because HP commits at the next boot, and
        the agent rolled back — producing "rollback completed with errors" plus a firmware state
        nobody had recorded. Now the result says `pending_reboot`, keeps the boot-state file and
        does not roll back.
        """
        critical_names = {name for name, _ in hp_uefi_lockdown.HP_CRITICAL_SETTINGS}
        best_effort_names = {name for name, _ in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS}

        def read_side_effect(name):
            if name == "Setup Password":
                return None
            if name in critical_names:
                for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                    if name == sname:
                        return "Enable" if sval == "Disable" else "Disable"  # pre-boot value
            if name in best_effort_names:
                for sname, sval in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS:
                    if name == sname:
                        return sval
            return None

        mock_read.side_effect = read_side_effect

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        assert result["pending_reboot"] is True
        assert result["rolled_back"] is False
        assert result["success"] is True
        assert result["critical_pending"] > 0
        assert result["critical_applied"] == 0
        # The original values must stay recoverable until a boot proves where the firmware
        # landed, so the state file is NOT deleted on this path.
        assert hp_uefi_lockdown.BOOT_STATE_FILE.exists()

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_rollback_does_not_clear_password(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """CC18: Rollback must NOT clear the freshly-set Setup Password."""
        critical_names = {name for name, _ in hp_uefi_lockdown.HP_CRITICAL_SETTINGS}

        def set_side_effect(name, value, password):
            return 6 if name in critical_names else 0

        mock_set.side_effect = set_side_effect

        def read_side_effect(name):
            if name == "Setup Password":
                return None
            for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                if name == sname:
                    return "Enable" if sval == "Disable" else "Disable"
            return None

        mock_read.side_effect = read_side_effect

        hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        # Verify _set_setting was called for rollback (restoring settings)
        # but NOT for clearing Setup Password
        setup_pw_calls = [c for c in mock_set.call_args_list if c.args[0] == "Setup Password"]
        # First call is setting the password (value != "")
        # There should be NO second call with value="" (clearing)
        assert len(setup_pw_calls) == 1
        assert setup_pw_calls[0].args[1] != ""  # setting, not clearing

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_best_effort_failure_no_rollback(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """A REFUSED best-effort write does NOT trigger rollback."""
        best_effort_names = {name for name, _ in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS}
        mock_set.side_effect = lambda name, value, password: 6 if name in best_effort_names else 0

        def read_side_effect(name):
            if name == "Setup Password":
                return None
            # Critical settings verify OK
            for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                if name == sname:
                    return sval
            for sname, sval in hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS:
                if name == sname:
                    return "Enable" if sval == "Disable" else "Disable"
            return None

        mock_read.side_effect = read_side_effect

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        assert result["success"] is True
        assert result["partial"] is True
        assert result["rolled_back"] is False
        assert result["best_effort_failed"] > 0

    # --- Phase 4: Verification re-reads ---

    @patch("hp_uefi_lockdown._set_setting", return_value=0)
    @patch("hp_uefi_lockdown._read_setting")
    def test_set_and_verify_success(self, mock_read, _):
        """Verification matching means applied."""
        mock_read.return_value = "Disable"
        assert hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password") == "applied"

    @patch("hp_uefi_lockdown._set_setting", return_value=0)
    @patch("hp_uefi_lockdown._read_setting")
    def test_set_and_verify_is_pending_when_the_read_back_lags(self, mock_read, _):
        """An accepted write whose read-back still shows the old value is NOT a failure.

        Measured on MOLE (S271): HP accepts the write and commits it at the next boot, so an
        in-session read returns the previous value. Calling that failure made the agent roll
        back writes that had landed.
        """
        mock_read.return_value = "Enable"  # unchanged in this session
        assert (
            hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password") == "pending_reboot"
        )

    @patch("hp_uefi_lockdown._set_setting", return_value=6)
    def test_set_and_verify_set_fails(self, _):
        """A refused write is the only failure."""
        assert hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password") == "failed"

    # --- Phase 4: Rollback is non-fatal ---

    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_rollback_non_fatal(self, mock_read, mock_set, tmp_state_file):
        """CC18: Rollback failures are non-fatal (no raise)."""
        # _set_setting fails during rollback
        mock_set.return_value = 4  # Failed
        mock_read.return_value = "Enable"

        saved = {"USB Boot": "Enable"}
        # Should not raise
        result = hp_uefi_lockdown._rollback_bios_settings(saved, "password")
        assert result is False  # failed, but didn't raise

    # --- Phase 4: Key file survives rollback ---

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_key_file_survives_rollback(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file
    ):
        """Rollback is scoped to boot-state files — must NOT touch key files."""
        # Create a fake key file
        key_file = Path(tempfile.mktemp())
        key_file.write_text("fake-key-material")

        # Make critical settings fail
        mock_set.return_value = 0

        def read_side_effect(name):
            if name == "Setup Password":
                return None
            for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                if name == sname:
                    return "Enable" if sval == "Disable" else "Disable"
            return None

        mock_read.side_effect = read_side_effect

        hp_uefi_lockdown.apply_boot_lockdown(existing_password=None)

        # Key file must still exist (rollback didn't touch it)
        assert key_file.exists()
        assert key_file.read_text() == "fake-key-material"
        key_file.unlink()

    # --- remove_boot_lockdown tests ---

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_remove_boot_lockdown_restores_settings(self, mock_read, mock_set, mock_state, _, __):
        mock_state.return_value = {
            "setup_password_was_set": False,
            "settings": {"Fast Boot": "Disable", "USB Boot": "Enable"},
        }
        mock_set.return_value = 0

        # The verdict is now "every restore verified", so the verification has to agree —
        # otherwise this asserts True for a restore that changed nothing (S271).
        with patch.object(hp_uefi_lockdown, "_verify_setting", return_value=True):
            result = hp_uefi_lockdown.remove_boot_lockdown("mypassword")

        assert result is True
        # Last call should be clearing the Setup password (was set by agent)
        last_call = mock_set.call_args_list[-1]
        assert last_call.args[0] == "Setup Password"

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state")
    @patch("hp_uefi_lockdown._set_setting")
    def test_remove_boot_lockdown_does_not_clear_preexisting_password(
        self, mock_set, mock_state, _, __
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

    @patch("hp_uefi_lockdown._is_admin", return_value=False)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    def test_remove_boot_lockdown_not_admin(self, _, __):
        """Phase 4.1: Admin check for removal too."""
        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is False

    @patch("hp_uefi_lockdown.is_hp_machine", return_value=False)
    def test_remove_boot_lockdown_not_hp(self, _):
        result = hp_uefi_lockdown.remove_boot_lockdown("password")
        assert result is True  # nothing to remove

    # --- D-009: Model-aware setting name resolution ---

    def test_d009_concepts_defined(self):
        """D-009: All canonical concepts are defined."""
        expected = {
            "network_boot",
            "usb_boot",
            "legacy_boot",
            "boot_menu",
            "fast_boot",
            "f12_password",
            "dma_protection",  # T3: VT-d/IOMMU DMA protection
        }
        assert set(hp_uefi_lockdown.CONCEPTS.keys()) == expected

    def test_d009_default_setting_names_cover_all_concepts(self):
        """D-009: DEFAULT_SETTING_NAMES has entries for all concepts."""
        for concept in hp_uefi_lockdown.CONCEPTS:
            assert concept in hp_uefi_lockdown.DEFAULT_SETTING_NAMES
            assert len(hp_uefi_lockdown.DEFAULT_SETTING_NAMES[concept]) > 0

    def test_d009_detect_hp_model_dry_run(self):
        """D-009: _detect_hp_model returns a model name in dry-run mode."""
        with patch("hp_uefi_lockdown._DRY_RUN", True):
            model = hp_uefi_lockdown._detect_hp_model()
        assert model is not None
        assert "HP" in model or "EliteBook" in model or "EliteDesk" in model

    def test_d009_detect_hp_model_not_windows(self):
        """D-009: _detect_hp_model returns None on non-Windows."""
        with patch("hp_uefi_lockdown._DRY_RUN", False):
            with patch("hp_uefi_lockdown.platform.system", return_value="Linux"):
                model = hp_uefi_lockdown._detect_hp_model()
        assert model is None

    def test_d009_load_model_overrides_no_file(self):
        """D-009: _load_model_overrides returns empty dict when no override file."""
        import hp_uefi_lockdown as mod

        original = mod._MODEL_OVERRIDES
        mod._MODEL_OVERRIDES = None  # Reset cache
        with patch.object(mod, "MODEL_OVERRIDES_FILE", Path("/nonexistent/file.json")):
            result = mod._load_model_overrides()
        assert result == {}
        mod._MODEL_OVERRIDES = original  # Restore

    def test_d009_resolve_setting_names_uses_first_match(self):
        """D-009: _resolve_setting_names picks the first candidate that exists."""

        # Mock _read_setting to return non-None only for specific names
        def mock_read(name):
            # Only "PXE Boot" exists (not "Network (PXE) Boot")
            if name == "PXE Boot":
                return "Enable"
            if name == "USB Storage Boot":
                return "Enable"
            if name == "CSM Support":
                return "Enable"
            if name == "Boot Menu":
                return "Enable"
            if name == "FastBoot":
                return "Disable"
            return None

        with patch("hp_uefi_lockdown._DRY_RUN", True):
            with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
                with patch("hp_uefi_lockdown._load_model_overrides", return_value={}):
                    critical, best_effort = hp_uefi_lockdown._resolve_setting_names()

        # Should have picked the non-default names
        critical_names = [s[0] for s in critical]
        assert "PXE Boot" in critical_names  # 3rd candidate for network_boot
        assert "USB Storage Boot" in critical_names  # 2nd candidate for usb_boot
        assert "CSM Support" in critical_names  # 3rd candidate for legacy_boot
        assert "Boot Menu" in critical_names  # 3rd candidate for boot_menu

        best_effort_names = [s[0] for s in best_effort]
        assert "FastBoot" in best_effort_names  # 2nd candidate for fast_boot

    def test_d009_resolve_setting_names_with_model_override(self):
        """D-009: _resolve_setting_names uses model-specific overrides when available."""
        model_overrides = {
            "HP EliteBook 840 G7": {
                "network_boot": ["Custom PXE Name"],
                "usb_boot": ["Custom USB Name"],
                "legacy_boot": ["Custom Legacy Name"],
                "boot_menu": ["Custom Boot Menu Name"],
                "fast_boot": ["Custom Fast Boot Name"],
                "f12_password": ["Custom F12 Password Name"],
            }
        }

        def mock_read(name):
            # All custom names exist
            custom_names = {
                "Custom PXE Name",
                "Custom USB Name",
                "Custom Legacy Name",
                "Custom Boot Menu Name",
                "Custom Fast Boot Name",
                "Custom F12 Password Name",
            }
            if name in custom_names:
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._DRY_RUN", True):
            with patch("hp_uefi_lockdown._detect_hp_model", return_value="HP EliteBook 840 G7"):
                with patch("hp_uefi_lockdown._load_model_overrides", return_value=model_overrides):
                    with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
                        critical, best_effort = hp_uefi_lockdown._resolve_setting_names()

        critical_names = [s[0] for s in critical]
        assert "Custom PXE Name" in critical_names
        assert "Custom USB Name" in critical_names
        assert "Custom Legacy Name" in critical_names
        assert "Custom Boot Menu Name" in critical_names

        best_effort_names = [s[0] for s in best_effort]
        assert "Custom Fast Boot Name" in best_effort_names
        assert "Custom F12 Password Name" in best_effort_names

    def test_d009_resolve_setting_names_no_matches(self):
        """D-009: _resolve_setting_names returns empty lists when no settings match."""
        with patch("hp_uefi_lockdown._DRY_RUN", True):
            with patch("hp_uefi_lockdown._read_setting", return_value=None):
                with patch("hp_uefi_lockdown._load_model_overrides", return_value={}):
                    critical, best_effort = hp_uefi_lockdown._resolve_setting_names()

        assert critical == []
        assert best_effort == []

    def test_d009_model_overrides_file_is_valid_json(self):
        """D-009: The sample hp_model_overrides.json is valid JSON."""
        import json

        overrides_path = Path(hp_uefi_lockdown.__file__).parent / "hp_model_overrides.json"
        if overrides_path.exists():
            data = json.loads(overrides_path.read_text())
            # Should have _comment and _example keys
            assert "_comment" in data
            assert "_example" in data

    def test_d009_model_override_case_insensitive(self):
        """D-009: Model matching should be case-insensitive."""
        model_overrides = {
            "hp elitebook 840 g7": {"network_boot": ["Custom PXE"]},
        }
        with patch("hp_uefi_lockdown._DRY_RUN", True):
            with patch("hp_uefi_lockdown._detect_hp_model", return_value="HP EliteBook 840 G7"):
                with patch("hp_uefi_lockdown._load_model_overrides", return_value=model_overrides):
                    with patch("hp_uefi_lockdown._read_setting", return_value="Enable"):
                        critical, _ = hp_uefi_lockdown._resolve_setting_names()
        critical_names = [s[0] for s in critical]
        assert "Custom PXE" in critical_names

    def test_d009_detect_hp_model_whitespace(self):
        """D-009: _detect_hp_model returns None for whitespace-only output."""
        with patch("hp_uefi_lockdown._DRY_RUN", False):
            with patch("hp_uefi_lockdown.platform.system", return_value="Windows"):
                with patch("hp_uefi_lockdown._run_powershell", return_value="   "):
                    model = hp_uefi_lockdown._detect_hp_model()
        assert model is None

    def test_d009_resolve_setting_names_invalid_override_type(self):
        """D-009: Invalid override value type (not str or list) is ignored."""
        model_overrides = {
            "HP EliteBook 840 G7": {"network_boot": 123},  # Invalid type
        }
        with patch("hp_uefi_lockdown._DRY_RUN", True):
            with patch("hp_uefi_lockdown._detect_hp_model", return_value="HP EliteBook 840 G7"):
                with patch("hp_uefi_lockdown._load_model_overrides", return_value=model_overrides):
                    with patch("hp_uefi_lockdown._read_setting", return_value=None):
                        critical, _ = hp_uefi_lockdown._resolve_setting_names()
        # Invalid override should be ignored — no settings resolved
        assert critical == []

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch(
        "hp_uefi_lockdown._check_sure_admin",
        return_value={
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        },
    )
    @patch(
        "hp_uefi_lockdown._check_sure_start_bsp",
        return_value={"enabled": False, "setting_name": None, "warning": None},
    )
    @patch(
        "hp_uefi_lockdown._check_bitlocker",
        return_value={"enabled": False, "suspended": False, "percentage": "0%", "error": None},
    )
    def test_d009_apply_no_critical_settings_returns_failure(
        self, _, __, ___, ____, _____, tmp_state_file
    ):
        """D-009: apply_boot_lockdown returns success=False when no critical settings found."""
        with patch.object(
            hp_uefi_lockdown,
            "_resolve_setting_names",
            return_value=([], []),  # No settings resolved
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="testpw")
        assert result["success"] is False
        assert result.get("no_critical_settings") is True
        assert result["critical_applied"] == 0

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._set_setting", return_value=0)
    @patch("hp_uefi_lockdown._read_setting", return_value=None)
    def test_d009_remove_uses_model_aware_resolution(self, _, __, ___, tmp_state_file):
        """D-009: remove_boot_lockdown uses _resolve_setting_names for restoration."""
        custom_settings = [("Custom PXE", "Disable"), ("Custom USB", "Disable")]
        with (
            patch.object(
                hp_uefi_lockdown,
                "_resolve_setting_names",
                return_value=(custom_settings, []),
            ),
            patch("hp_uefi_lockdown.load_boot_state", return_value=None),
            patch.object(hp_uefi_lockdown, "_set_setting", return_value=0) as mock_set,
            patch.object(hp_uefi_lockdown, "_verify_setting", return_value=True),
        ):
            result = hp_uefi_lockdown.remove_boot_lockdown(bios_password="testpw")

        assert result is True
        # D-009 is about WHICH names are used, so assert that rather than the verdict alone.
        names = [c.args[0] for c in mock_set.call_args_list]
        assert "Custom PXE" in names and "Custom USB" in names

    # --- D-010: HP Sure Admin / Sure Run / Sure Start awareness ---

    def test_d010_check_sure_admin_none_detected(self):
        """D-010: _check_sure_admin returns all-False when no Sure features exist."""
        with patch("hp_uefi_lockdown._read_setting", return_value=None):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is False
        assert result["sure_run_detected"] is False
        assert result["sure_start_detected"] is False
        assert result["any_sure_feature"] is False
        assert result["warning"] is None

    def test_d010_check_sure_admin_detected(self):
        """D-010: _check_sure_admin detects Sure Admin (EBAM) enabled."""

        def mock_read(name):
            if name in (
                "Enhanced BIOS Authentication Mode (EBAM)",
                "EBAM",
                "Sure Admin",
                "HP Sure Admin",
            ):
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is True
        assert result["sure_run_detected"] is False
        assert result["sure_start_detected"] is False
        assert result["any_sure_feature"] is True
        assert result["warning"] is not None
        assert "Sure Admin" in result["warning"]

    def test_d010_check_sure_start_detected(self):
        """D-010: _check_sure_admin detects Sure Start enabled."""

        def mock_read(name):
            if name in (
                "Sure Start BIOS Settings Protection",
                "BIOS Settings Protection",
                "Sure Start",
                "HP Sure Start",
            ):
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is False
        assert result["sure_start_detected"] is True
        assert result["any_sure_feature"] is True
        assert "Sure Start" in result["warning"]

    def test_d010_check_sure_run_detected(self):
        """D-010: _check_sure_admin detects Sure Run enabled."""

        def mock_read(name):
            if name in ("HP Sure Run Current State", "HP Sure Run", "Sure Run"):
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_run_detected"] is True
        assert result["any_sure_feature"] is True
        assert "Sure Run" in result["warning"]

    def test_d010_check_sure_admin_disabled(self):
        """D-010: Sure Admin (EBAM) setting exists but is disabled → not detected."""

        def mock_read(name):
            if name in (
                "Enhanced BIOS Authentication Mode (EBAM)",
                "EBAM",
                "Sure Admin",
                "HP Sure Admin",
            ):
                return "Disable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is False
        assert result["any_sure_feature"] is False
        assert result["warning"] is None

    def test_d010_check_all_sure_features_detected(self):
        """D-010: All three Sure features detected simultaneously."""

        def mock_read(name):
            if name in (
                "Enhanced BIOS Authentication Mode (EBAM)",
                "EBAM",
                "Sure Admin",
                "HP Sure Admin",
            ):
                return "Enable"
            if name in ("HP Sure Run Current State", "HP Sure Run", "Sure Run"):
                return "Enable"
            if name in (
                "Sure Start BIOS Settings Protection",
                "BIOS Settings Protection",
                "Sure Start",
                "HP Sure Start",
            ):
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is True
        assert result["sure_run_detected"] is True
        assert result["sure_start_detected"] is True
        assert result["any_sure_feature"] is True
        assert "Sure Admin" in result["warning"]
        assert "Sure Run" in result["warning"]
        assert "Sure Start" in result["warning"]

    def test_d010_check_sure_admin_alternative_enabled_values(self):
        """D-010: Sure Admin detected with alternative enabled values (Yes, Active)."""

        def mock_read(name):
            if name in (
                "Enhanced BIOS Authentication Mode (EBAM)",
                "EBAM",
                "Sure Admin",
                "HP Sure Admin",
            ):
                return "Yes"
            if name in ("HP Sure Run Current State", "HP Sure Run", "Sure Run"):
                return "Active"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is True
        assert result["sure_run_detected"] is True
        assert result["any_sure_feature"] is True

    def test_d010_sure_admin_silent_failure_warning(self):
        """D-010: _verify_setting adds Sure Admin warning when verification fails."""

        def mock_read(name):
            if name == "Network (PXE) Boot":
                return "Enable"  # Still enabled — set to Disable failed silently
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            with patch.object(hp_uefi_lockdown, "_sure_admin_active", True):
                result = hp_uefi_lockdown._verify_setting("Network (PXE) Boot", "Disable")
        assert result is False  # Verification failed

    def test_d010_sure_admin_no_warning_when_not_active(self):
        """D-010: _verify_setting does NOT add Sure Admin warning when Sure Admin is off."""

        def mock_read(name):
            if name == "Network (PXE) Boot":
                return "Enable"  # Still enabled
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            with patch.object(hp_uefi_lockdown, "_sure_admin_active", False):
                result = hp_uefi_lockdown._verify_setting("Network (PXE) Boot", "Disable")
        assert result is False  # Verification failed (but no Sure Admin warning)

    def test_d010_ebam_setting_name_detected(self):
        """D-010: Sure Admin detected via EBAM setting name (not 'Sure Admin')."""

        def mock_read(name):
            if name == "Enhanced BIOS Authentication Mode (EBAM)":
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is True
        assert result["any_sure_feature"] is True

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_d010_apply_includes_sure_admin_status(
        self,
        mock_read,
        mock_set,
        mock_sure,
        mock_pw_set,
        _,
        __,
        tmp_state_file,
        mock_resolve_settings,
    ):
        """D-010: apply_boot_lockdown includes sure_admin_status in result."""
        mock_sure.return_value = {
            "sure_admin_detected": True,
            "sure_run_detected": False,
            "sure_start_detected": True,
            "any_sure_feature": True,
            "warning": "HP Sure Admin+Sure Start detected. BIOS changes may be reverted.",
        }
        mock_set.return_value = 0

        def smart_read(name):
            for sname, sval in (
                hp_uefi_lockdown.HP_CRITICAL_SETTINGS + hp_uefi_lockdown.HP_BEST_EFFORT_SETTINGS
            ):
                if name == sname:
                    return sval  # Already in lockdown state
            return None

        mock_read.side_effect = smart_read

        result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="testpw")

        assert result["sure_admin_status"] is not None
        assert result["sure_admin_status"]["sure_admin_detected"] is True
        assert result["sure_admin_status"]["sure_start_detected"] is True
        assert result["sure_admin_status"]["any_sure_feature"] is True


class TestFailedRollbackKeepsTheBootState:
    """A rollback that could not restore must not delete the record of what to restore.

    Measured on MOLE (S271): the lockdown's writes committed at the next boot, the rollback's
    writes were refused, and `clear_boot_state()` deleted the only copy of the original values —
    so the machine came back with USB/PXE/Legacy boot disabled and nothing left that knew the
    values they had before.
    """

    def test_a_failed_restore_keeps_the_state_file(self, tmp_path, monkeypatch):
        state_file = tmp_path / ".boot_state"
        state_file.write_text('{"USB Storage Boot": "Enable"}')
        monkeypatch.setattr(hp_uefi_lockdown, "BOOT_STATE_FILE", state_file)
        monkeypatch.setattr(hp_uefi_lockdown, "_set_setting", lambda *a, **k: 6)  # refused
        monkeypatch.setattr(hp_uefi_lockdown, "_verify_setting", lambda *a, **k: False)

        ok = hp_uefi_lockdown._rollback_bios_settings({"USB Storage Boot": "Enable"}, "pw")

        assert ok is False
        assert state_file.exists(), "the original values must stay recoverable"

    def test_a_successful_restore_clears_the_state_file(self, tmp_path, monkeypatch):
        state_file = tmp_path / ".boot_state"
        state_file.write_text('{"USB Storage Boot": "Enable"}')
        monkeypatch.setattr(hp_uefi_lockdown, "BOOT_STATE_FILE", state_file)
        monkeypatch.setattr(hp_uefi_lockdown, "_set_setting", lambda *a, **k: 0)
        monkeypatch.setattr(hp_uefi_lockdown, "_verify_setting", lambda *a, **k: True)

        ok = hp_uefi_lockdown._rollback_bios_settings({"USB Storage Boot": "Enable"}, "pw")

        assert ok is True
        assert not state_file.exists()


class TestRemovalVerdict:
    """`remove_boot_lockdown` must not claim a restore it did not verify.

    Measured on MOLE (S271): with the boot state deleted by a failed rollback, the removal
    logged "Restored 0 BIOS settings" and the caller then logged "BIOS restored to
    pre-lockdown state" — while the four boot settings still held the lockdown values and every
    restore write was refused (Return=4 Failed).
    """

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state", return_value=None)
    @patch("hp_uefi_lockdown._set_setting", return_value=4)  # Failed: every write refused
    def test_refused_writes_are_reported_as_failure(self, _set, _state, _hp, _admin):
        assert hp_uefi_lockdown.remove_boot_lockdown(bios_password="pw") is False

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown.load_boot_state", return_value=None)
    @patch("hp_uefi_lockdown._verify_setting", return_value=False)
    @patch("hp_uefi_lockdown._set_setting", return_value=0)  # accepted, never verified
    def test_accepted_but_unverified_is_not_a_restore(self, _set, _verify, _state, _hp, _admin):
        assert hp_uefi_lockdown.remove_boot_lockdown(bios_password="pw") is False


class TestOnlyAGeneratedPasswordIsReported:
    """CC18 returns a password THIS RUN set. A pre-existing one is the operator's, not ours.

    Measured on MOLE (S271): the caller's `uefi_password` value came back through the ACK and
    was served by `GET /api/devices/:id/pba-credentials` as the device's Setup password, while
    every BIOS write with it was refused — a credential the backend vouched for and the machine
    did not accept.
    """

    def test_a_preexisting_password_is_not_reported_back(self, tmp_path, monkeypatch):
        # Keep the boot-state file out of the working tree: this path writes one.
        monkeypatch.setattr(hp_uefi_lockdown, "BOOT_STATE_FILE", tmp_path / ".boot_state")
        with (
            patch.object(hp_uefi_lockdown, "_is_admin", return_value=True),
            patch.object(hp_uefi_lockdown, "is_hp_machine", return_value=True),
            patch.object(hp_uefi_lockdown, "_is_setup_password_set", return_value=True),
            patch.object(hp_uefi_lockdown, "_set_setting", return_value=6),  # writes refused
            patch.object(hp_uefi_lockdown, "_read_setting", return_value="Enable"),
            patch.object(
                hp_uefi_lockdown,
                "_check_secure_boot",
                return_value={"enabled": False, "warning": None},
            ),
            patch.object(
                hp_uefi_lockdown,
                "_check_sure_admin",
                return_value={
                    "sure_admin_detected": False,
                    "any_sure_feature": False,
                    "warning": None,
                },
            ),
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="1234")

        assert result.get("bios_password") is None
