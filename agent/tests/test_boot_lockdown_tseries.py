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
    @patch("hp_uefi_lockdown._check_sure_start_bsp")
    @patch("hp_uefi_lockdown._is_setup_password_set", return_value=True)
    @patch("hp_uefi_lockdown._resolve_setting_names")
    @patch("hp_uefi_lockdown._set_and_verify")
    def test_t5_bitlocker_resumed_after_rollback(
        self,
        mock_set,
        mock_resolve,
        mock_pw,
        mock_bsp,
        mock_sb,
        mock_sa,
        mock_hp,
        mock_admin,
        mock_cmd,
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
        mock_bsp.return_value = {"enabled": False, "setting_name": None, "warning": None}
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
