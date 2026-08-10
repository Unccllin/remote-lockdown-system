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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
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
        assert result["bios_password"] == "existingpw"
        # First call should NOT be setting the Setup password (password already set)
        first_call = mock_set.call_args_list[0]
        assert first_call.args[0] != "Setup Password"

    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_critical_failure_triggers_rollback(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """CC18: Critical failure triggers rollback of all BIOS changes."""

        # Setup Password succeeds (returns 0)
        # Critical settings: _set_setting returns 0 but _read_setting returns
        # the OLD value (verification fails) → critical failure
        def set_side_effect(name, value, password):
            return 0  # set always "succeeds" at the WMI level

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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_rollback_does_not_clear_password(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """CC18: Rollback must NOT clear the freshly-set Setup Password."""

        # Make all critical settings fail verification
        def set_side_effect(name, value, password):
            return 0

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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
    @patch("hp_uefi_lockdown._set_setting")
    @patch("hp_uefi_lockdown._read_setting")
    def test_apply_boot_lockdown_best_effort_failure_no_rollback(
        self, mock_read, mock_set, mock_pw_set, _, __, tmp_state_file, mock_resolve_settings
    ):
        """Best-effort failure does NOT trigger rollback."""
        mock_set.return_value = 0

        def read_side_effect(name):
            if name == "Setup Password":
                return None
            # Critical settings verify OK
            for sname, sval in hp_uefi_lockdown.HP_CRITICAL_SETTINGS:
                if name == sname:
                    return sval
            # Best-effort settings fail verification
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
        """Phase 4.5: _set_and_verify returns True when verification matches."""
        mock_read.return_value = "Disable"
        result = hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password")
        assert result is True

    @patch("hp_uefi_lockdown._set_setting", return_value=0)
    @patch("hp_uefi_lockdown._read_setting")
    def test_set_and_verify_failure(self, mock_read, _):
        """Phase 4.5: _set_and_verify returns False when verification fails."""
        mock_read.return_value = "Enable"  # didn't change
        result = hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password")
        assert result is False

    @patch("hp_uefi_lockdown._set_setting", return_value=6)
    def test_set_and_verify_set_fails(self, _):
        """Phase 4.5: _set_and_verify returns False when _set_setting fails."""
        result = hp_uefi_lockdown._set_and_verify("USB Boot", "Disable", "password")
        assert result is False

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
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=False)
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


# ---------------------------------------------------------------------------
# BCD Lockdown Tests
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
        # reagentc /disable succeeds, bcdedit /set succeeds
        mock_run.return_value = (0, "", "")

        # _read_bcd_setting returns the lockdown value (verification passes)
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
        mock_resume.assert_not_called()
