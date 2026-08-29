"""Tests for the boot lockdown diagnostic module (agent/diagnose_boot_lockdown.py).

Covers:
  - run_cmd() success and exception handling
  - run_powershell() success and exception handling
  - check_admin() on Windows and non-Windows
  - check_admin_net_session() delegates to run_cmd
  - check_bitlocker() output parsing
  - check_hp_wmi() PowerShell delegation
  - get_hp_model() PowerShell delegation
  - list_hp_bios_settings() output parsing
  - check_sure_admin() PowerShell delegation
  - check_bios_password() PowerShell delegation
  - check_bcd_settings() runs multiple bcdedit queries
  - check_winre() output parsing
  - check_existing_state_files() with a temp agent dir
  - check_agent_process() tasklist parsing
  - check_scheduled_task() schtasks parsing

All subprocess calls are mocked — no real commands are executed.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

import diagnose_boot_lockdown  # noqa: E402

# ---------------------------------------------------------------------------
# run_cmd
# ---------------------------------------------------------------------------


class TestRunCmd:
    def test_successful_command(self):
        """run_cmd returns returncode, stdout, stderr on success."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "  output line  \n"
        mock_result.stderr = "  err  \n"

        with patch("subprocess.run", return_value=mock_result):
            result = diagnose_boot_lockdown.run_cmd(["echo", "hello"])

        assert result["returncode"] == 0
        assert result["stdout"] == "output line"  # stripped
        assert result["stderr"] == "err"

    def test_failed_command(self):
        """run_cmd returns non-zero returncode on failure."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "command not found"

        with patch("subprocess.run", return_value=mock_result):
            result = diagnose_boot_lockdown.run_cmd(["badcmd"])

        assert result["returncode"] == 1
        assert result["stderr"] == "command not found"

    def test_exception_returns_error_dict(self):
        """If subprocess.run raises, run_cmd returns returncode=-1."""
        with patch("subprocess.run", side_effect=TimeoutError("timed out")):
            result = diagnose_boot_lockdown.run_cmd(["slowcmd"], timeout=5)

        assert result["returncode"] == -1
        assert result["stdout"] == ""
        assert "timed out" in result["stderr"]


# ---------------------------------------------------------------------------
# run_powershell
# ---------------------------------------------------------------------------


class TestRunPowershell:
    def test_successful_powershell(self):
        """run_powershell returns the stripped stdout."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "  HP_WMI_AVAILABLE: true  \n"
        mock_result.stderr = ""

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            result = diagnose_boot_lockdown.run_powershell("Get-WmiObject ...")

        assert result["returncode"] == 0
        assert result["stdout"] == "HP_WMI_AVAILABLE: true"
        # Verify it calls powershell with -NoProfile -Command
        args = mock_run.call_args[0][0]
        assert args[0] == "powershell"
        assert "-NoProfile" in args
        assert "-Command" in args

    def test_powershell_exception(self):
        """If subprocess.run raises, run_powershell returns error dict."""
        with patch("subprocess.run", side_effect=FileNotFoundError("no powershell")):
            result = diagnose_boot_lockdown.run_powershell("Get-Process")

        assert result["returncode"] == -1
        assert "no powershell" in result["stderr"]


# ---------------------------------------------------------------------------
# check_admin
# ---------------------------------------------------------------------------


class TestCheckAdmin:
    def test_non_windows_returns_false(self):
        """On non-Windows platforms, check_admin returns False."""
        with patch("platform.system", return_value="Linux"):
            assert diagnose_boot_lockdown.check_admin() is False

    def test_windows_admin_returns_true(self):
        """On Windows with admin privileges, returns True."""
        mock_windll = MagicMock()
        mock_windll.shell32.IsUserAnAdmin.return_value = 1

        with (
            patch("platform.system", return_value="Windows"),
            patch.object(diagnose_boot_lockdown.ctypes, "windll", mock_windll, create=True),
        ):
            assert diagnose_boot_lockdown.check_admin() is True

    def test_windows_non_admin_returns_false(self):
        """On Windows without admin privileges, returns False."""
        mock_windll = MagicMock()
        mock_windll.shell32.IsUserAnAdmin.return_value = 0

        with (
            patch("platform.system", return_value="Windows"),
            patch.object(diagnose_boot_lockdown.ctypes, "windll", mock_windll, create=True),
        ):
            assert diagnose_boot_lockdown.check_admin() is False

    def test_windows_exception_returns_false(self):
        """If ctypes raises, check_admin returns False."""
        mock_windll = MagicMock()
        mock_windll.shell32.IsUserAnAdmin.side_effect = AttributeError("no shell32")

        with (
            patch("platform.system", return_value="Windows"),
            patch.object(diagnose_boot_lockdown.ctypes, "windll", mock_windll, create=True),
        ):
            assert diagnose_boot_lockdown.check_admin() is False


