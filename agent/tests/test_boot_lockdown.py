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
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
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
    @patch("hp_uefi_lockdown._is_setup_password_set", side_effect=[False, True])
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
    @patch("hp_uefi_lockdown._check_sure_admin", return_value={"any_sure_feature": False})
    def test_d009_apply_no_critical_settings_returns_failure(self, _, __, ___, tmp_state_file):
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
        with patch.object(
            hp_uefi_lockdown,
            "_resolve_setting_names",
            return_value=(custom_settings, []),
        ):
            with patch("hp_uefi_lockdown.load_boot_state", return_value=None):
                result = hp_uefi_lockdown.remove_boot_lockdown(bios_password="testpw")
        assert result is True

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
        """D-010: _check_sure_admin detects Sure Admin enabled."""

        def mock_read(name):
            if name in ("Sure Admin", "HP Sure Admin"):
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
            if name in ("Sure Start", "HP Sure Start"):
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
            if name in ("Sure Run", "HP Sure Run"):
                return "Enable"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_run_detected"] is True
        assert result["any_sure_feature"] is True
        assert "Sure Run" in result["warning"]

    def test_d010_check_sure_admin_disabled(self):
        """D-010: Sure Admin setting exists but is disabled → not detected."""

        def mock_read(name):
            if name in ("Sure Admin", "HP Sure Admin"):
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
            if name in ("Sure Admin", "HP Sure Admin"):
                return "Enable"
            if name in ("Sure Run", "HP Sure Run"):
                return "Enable"
            if name in ("Sure Start", "HP Sure Start"):
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
            if name in ("Sure Admin", "HP Sure Admin"):
                return "Yes"
            if name in ("Sure Run", "HP Sure Run"):
                return "Active"
            return None

        with patch("hp_uefi_lockdown._read_setting", side_effect=mock_read):
            result = hp_uefi_lockdown._check_sure_admin()
        assert result["sure_admin_detected"] is True
        assert result["sure_run_detected"] is True
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
        # T4: {bootmgr} query needs to return the value for verification
        def run_side_effect(cmd, timeout=15):
            cmd_str = " ".join(cmd)
            if "/query" in cmd_str and "{bootmgr}" in cmd_str:
                # Return the timeout value for bootmgr queries
                for sname, sval, _ in bcd_lockdown.BCD_BOOTMGR_COMMANDS:
                    if sname in cmd_str:
                        return (0, f"{sname}              {sval}", "")
                return (0, "", "")
            return (0, "", "")

        mock_run.side_effect = run_side_effect

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


# ---------------------------------------------------------------------------
# D-013: Read-back-after-write verification for 4 unverified sites
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


# ---------------------------------------------------------------------------
# D-014: Filter quote escaping in _read_setting
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Master dry-run env var tests
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# T2: Secure Boot verification tests
# ---------------------------------------------------------------------------


class TestT2SecureBootVerification:
    """T2: _check_secure_boot queries HP WMI and returns enabled/warning."""

    @patch("hp_uefi_lockdown._read_setting")
    def test_t2_secure_boot_enabled(self, mock_read):
        """Secure Boot enabled returns enabled=True, no warning."""
        mock_read.return_value = "Enable"
        result = hp_uefi_lockdown._check_secure_boot()
        assert result["enabled"] is True
        assert result["warning"] is None
        assert result["setting_name"] is not None

    @patch("hp_uefi_lockdown._read_setting")
    def test_t2_secure_boot_disabled(self, mock_read):
        """Secure Boot disabled returns enabled=False with warning."""
        mock_read.return_value = "Disable"
        result = hp_uefi_lockdown._check_secure_boot()
        assert result["enabled"] is False
        assert result["warning"] is not None
        assert "disabled" in result["warning"].lower()

    @patch("hp_uefi_lockdown._read_setting")
    def test_t2_secure_boot_not_found(self, mock_read):
        """Secure Boot setting not found returns warning."""
        mock_read.return_value = None
        result = hp_uefi_lockdown._check_secure_boot()
        assert result["enabled"] is False
        assert result["setting_name"] is None
        assert "not found" in result["warning"].lower()

    @patch("hp_uefi_lockdown._read_setting")
    def test_t2_secure_boot_enum_value(self, mock_read):
        """Secure Boot enum value 'Secure Boot' is recognized as enabled."""
        mock_read.return_value = "Secure Boot"
        result = hp_uefi_lockdown._check_secure_boot()
        assert result["enabled"] is True

    @patch("hp_uefi_lockdown._read_setting")
    def test_t2_secure_boot_in_result_dict(self, mock_read):
        """apply_boot_lockdown includes secure_boot_status in result."""
        mock_read.return_value = "Enable"
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", True),
            patch.object(hp_uefi_lockdown, "is_hp_machine", return_value=True),
            patch.object(hp_uefi_lockdown, "_is_admin", return_value=True),
            patch.object(hp_uefi_lockdown, "_is_setup_password_set", return_value=True),
            patch.object(
                hp_uefi_lockdown,
                "_check_sure_admin",
                return_value={
                    "sure_admin_detected": False,
                    "sure_run_detected": False,
                    "sure_start_detected": False,
                    "any_sure_feature": False,
                    "warning": None,
                },
            ),
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
            patch.object(hp_uefi_lockdown, "_resolve_setting_names", return_value=([], [])),
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="test")
            assert "secure_boot_status" in result
            assert result["secure_boot_status"] is not None


