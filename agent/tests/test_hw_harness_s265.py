"""S265 tests: the Defender false negative and the two firmware rollbacks.

Split out of test_hw_harness.py so this file is self-contained — the hunk-scoped
analyzer that reads a changed region could not see `import pytest` (line 14) or a
helper class defined further up the old file, and reported three "not defined"
errors against names that were defined a few hundred lines earlier.

Both groups cover the same session:

1. `_mp_exclusions()` — the harness asked only for Defender's *process* exclusion
   list while `installer.py`/`installer_gui.py` add `-ExclusionPath`, so two
   hardware windows recorded `defender_exclusion: null` for installs that had an
   exclusion. It now reads both lists.
2. The two firmware rollbacks — `E-BCD-01` and `E-HP-UEFI-01` overrode
   `rollback()` with `pass` while `bcd_lockdown`/`hp_uefi_lockdown` had working
   restore paths all along. They now delegate, and raise when nothing was
   restored (the run loop records `rollback_restored = True` unless it raises).
"""

import sys
from pathlib import Path

import pytest

_AGENT_DIR = Path(__file__).parent.parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))

import hw_test_harness  # noqa: E402


class _SimpleResult:
    """Minimal stand-in for subprocess.CompletedProcess (stdout only)."""

    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.stderr = ""
        self.returncode = 0


class TestMpExclusions:
    """The check that returned `null` twice for installs that had an exclusion.

    `installer.py`/`installer_gui.py` add `-ExclusionPath`; `deploy.ps1` adds path + process.
    The harness asked only for `ExclusionProcess`, so a path-only install read as unecluded —
    which is what two hardware windows recorded (S260/S261). These tests pin both lists.
    """

    def _run_stub(self, path_out: str, process_out: str, calls: list):
        def _fake_run(cmd, **kwargs):
            calls.append(cmd[-1])
            result = _SimpleResult(path_out if "ExclusionPath" in cmd[-1] else process_out)
            return result

        return _fake_run

    def test_reads_path_and_process_lists(self, monkeypatch):
        calls: list[str] = []
        monkeypatch.setattr(
            hw_test_harness.subprocess,
            "run",
            self._run_stub(r"C:\ProgramData\LockdownAgent", "lockdown-agent.exe", calls),
        )

        found = hw_test_harness._mp_exclusions()

        assert found == {
            "path": r"C:\ProgramData\LockdownAgent",
            "process": "lockdown-agent.exe",
        }
        assert any("ExclusionPath" in c for c in calls)
        assert any("ExclusionProcess" in c for c in calls)

    def test_a_path_only_install_is_no_longer_reported_as_missing(self, monkeypatch):
        """The exact false negative: path exclusion present, process list empty."""
        monkeypatch.setattr(
            hw_test_harness.subprocess,
            "run",
            self._run_stub(r"C:\ProgramData\LockdownAgent", "", []),
        )

        found = hw_test_harness._mp_exclusions()

        assert found["path"] is not None
        assert found["process"] is None
        assert (found["path"] or found["process"]) is not None

    def test_both_lists_empty_means_no_exclusion(self, monkeypatch):
        monkeypatch.setattr(hw_test_harness.subprocess, "run", self._run_stub("", "", []))

        assert hw_test_harness._mp_exclusions() == {"path": None, "process": None}

    def test_powershell_failure_is_not_an_exclusion(self, monkeypatch):
        def _raise(cmd, **kwargs):
            raise FileNotFoundError("powershell")

        monkeypatch.setattr(hw_test_harness.subprocess, "run", _raise)

        assert hw_test_harness._mp_exclusions() == {"path": None, "process": None}

    def test_detect_environment_exposes_both_fields(self):
        env = hw_test_harness.detect_environment()
        assert "defender_exclusion_path" in env
        assert "defender_exclusion_process" in env
        assert "defender_exclusion" in env

    def test_defender_service_gating_accepts_either_kind(self):
        """A path-only install must satisfy `--services defender`."""
        path_only = {
            "platform": "Windows",
            "defender_exclusion": r"C:\ProgramData\LockdownAgent",
            "defender_exclusion_path": r"C:\ProgramData\LockdownAgent",
            "defender_exclusion_process": None,
        }
        process_only = {
            "platform": "Windows",
            "defender_exclusion": "lockdown-agent.exe",
            "defender_exclusion_path": None,
            "defender_exclusion_process": "lockdown-agent.exe",
        }
        neither = {
            "platform": "Windows",
            "defender_exclusion": None,
            "defender_exclusion_path": None,
            "defender_exclusion_process": None,
        }
        assert hw_test_harness.check_services(["defender"], path_only)["defender"] is True
        assert hw_test_harness.check_services(["defender"], process_only)["defender"] is True
        assert hw_test_harness.check_services(["defender"], neither)["defender"] is False