# ---------------------------------------------------------------------------
# check_admin_net_session
# ---------------------------------------------------------------------------


class TestCheckAdminNetSession:
    def test_delegates_to_run_cmd(self):
        """check_admin_net_session calls run_cmd with ['net', 'session']."""
        expected = {"returncode": 0, "stdout": "", "stderr": ""}
        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=expected) as mock:
            result = diagnose_boot_lockdown.check_admin_net_session()

        assert result == expected
        mock.assert_called_once_with(["net", "session"], timeout=5)


# ---------------------------------------------------------------------------
# check_bitlocker
# ---------------------------------------------------------------------------


class TestCheckBitlocker:
    def test_protection_on_parsed(self):
        """BitLocker output with 'Protection Status: On' sets protection_on=True."""
        output = (
            "Conversion Status: Fully Encrypted\n"
            "Protection Status: On\n"
            "Percentage Encrypted: 100%\n"
        )
        mock_result = {"returncode": 0, "stdout": output, "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            info = diagnose_boot_lockdown.check_bitlocker()

        assert info["protection_on"] is True
        assert info["encryption_percentage"] == "100"

    def test_protection_off_parsed(self):
        """BitLocker output with 'Protection Status: Off' sets protection_on=False."""
        output = "Protection Status: Off\nPercentage Encrypted: 0%\n"
        mock_result = {"returncode": 0, "stdout": output, "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            info = diagnose_boot_lockdown.check_bitlocker()

        assert info["protection_on"] is False
        assert info["encryption_percentage"] == "0"

    def test_empty_output(self):
        """Empty BitLocker output returns defaults."""
        mock_result = {"returncode": 1, "stdout": "", "stderr": "not found"}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            info = diagnose_boot_lockdown.check_bitlocker()

        assert info["protection_on"] is False
        assert info["encryption_percentage"] is None


# ---------------------------------------------------------------------------
# check_hp_wmi / get_hp_model
# ---------------------------------------------------------------------------


class TestCheckHpWmi:
    def test_returns_powershell_result(self):
        """check_hp_wmi delegates to run_powershell."""
        expected = {"returncode": 0, "stdout": "HP_WMI_AVAILABLE: true", "stderr": ""}
        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=expected) as mock:
            result = diagnose_boot_lockdown.check_hp_wmi()

        assert result == expected
        mock.assert_called_once()


class TestGetHpModel:
    def test_returns_powershell_result(self):
        """get_hp_model delegates to run_powershell."""
        expected = {"returncode": 0, "stdout": "HP EliteBook 840 G7", "stderr": ""}
        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=expected):
            result = diagnose_boot_lockdown.get_hp_model()

        assert result == expected


# ---------------------------------------------------------------------------
# list_hp_bios_settings
# ---------------------------------------------------------------------------


