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

    def test_build_watchdog_command_includes_powershell(self):
        cmd = service_installer._build_watchdog_command()
        assert "powershell" in cmd.lower()
        assert "EncodedCommand" in cmd


class TestInstallFlow:
    """Test the install flow with mocked subprocess calls."""

    @patch.object(service_installer, "_is_windows", return_value=True)
    @patch.object(service_installer, "_is_admin", return_value=True)
    @patch.object(service_installer, "subprocess")
    def test_install_creates_task_and_registry_key(self, mock_subprocess, mock_admin, mock_win):
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
    def test_install_fails_if_schtasks_create_fails(self, mock_subprocess, mock_admin, mock_win):
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