# ---------------------------------------------------------------------------
# S265: the two firmware rollbacks are wired, not stubs
# ---------------------------------------------------------------------------


class TestFirmwareRollbacks:
    """Both tests restored nothing while their names said "with rollback"."""

    def test_bcd_rollback_delegates_to_the_module(self, monkeypatch):
        import bcd_lockdown

        called = {}

        def _restore():
            called["yes"] = True
            return True

        monkeypatch.setattr(bcd_lockdown, "restore_bcd_state", _restore)

        hw_test_harness.TestBcdLockdown().rollback({"bcdedit_output": "x"})

        assert called == {"yes": True}

    def test_bcd_rollback_raises_when_nothing_was_restored(self, monkeypatch):
        """Otherwise run() marks rollback_restored=True for a failed restore."""
        import bcd_lockdown

        monkeypatch.setattr(bcd_lockdown, "restore_bcd_state", lambda: False)

        with pytest.raises(RuntimeError, match="BCD rollback did not complete"):
            hw_test_harness.TestBcdLockdown().rollback({})

    def test_hp_rollback_uses_the_password_from_the_action(self, monkeypatch):
        import hp_uefi_lockdown

        seen = {}

        def _restore(password):
            seen["password"] = password
            return True

        monkeypatch.setattr(hp_uefi_lockdown, "restore_boot_state", _restore)

        test = hw_test_harness.TestHpUefiLockdown()
        test._lockdown_result = {"bios_password": "generated-pw"}
        test.rollback({})

        assert seen["password"] == "generated-pw"

    def test_hp_rollback_falls_back_to_the_encrypted_backup(self, monkeypatch):
        import hp_uefi_lockdown

        seen = {}
        monkeypatch.setattr(
            hp_uefi_lockdown,
            "read_password_backup",
            lambda: {"bios_password": "backup-pw", "power_on_password": None},
        )
        monkeypatch.setattr(
            hp_uefi_lockdown,
            "restore_boot_state",
            lambda password: seen.setdefault("password", password) is not None,
        )

        hw_test_harness.TestHpUefiLockdown().rollback({})

        assert seen["password"] == "backup-pw"

    def test_hp_rollback_without_any_password_raises(self, monkeypatch):
        import hp_uefi_lockdown

        monkeypatch.setattr(hp_uefi_lockdown, "read_password_backup", lambda: None)

        with pytest.raises(RuntimeError, match="needs the Setup Password"):
            hw_test_harness.TestHpUefiLockdown().rollback({})

    def test_hp_action_records_the_result_for_rollback(self, monkeypatch):
        import hp_uefi_lockdown

        monkeypatch.setattr(
            hp_uefi_lockdown,
            "apply_boot_lockdown",
            lambda: {"success": True, "bios_password": "pw", "critical_applied": 1},
        )

        test = hw_test_harness.TestHpUefiLockdown()
        test.action({}, "simulate")

        assert test._lockdown_result["bios_password"] == "pw"