class TestListHpBiosSettings:
    def test_parses_settings_output(self):
        """Output lines with ' = ' are parsed into a settings dict."""
        output = "USB Boot = Enable\nNetwork Boot = Disable\nERROR: something\n"
        mock_result = {"returncode": 0, "stdout": output, "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=mock_result):
            result = diagnose_boot_lockdown.list_hp_bios_settings()

        assert result["count"] == 2
        assert result["settings"]["USB Boot"] == "Enable"
        assert result["settings"]["Network Boot"] == "Disable"
        # ERROR lines are not parsed as settings
        assert "ERROR" not in result["settings"]

    def test_empty_output(self):
        """Empty output returns zero settings."""
        mock_result = {"returncode": 0, "stdout": "", "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=mock_result):
            result = diagnose_boot_lockdown.list_hp_bios_settings()

        assert result["count"] == 0
        assert result["settings"] == {}


# ---------------------------------------------------------------------------
# check_sure_admin / check_bios_password
# ---------------------------------------------------------------------------


class TestCheckSureAdmin:
    def test_delegates_to_powershell(self):
        """check_sure_admin delegates to run_powershell."""
        expected = {"returncode": 0, "stdout": "FOUND: EBAM = Enable", "stderr": ""}
        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=expected):
            result = diagnose_boot_lockdown.check_sure_admin()
        assert result == expected


class TestCheckBiosPassword:
    def test_delegates_to_powershell(self):
        """check_bios_password delegates to run_powershell."""
        expected = {"returncode": 0, "stdout": "Setup Password: IsSet=True", "stderr": ""}
        with patch.object(diagnose_boot_lockdown, "run_powershell", return_value=expected):
            result = diagnose_boot_lockdown.check_bios_password()
        assert result == expected


# ---------------------------------------------------------------------------
# check_bcd_settings
# ---------------------------------------------------------------------------


class TestCheckBcdSettings:
    def test_runs_all_bcdedit_queries(self):
        """check_bcd_settings runs 4 bcdedit queries and stores results."""
        mock_result = {"returncode": 0, "stdout": "value", "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result) as mock:
            settings = diagnose_boot_lockdown.check_bcd_settings()

        assert mock.call_count == 4
        assert "recoveryenabled" in settings
        assert "displaybootmenu" in settings
        assert "bootsequence" in settings
        assert "timeout" in settings
        for name in settings:
            assert settings[name]["returncode"] == 0


# ---------------------------------------------------------------------------
# check_winre
# ---------------------------------------------------------------------------


class TestCheckWinre:
    def test_enabled_detected(self):
        """WinRE output containing 'Enabled' sets enabled=True."""
        mock_result = {
            "returncode": 0,
            "stdout": "Windows Recovery Environment: Enabled",
            "stderr": "",
        }
        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            info = diagnose_boot_lockdown.check_winre()
        assert info["enabled"] is True

    def test_disabled_detected(self):
        """WinRE output without 'Enabled' sets enabled=False."""
        mock_result = {
            "returncode": 0,
            "stdout": "Windows Recovery Environment: Disabled",
            "stderr": "",
        }
        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            info = diagnose_boot_lockdown.check_winre()
        assert info["enabled"] is False


# ---------------------------------------------------------------------------
# check_existing_state_files
# ---------------------------------------------------------------------------


class TestCheckExistingStateFiles:
    def test_reports_missing_and_existing_files(self, tmp_path):
        """State files that exist are reported with content; missing ones without."""
        # Create some state files
        (tmp_path / ".bcd_state").write_text('{"locked": true}')
        (tmp_path / ".heartbeat").write_text("1234567890")

        with patch.object(diagnose_boot_lockdown, "__file__", str(tmp_path / "fake.py")):
            files = diagnose_boot_lockdown.check_existing_state_files()

        expected_files = [
            ".bcd_state",
            ".boot_state",
            ".pending_ack",
            ".deadman",
            ".locked",
            ".heartbeat",
            ".watchdog_heartbeat",
        ]
        for fname in expected_files:
            assert fname in files
            assert "exists" in files[fname]
            assert "path" in files[fname]

        assert files[".bcd_state"]["exists"] is True
        assert "locked" in files[".bcd_state"]["content"]
        assert files[".heartbeat"]["exists"] is True
        assert files[".boot_state"]["exists"] is False


# ---------------------------------------------------------------------------
# check_agent_process
# ---------------------------------------------------------------------------


class TestCheckAgentProcess:
    def test_agent_running_detected(self):
        """tasklist output containing 'lockdown-agent.exe' sets agent_running=True."""
        agent_result = {"returncode": 0, "stdout": "lockdown-agent.exe 1234 Console", "stderr": ""}
        wd_result = {"returncode": 0, "stdout": "INFO: No tasks running", "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", side_effect=[agent_result, wd_result]):
            result = diagnose_boot_lockdown.check_agent_process()

        assert result["agent_running"] is True
        assert result["watchdog_running"] is False

    def test_neither_running(self):
        """Empty tasklist output sets both to False."""
        empty = {"returncode": 0, "stdout": "INFO: No tasks running", "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", side_effect=[empty, empty]):
            result = diagnose_boot_lockdown.check_agent_process()

        assert result["agent_running"] is False
        assert result["watchdog_running"] is False


# ---------------------------------------------------------------------------
# check_scheduled_task
# ---------------------------------------------------------------------------


class TestCheckScheduledTask:
    def test_task_exists(self):
        """Returncode 0 means the scheduled task exists."""
        mock_result = {"returncode": 0, "stdout": "TaskName: SystemHealthMonitor", "stderr": ""}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            result = diagnose_boot_lockdown.check_scheduled_task()

        assert result["exists"] is True

    def test_task_missing(self):
        """Non-zero returncode means the task doesn't exist."""
        mock_result = {"returncode": 1, "stdout": "", "stderr": "ERROR: Task not found"}

        with patch.object(diagnose_boot_lockdown, "run_cmd", return_value=mock_result):
            result = diagnose_boot_lockdown.check_scheduled_task()

        assert result["exists"] is False