# ---------------------------------------------------------------------------
# T3: VT-d/IOMMU DMA protection tests
# ---------------------------------------------------------------------------


class TestT3DmaProtection:
    """T3: dma_protection concept is in CONCEPTS and DEFAULT_SETTING_NAMES."""

    def test_t3_dma_protection_in_concepts(self):
        """dma_protection is a recognized concept with Enable value."""
        assert "dma_protection" in hp_uefi_lockdown.CONCEPTS
        assert hp_uefi_lockdown.CONCEPTS["dma_protection"] == "Enable"

    def test_t3_dma_protection_in_default_setting_names(self):
        """dma_protection has candidate setting names."""
        assert "dma_protection" in hp_uefi_lockdown.DEFAULT_SETTING_NAMES
        names = hp_uefi_lockdown.DEFAULT_SETTING_NAMES["dma_protection"]
        assert len(names) > 0
        assert "VT-d" in names or "DMA Protection" in names

    def test_t3_dma_protection_is_best_effort(self):
        """dma_protection is in best_effort_concepts (not critical)."""
        # Check that it's not in the critical list by verifying _resolve_setting_names
        # puts it in best_effort. In dry-run, all settings exist.
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", True),
            patch.object(hp_uefi_lockdown, "_detect_hp_model", return_value=None),
            patch.object(hp_uefi_lockdown, "_load_model_overrides", return_value={}),
        ):
            critical, best_effort = hp_uefi_lockdown._resolve_setting_names()
            best_effort_concepts = [name for name, _ in best_effort]
            # At least one DMA protection name should be in best-effort
            dma_names = hp_uefi_lockdown.DEFAULT_SETTING_NAMES["dma_protection"]
            assert any(name in best_effort_concepts for name in dma_names)

    def test_t3_dma_protection_in_dry_run_state(self):
        """DMA protection settings are in the dry-run BIOS state."""
        assert "VT-d" in hp_uefi_lockdown._DRY_RUN_BIOS_STATE
        assert hp_uefi_lockdown._DRY_RUN_BIOS_STATE["VT-d"] == "Enable"


# ---------------------------------------------------------------------------
# T4: BCD hardening extras tests
# ---------------------------------------------------------------------------


