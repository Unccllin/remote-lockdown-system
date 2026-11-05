"""Tests for the Windows service installer module.

Tests cover:
- Non-Windows platform handling (graceful no-op)
- Admin check logic
- Agent path resolution (frozen vs script)
- Command building
- Install/uninstall/status flow (mocked subprocess)

All subprocess calls are mocked — no real schtasks/reg/tasklist calls.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

# Add agent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
import service_installer


class TestPlatformCheck:
    def test_is_windows_returns_bool(self):
        result = service_installer._is_windows()
        assert isinstance(result, bool)

    def test_install_fails_on_non_windows(self):
        with patch.object(service_installer, "_is_windows", return_value=False):
            assert service_installer.install() is False

    def test_uninstall_fails_on_non_windows(self):
        with patch.object(service_installer, "_is_windows", return_value=False):
            assert service_installer.uninstall() is False


class TestAdminCheck:
    def test_is_admin_returns_false_on_non_windows(self):
        with patch.object(service_installer, "_is_windows", return_value=False):
            assert service_installer._is_admin() is False

    def test_install_fails_without_admin(self):
        with (
            patch.object(service_installer, "_is_windows", return_value=True),
            patch.object(service_installer, "_is_admin", return_value=False),
        ):
            assert service_installer.install() is False

    def test_uninstall_fails_without_admin(self):
        with (
            patch.object(service_installer, "_is_windows", return_value=True),
            patch.object(service_installer, "_is_admin", return_value=False),
        ):
            assert service_installer.uninstall() is False


class TestAgentPath:
    def test_get_agent_path_frozen(self):
        """When frozen (PyInstaller), agent path is the exe path."""
        with patch.object(sys, "frozen", True, create=True):
            with patch.object(sys, "executable", "/fake/path/lockdown-agent.exe"):
                path = service_installer._get_agent_path()
                assert "lockdown-agent.exe" in str(path)

    def test_get_agent_path_script(self):
        """When not frozen, agent path is agent.py in the same directory."""
        path = service_installer._get_agent_path()
        assert path.name == "agent.py"


class TestCommandBuilding:
    def test_build_agent_command_includes_silent(self):
        cmd = service_installer._build_agent_command()
        assert "--silent" in cmd

    def test_build_agent_command_includes_config_if_exists(self):
        with patch.object(
            service_installer,
            "_get_config_path",
            return_value=Path("/fake/config.json"),
        ):
            cmd = service_installer._build_agent_command()
            assert "--config" in cmd
            assert "config.json" in cmd

    def test_build_watchdog_command_includes_powershell(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PROGRAMDATA", str(tmp_path))
        cmd = service_installer._build_watchdog_command()
        assert "powershell" in cmd.lower()
        # The script is a FILE now, not an inline -EncodedCommand: schtasks caps the
        # /TR action at 261 characters and the base64 form exceeded it as soon as the
        # agent path was long (S216: "Value for '/TR' option cannot be more than
        # 261 character(s)" on a machine with Python in Program Files).
        assert "-File" in cmd
        assert "watchdog-task.ps1" in cmd

    def test_watchdog_command_fits_the_schtasks_tr_limit(self, monkeypatch, tmp_path):
        """A /TR action over 261 chars makes schtasks refuse to create the task."""
        monkeypatch.setenv("PROGRAMDATA", str(tmp_path))
        cmd = service_installer._build_watchdog_command()
        assert len(cmd) <= 261, f"/TR would be rejected: {len(cmd)} chars"

    def test_watchdog_script_is_written_next_to_the_config(self, monkeypatch, tmp_path):
        monkeypatch.setenv("PROGRAMDATA", str(tmp_path))
        service_installer._build_watchdog_command()
        script = tmp_path / "LockdownAgent" / "watchdog-task.ps1"
        assert script.exists()
        # utf-8-sig: Windows PowerShell 5.1 misreads BOM-less UTF-8 in some locales.
        assert script.read_bytes().startswith(b"\xef\xbb\xbf")


class TestTaskStartVerification:
    """schtasks returns 0 even when nothing runs — verify the process (S218)."""

    def test_falls_back_to_direct_launch_when_the_task_starts_nothing(self, monkeypatch):
        monkeypatch.setattr(service_installer, "_is_windows", lambda: True)
        monkeypatch.setattr(service_installer, "_is_admin", lambda: True)
        monkeypatch.setattr(service_installer, "_agent_running", lambda: False)
        monkeypatch.setattr(service_installer, "_install_dir", lambda: Path("/tmp/lk"))
        monkeypatch.setattr(service_installer, "_build_watchdog_command", lambda: "powershell")
        monkeypatch.setattr(service_installer, "_build_agent_command", lambda: '"C:\\a\\agent.exe"')
        monkeypatch.setattr(service_installer.time, "sleep", lambda _s: None)
        monkeypatch.setattr(service_installer, "_HAS_TAMPER_PROTECTION", False)

        runs = []

        def fake_run(args, **kwargs):
            runs.append(args)
            return MagicMock(returncode=0, stderr="", stdout="")

        monkeypatch.setattr(service_installer.subprocess, "run", fake_run)
        popen = []
        monkeypatch.setattr(service_installer.subprocess, "Popen", lambda *a, **k: popen.append(a))

        service_installer.install()

        # The task was run...
        assert ["schtasks", "/Run", "/TN", "SystemHealthMonitor"] in runs
        # ...no agent appeared, so the fallback launched it via wscript.
        # popen entries are the args tuple Popen received: (['wscript.exe', ...],)
        assert popen and popen[0][0][0] == "wscript.exe"


class TestServiceInstall:
    """The service replaces the task + Run key (S219/S220)."""

    def test_bin_path_passes_the_service_flag(self, monkeypatch, tmp_path):
        monkeypatch.setattr(service_installer, "_install_dir", lambda: tmp_path)
        path = service_installer._service_bin_path()

        # Without --service the SCM starts the process and it stops immediately.
        assert path.endswith("--service")

    def test_bin_path_prefers_a_frozen_service_exe(self, monkeypatch, tmp_path):
        (tmp_path / "lockdown-service.exe").write_text("x")
        monkeypatch.setattr(service_installer, "_install_dir", lambda: tmp_path)

        assert service_installer._service_bin_path() == f'"{tmp_path / "lockdown-service.exe"}"'


class TestManagedDevice:
    """A managed endpoint must stay reachable and stay quiet (S221)."""

    def test_power_policy_clears_the_ac_idle_timeouts(self):
        calls = []
        completed = MagicMock(returncode=0, stdout="", stderr="")
        with patch.object(
            service_installer.subprocess,
            "run",
            side_effect=lambda a, **k: calls.append(a) or completed,
        ):
            assert service_installer.apply_managed_power_policy() is True

        joined = [" ".join(c) for c in calls]
        assert any("standby-timeout-ac 0" in c for c in joined)
        assert any("hibernate-timeout-ac 0" in c for c in joined)

    def test_power_policy_reports_failure_without_raising(self):
        completed = MagicMock(returncode=1, stdout="", stderr="Access is denied")
        with patch.object(service_installer.subprocess, "run", return_value=completed):
            assert service_installer.apply_managed_power_policy() is False

    def test_legacy_starters_are_removed(self):
        calls = []
        completed = MagicMock(returncode=0, stdout="", stderr="")
        with patch.object(
            service_installer.subprocess,
            "run",
            side_effect=lambda a, **k: calls.append(a) or completed,
        ):
            service_installer.remove_legacy_starters()

        joined = [" ".join(c) for c in calls]
        assert any("schtasks /Delete /TN SystemHealthMonitor" in c for c in joined)
        assert any("reg delete" in c and "SystemHealthMonitor" in c for c in joined)


class TestSingleInstance:
    """Two agents on one machine = two pollers for one device (S216)."""

    def test_agent_running_detects_the_process(self):
        completed = MagicMock(returncode=0, stdout="lockdown-agent.exe   7540 Console  1  12,345 K")
        with patch.object(service_installer.subprocess, "run", return_value=completed):
            assert service_installer._agent_running() is True

    def test_agent_running_is_false_when_tasklist_lists_nothing(self):
        completed = MagicMock(
            returncode=0, stdout="INFO: No tasks are running which match the specified criteria."
        )
        with patch.object(service_installer.subprocess, "run", return_value=completed):
            assert service_installer._agent_running() is False

    def test_agent_running_survives_a_missing_tasklist(self):
        with patch.object(service_installer.subprocess, "run", side_effect=FileNotFoundError):
            assert service_installer._agent_running() is False


class TestInstallFlow:
    """Test the install flow with mocked subprocess calls."""

    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "_is_admin", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_install_creates_task_and_registry_key(
        self, mock_subprocess, mock_admin, mock_win, monkeypatch
    ):
        """The task + Run key path is the fallback when a service cannot be created."""
        monkeypatch.setattr(service_installer, "install_service", lambda: False)
        # Mock all subprocess.run calls to return success
        mock_subprocess.run.return_value = MagicMock(returncode=0, stderr="", stdout="")
        mock_subprocess.Popen = MagicMock()

        result = service_installer.install()

        assert result is True
        # Verify schtasks /Create was called
        calls = mock_subprocess.run.call_args_list
        create_calls = [c for c in calls if "/Create" in str(c)]
        assert len(create_calls) > 0
        # Verify reg add was called
        reg_calls = [c for c in calls if "reg" in str(c) and "add" in str(c)]
        assert len(reg_calls) > 0

    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "_is_admin", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_install_prefers_the_service_and_creates_no_task(
        self, mock_subprocess, mock_admin, mock_win, monkeypatch
    ):
        """A service runs at boot without a logon — the task/Run key cannot (S219)."""
        monkeypatch.setattr(service_installer, "install_service", lambda: True)
        mock_subprocess.run.return_value = MagicMock(returncode=0, stderr="", stdout="")

        assert service_installer.install() is True

        calls = mock_subprocess.run.call_args_list
        assert not [c for c in calls if "/Create" in str(c)], "no scheduled task expected"
        assert not [c for c in calls if "reg" in str(c) and "add" in str(c)], "no Run key expected"

    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "_is_admin", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_install_fails_if_schtasks_create_fails(
        self, mock_subprocess, mock_admin, mock_win, monkeypatch
    ):
        monkeypatch.setattr(service_installer, "install_service", lambda: False)
        # subprocess.run calls in order:
        # 1-3. where schtasks/reg/cmd (binary checks) — all succeed
        # 4. schtasks /Delete — succeeds
        # 5. schtasks /Create as current user — fails
        # 6. schtasks /Create as SYSTEM — also fails
        mock_subprocess.run.side_effect = [
            MagicMock(returncode=0, stderr="", stdout=""),  # where schtasks
            MagicMock(returncode=0, stderr="", stdout=""),  # where reg
            MagicMock(returncode=0, stderr="", stdout=""),  # where cmd
            MagicMock(returncode=0, stderr="", stdout=""),  # Delete existing
            MagicMock(returncode=1, stderr="Access denied", stdout=""),  # Create as user fails
            MagicMock(returncode=1, stderr="Access denied", stdout=""),  # Create as SYSTEM fails
        ]
        mock_subprocess.Popen = MagicMock()

        result = service_installer.install()
        assert result is False


class TestUninstallFlow:
    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "_is_admin", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_uninstall_deletes_task_and_registry_key(self, mock_subprocess, mock_admin, mock_win):
        mock_subprocess.run.return_value = MagicMock(returncode=0, stderr="", stdout="")

        result = service_installer.uninstall()

        assert result is True
        calls = mock_subprocess.run.call_args_list
        delete_calls = [c for c in calls if "/Delete" in str(c)]
        assert len(delete_calls) > 0
        reg_delete_calls = [c for c in calls if "reg" in str(c) and "delete" in str(c)]
        assert len(reg_delete_calls) > 0


class TestStatus:
    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_status_returns_dict(self, mock_subprocess, mock_win):
        mock_subprocess.run.return_value = MagicMock(
            returncode=0, stdout="lockdown-agent.exe", stderr=""
        )

        s = service_installer.status()
        assert isinstance(s, dict)
        assert "scheduled_task" in s
        assert "registry_key" in s
        assert "agent_running" in s

    @patch.object(service_installer, "_is_windows", return_value=False)
    def test_status_on_non_windows(self, mock_win):
        s = service_installer.status()
        assert "error" in s
        assert s["scheduled_task"] is False