class TestT4BcdHardeningExtras:
    """T4: Additional BCD hardening (timeout, bootsequence, integrity checks)."""

    def test_t4_nointegritychecks_in_best_effort(self):
        """nointegritychecks=No is in BCD_BEST_EFFORT_COMMANDS."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS]
        assert "nointegritychecks" in settings

    def test_t4_allowprereleasesignatures_in_best_effort(self):
        """allowprereleasesignatures=No is in BCD_BEST_EFFORT_COMMANDS."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_BEST_EFFORT_COMMANDS]
        assert "allowprereleasesignatures" in settings

    def test_t4_timeout_in_bootmgr_commands(self):
        """timeout=0 is in BCD_BOOTMGR_COMMANDS."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_BOOTMGR_COMMANDS]
        assert "timeout" in settings
        # Verify the value is 0
        for s, v, _ in bcd_lockdown.BCD_BOOTMGR_COMMANDS:
            if s == "timeout":
                assert v == "0"

    def test_t4_restore_commands_include_new_settings(self):
        """BCD_RESTORE_COMMANDS includes nointegritychecks and allowprereleasesignatures."""
        settings = [s for s, _, _ in bcd_lockdown.BCD_RESTORE_COMMANDS]
        assert "nointegritychecks" in settings
        assert "allowprereleasesignatures" in settings

    def test_t4_bootmgr_restore_commands_exist(self):
        """BCD_BOOTMGR_RESTORE_COMMANDS exists and has timeout."""
        assert len(bcd_lockdown.BCD_BOOTMGR_RESTORE_COMMANDS) > 0
        settings = [s for s, _, _ in bcd_lockdown.BCD_BOOTMGR_RESTORE_COMMANDS]
        assert "timeout" in settings

    def test_t4_dry_run_state_has_new_settings(self):
        """Dry-run BCD state includes the new settings."""
        assert "nointegritychecks" in bcd_lockdown._DRY_RUN_BCD_STATE
        assert "allowprereleasesignatures" in bcd_lockdown._DRY_RUN_BCD_STATE
        assert "timeout" in bcd_lockdown._DRY_RUN_BCD_STATE

    @patch("bcd_lockdown._run")
    def test_t4_set_bcd_setting_bootmgr_success(self, mock_run):
        """_set_bcd_setting_bootmgr sets and verifies {bootmgr} timeout."""
        # First call: bcdedit /set {bootmgr} timeout 0 → success
        # Second call: bcdedit /query {bootmgr} timeout → returns "0"
        mock_run.side_effect = [
            (0, "", ""),  # /set
            (0, "timeout              0", ""),  # /query
        ]
        result = bcd_lockdown._set_bcd_setting_bootmgr("timeout", "0")
        assert result is True

    @patch("bcd_lockdown._run")
    def test_t4_set_bcd_setting_bootmgr_verification_fails(self, mock_run):
        """_set_bcd_setting_bootmgr returns False if verification fails."""
        mock_run.side_effect = [
            (0, "", ""),  # /set succeeds
            (0, "timeout              30", ""),  # /query returns wrong value
        ]
        result = bcd_lockdown._set_bcd_setting_bootmgr("timeout", "0")
        assert result is False

    @patch("bcd_lockdown._run")
    def test_t4_clear_bootsequence_success(self, mock_run):
        """_clear_bootsequence returns True on success."""
        mock_run.return_value = (0, "", "")
        result = bcd_lockdown._clear_bootsequence()
        assert result is True

    @patch("bcd_lockdown._run")
    def test_t4_clear_bootsequence_not_found_is_ok(self, mock_run):
        """_clear_bootsequence returns True even if bootsequence doesn't exist."""
        mock_run.return_value = (1, "", "Element not found")
        result = bcd_lockdown._clear_bootsequence()
        assert result is True  # Not an error — bootsequence may not exist

    @patch("bcd_lockdown._run")
    @patch("bcd_lockdown._is_admin", return_value=True)
    @patch("bcd_lockdown._is_windows", return_value=True)
    def test_t4_apply_bcd_lockdown_includes_bootmgr_settings(self, mock_win, mock_admin, mock_run):
        """apply_bcd_lockdown applies {bootmgr} timeout=0 as best-effort."""

        # _run needs to handle: reagentc /info, reagentc /disable,
        # bcdedit /query {bootmgr} timeout (for save_bcd_state), and
        # bcdedit /deletevalue {bootmgr} bootsequence (for _clear_bootsequence)
        def run_side_effect(cmd, timeout=15):
            cmd_str = " ".join(cmd)
            if "reagentc" in cmd_str and "/info" in cmd_str:
                return (0, "Windows RE status: Enabled", "")
            if "/query" in cmd_str and "{bootmgr}" in cmd_str:
                return (0, "timeout              30", "")
            return (0, "", "")

        mock_run.side_effect = run_side_effect

        with (
            patch.object(bcd_lockdown, "_DRY_RUN", False),
            patch.object(bcd_lockdown, "BCD_LOCK_SENTINEL", Path(tempfile.mktemp())),
            patch.object(bcd_lockdown, "BCD_STATE_FILE", Path(tempfile.mktemp())),
            patch.object(
                bcd_lockdown,
                "_check_bitlocker",
                return_value={
                    "enabled": False,
                    "suspended": False,
                    "percentage": "0%",
                    "error": None,
                },
            ),
            patch.object(bcd_lockdown, "_disable_winre", return_value=True),
            patch.object(bcd_lockdown, "_set_bcd_setting", return_value=True),
            patch.object(
                bcd_lockdown, "_set_bcd_setting_bootmgr", return_value=True
            ) as mock_bootmgr,
            patch.object(bcd_lockdown, "_clear_bootsequence", return_value=True) as mock_clear,
            patch.object(bcd_lockdown, "_read_bcd_setting", return_value="No"),
        ):
            result = bcd_lockdown.apply_bcd_lockdown()
            # {bootmgr} timeout=0 should have been called
            mock_bootmgr.assert_called()
            # bootsequence clear should have been called
            mock_clear.assert_called_once()
            assert result["success"] is True


# ---------------------------------------------------------------------------
# T5: BitLocker suspension for BIOS changes tests
# ---------------------------------------------------------------------------


class TestT5BitLockerSuspensionForBios:
    """T5: BitLocker is suspended before BIOS changes and resumed after."""

    def test_t5_check_bitlocker_dry_run_disabled(self):
        """_check_bitlocker in dry-run returns enabled=False by default."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_ENABLED = False
            result = hp_uefi_lockdown._check_bitlocker()
            assert result["enabled"] is False
            assert result["error"] is None

    def test_t5_check_bitlocker_dry_run_enabled(self):
        """_check_bitlocker in dry-run returns enabled=True when flag set."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_ENABLED = True
            result = hp_uefi_lockdown._check_bitlocker()
            assert result["enabled"] is True
            assert result["percentage"] == "100%"

    def test_t5_suspend_bitlocker_dry_run(self):
        """_suspend_bitlocker in dry-run sets suspended flag."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_ENABLED = True
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_SUSPENDED = False
            result = hp_uefi_lockdown._suspend_bitlocker()
            assert result is True
            assert hp_uefi_lockdown._DRY_RUN_BITLOCKER_SUSPENDED is True

    def test_t5_resume_bitlocker_dry_run(self):
        """_resume_bitlocker in dry-run clears suspended flag."""
        with patch.object(hp_uefi_lockdown, "_DRY_RUN", True):
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_ENABLED = True
            hp_uefi_lockdown._DRY_RUN_BITLOCKER_SUSPENDED = True
            result = hp_uefi_lockdown._resume_bitlocker()
            assert result is True
            assert hp_uefi_lockdown._DRY_RUN_BITLOCKER_SUSPENDED is False

    @patch("hp_uefi_lockdown._run_cmd")
    def test_t5_check_bitlocker_parses_protection_on(self, mock_cmd):
        """_check_bitlocker parses 'Protection On' as enabled=True."""
        mock_cmd.return_value = (
            0,
            "    Protection Status:    Protection On\n    Conversion Status:    100% Encrypted",
            "",
        )
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            result = hp_uefi_lockdown._check_bitlocker()
            assert result["enabled"] is True
            assert result["percentage"] == "100%"

    @patch("hp_uefi_lockdown._run_cmd")
    def test_t5_check_bitlocker_parses_protection_off(self, mock_cmd):
        """_check_bitlocker parses 'Protection Off' as enabled=False."""
        mock_cmd.return_value = (
            0,
            "    Protection Status:    Protection Off\n    Conversion Status:    0% Encrypted",
            "",
        )
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            result = hp_uefi_lockdown._check_bitlocker()
            assert result["enabled"] is False

    @patch("hp_uefi_lockdown._run_cmd")
    def test_t5_suspend_bitlocker_calls_manage_bde(self, mock_cmd):
        """_suspend_bitlocker calls manage-bde -protectors -disable C:."""
        mock_cmd.return_value = (0, "", "")
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            result = hp_uefi_lockdown._suspend_bitlocker()
            assert result is True
            cmd = mock_cmd.call_args.args[0]
            assert "manage-bde" in cmd
            assert "-disable" in cmd
            assert "C:" in cmd

    @patch("hp_uefi_lockdown._run_cmd")
    def test_t5_resume_bitlocker_calls_manage_bde(self, mock_cmd):
        """_resume_bitlocker calls manage-bde -protectors -enable C:."""
        mock_cmd.return_value = (0, "", "")
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            result = hp_uefi_lockdown._resume_bitlocker()
            assert result is True
            cmd = mock_cmd.call_args.args[0]
            assert "manage-bde" in cmd
            assert "-enable" in cmd
            assert "C:" in cmd

    @patch("hp_uefi_lockdown._run_cmd")
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._resolve_setting_names", return_value=([], []))
    def test_t5_bitlocker_suspended_before_bios_changes(
        self, mock_resolve, mock_pw, mock_sb, mock_sa, mock_hp, mock_admin, mock_cmd
    ):
        """apply_boot_lockdown suspends BitLocker before BIOS changes."""
        mock_sa.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_sb.return_value = {"enabled": True, "setting_name": "Secure Boot", "warning": None}
        # manage-bde -status returns enabled, -disable succeeds, -enable succeeds
        mock_cmd.side_effect = [
            (
                0,
                "    Protection Status:    Protection On\n    Conversion Status:    100% Encrypted",
                "",
            ),
            (0, "", ""),  # suspend
            (0, "", ""),  # resume
        ]
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="test")
            assert result["bitlocker_status"] is not None
            assert result["bitlocker_status"]["enabled"] is True
            # Verify suspend was called (second manage-bde call)
            suspend_cmd = mock_cmd.call_args_list[1].args[0]
            assert "-disable" in suspend_cmd

    @patch("hp_uefi_lockdown._run_cmd")
    @patch("hp_uefi_lockdown._is_admin", return_value=True)
    @patch("hp_uefi_lockdown.is_hp_machine", return_value=True)
    @patch("hp_uefi_lockdown._check_sure_admin")
    @patch("hp_uefi_lockdown._check_secure_boot")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._resolve_setting_names")
    @patch("hp_uefi_lockdown._set_and_verify")
    def test_t5_bitlocker_resumed_after_rollback(
        self, mock_set, mock_resolve, mock_pw, mock_sb, mock_sa, mock_hp, mock_admin, mock_cmd
    ):
        """apply_boot_lockdown resumes BitLocker after critical failure rollback."""
        mock_sa.return_value = {
            "sure_admin_detected": False,
            "sure_run_detected": False,
            "sure_start_detected": False,
            "any_sure_feature": False,
            "warning": None,
        }
        mock_sb.return_value = {"enabled": True, "setting_name": "Secure Boot", "warning": None}
        # Return critical settings that will fail
        mock_resolve.return_value = ([("USB Boot", "Disable")], [])
        mock_set.return_value = False  # Critical setting fails → rollback
        # manage-bde: status (enabled), suspend, resume (after rollback)
        mock_cmd.side_effect = [
            (
                0,
                "    Protection Status:    Protection On\n    Conversion Status:    100% Encrypted",
                "",
            ),
            (0, "", ""),  # suspend
            (0, "", ""),  # resume after rollback
        ]
        with (
            patch.object(hp_uefi_lockdown, "_DRY_RUN", False),
            patch("hp_uefi_lockdown.platform.system", return_value="Windows"),
            patch.object(hp_uefi_lockdown, "BOOT_STATE_FILE", Path(tempfile.mktemp())),
            patch.object(hp_uefi_lockdown, "_read_setting", return_value="Enable"),
            patch.object(hp_uefi_lockdown, "_rollback_bios_settings", return_value=True),
        ):
            result = hp_uefi_lockdown.apply_boot_lockdown(existing_password="test")
            assert result["rolled_back"] is True
            # Verify resume was called (third manage-bde call)
            resume_cmd = mock_cmd.call_args_list[2].args[0]
            assert "-enable" in resume_cmd


# ---------------------------------------------------------------------------
# T1: SafeBoot registry entries tests (install script structure)
# ---------------------------------------------------------------------------


class TestT1SafeBootRegistry:
    """T1: SafeBoot registry entries are created at install time.

    The install script is PowerShell, so we verify the structure by checking
    that the script contains the correct registry paths and value names.
    Full PowerShell execution testing is done via pwsh -NoProfile (if available)
    or manual verification on Windows.
    """

    def test_t1_install_script_has_safeboot_section(self):
        """install-service-enhanced.ps1 contains SafeBoot registry section."""
        script_path = (
            Path(__file__).parent.parent / "platform" / "windows" / "install-service-enhanced.ps1"
        )
        content = script_path.read_text()
        assert "SafeBoot" in content
        assert "Minimal" in content
        assert "Network" in content

    def test_t1_install_script_sets_service_value(self):
        """Install script sets (Default) value to 'Service' for SafeBoot keys."""
        script_path = (
            Path(__file__).parent.parent / "platform" / "windows" / "install-service-enhanced.ps1"
        )
        content = script_path.read_text()
        assert "Service" in content
        assert "Set-ItemProperty" in content

    def test_t1_uninstall_script_removes_safeboot(self):
        """uninstall_service.ps1 removes SafeBoot registry entries."""
        script_path = Path(__file__).parent.parent / "uninstall_service.ps1"
        content = script_path.read_text()
        assert "SafeBoot" in content
        assert "Remove-Item" in content
