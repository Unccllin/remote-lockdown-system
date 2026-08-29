"""Tests for the watchdog module (agent/watchdog.py).

Covers:
  - _is_frozen() detection logic
  - start_agent() launches the correct command (Python vs binary)
  - stop_agent() terminates / kills the process
  - is_heartbeat_stale() freshness logic
  - check_and_apply_update() update signal handling + binary replacement
  - main() exits when agent script is missing

All subprocess and filesystem dependencies are mocked.
"""

import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import watchdog  # noqa: E402

# ---------------------------------------------------------------------------
# _is_frozen
# ---------------------------------------------------------------------------


class TestIsFrozen:
    def test_returns_false_when_not_frozen(self):
        """In a normal test environment _is_frozen returns False."""
        with patch.object(sys, "frozen", False, create=True):
            assert watchdog._is_frozen() is False

    def test_returns_false_when_no_meipass(self):
        """sys.frozen=True but no _MEIPASS means not a PyInstaller bundle."""
        with patch.object(sys, "frozen", True, create=True):
            if hasattr(sys, "_MEIPASS"):
                delattr(sys, "_MEIPASS")
            assert watchdog._is_frozen() is False

    def test_returns_true_when_frozen_and_meipass(self):
        """Both sys.frozen and sys._MEIPASS set → frozen (PyInstaller)."""
        with (
            patch.object(sys, "frozen", True, create=True),
            patch.object(sys, "_MEIPASS", "/tmp/fake", create=True),
        ):
            assert watchdog._is_frozen() is True


# ---------------------------------------------------------------------------
# start_agent
# ---------------------------------------------------------------------------


class TestStartAgent:
    @patch("watchdog.subprocess.Popen")
    def test_start_agent_via_python(self, mock_popen, tmp_path):
        """When LAUNCH_VIA_PYTHON is True, launches [python, agent.py]."""
        fake_script = tmp_path / "agent.py"
        fake_script.write_text("# fake")
        mock_proc = MagicMock()
        mock_proc.pid = 12345
        mock_popen.return_value = mock_proc

        with (
            patch.object(watchdog, "LAUNCH_VIA_PYTHON", True),
            patch.object(watchdog, "AGENT_SCRIPT", fake_script),
            patch.object(watchdog, "PYTHON_EXE", "/usr/bin/python3"),
        ):
            proc = watchdog.start_agent()

        mock_popen.assert_called_once()
        args = mock_popen.call_args
        assert args[0][0] == ["/usr/bin/python3", str(fake_script)]
        assert args[1]["cwd"] == str(fake_script.parent)
        assert proc == mock_proc

    @patch("watchdog.subprocess.Popen")
    def test_start_agent_via_binary(self, mock_popen, tmp_path):
        """When LAUNCH_VIA_PYTHON is False, launches the binary directly."""
        fake_bin = tmp_path / "lockdown-agent"
        fake_bin.write_text("# fake binary")
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        mock_popen.return_value = mock_proc

        with (
            patch.object(watchdog, "LAUNCH_VIA_PYTHON", False),
            patch.object(watchdog, "AGENT_SCRIPT", fake_bin),
        ):
            proc = watchdog.start_agent()

        mock_popen.assert_called_once()
        args = mock_popen.call_args
        assert args[0][0] == [str(fake_bin)]
        assert args[1]["cwd"] == str(fake_bin.parent)
        assert proc == mock_proc


# ---------------------------------------------------------------------------
# stop_agent
# ---------------------------------------------------------------------------


class TestStopAgent:
    def test_stop_agent_terminates_running_process(self):
        """stop_agent calls terminate() then wait() on a running process."""
        proc = MagicMock()
        proc.poll.return_value = None  # still running
        proc.pid = 1234

        watchdog.stop_agent(proc)

        proc.terminate.assert_called_once()
        proc.wait.assert_called_once_with(timeout=10)
        proc.kill.assert_not_called()

    def test_stop_agent_kills_on_timeout(self):
        """If terminate() times out, stop_agent escalates to kill()."""
        proc = MagicMock()
        proc.poll.return_value = None
        proc.pid = 1234
        proc.wait.side_effect = watchdog.subprocess.TimeoutExpired(cmd="x", timeout=10)

        watchdog.stop_agent(proc)

        proc.terminate.assert_called_once()
        proc.kill.assert_called_once()

    def test_stop_agent_noop_if_already_exited(self):
        """If the process already exited, stop_agent does nothing."""
        proc = MagicMock()
        proc.poll.return_value = 0  # exited

        watchdog.stop_agent(proc)

        proc.terminate.assert_not_called()
        proc.kill.assert_not_called()

    def test_stop_agent_noop_if_none(self):
        """stop_agent(None) should not raise."""
        watchdog.stop_agent(None)


# ---------------------------------------------------------------------------
# is_heartbeat_stale
# ---------------------------------------------------------------------------


class TestIsHeartbeatStale:
    def test_no_heartbeat_file_returns_false(self, tmp_path):
        """No heartbeat file → not stale (agent just started)."""
        hb = tmp_path / ".heartbeat"
        with patch.object(watchdog, "HEARTBEAT_FILE", hb):
            assert watchdog.is_heartbeat_stale() is False

    def test_fresh_heartbeat_returns_false(self, tmp_path):
        """A recently written heartbeat is not stale."""
        hb = tmp_path / ".heartbeat"
        hb.write_text("alive")
        with (
            patch.object(watchdog, "HEARTBEAT_FILE", hb),
            patch.object(watchdog, "HEARTBEAT_MAX_AGE_SEC", 120),
        ):
            assert watchdog.is_heartbeat_stale() is False

    def test_stale_heartbeat_returns_true(self, tmp_path):
        """A heartbeat older than HEARTBEAT_MAX_AGE_SEC is stale."""
        hb = tmp_path / ".heartbeat"
        hb.write_text("alive")
        old_time = time.time() - 300  # 5 minutes ago
        os.utime(str(hb), (old_time, old_time))

        with (
            patch.object(watchdog, "HEARTBEAT_FILE", hb),
            patch.object(watchdog, "HEARTBEAT_MAX_AGE_SEC", 120),
        ):
            assert watchdog.is_heartbeat_stale() is True


# ---------------------------------------------------------------------------
# check_and_apply_update
# ---------------------------------------------------------------------------


class TestCheckAndApplyUpdate:
    def test_no_update_pending_returns_false(self, tmp_path):
        """No .update_pending file → returns False, no action."""
        update_pending = tmp_path / ".update_pending"
        with patch.object(watchdog, "UPDATE_PENDING_FILE", update_pending):
            assert watchdog.check_and_apply_update() is False

    def test_invalid_json_clears_signal(self, tmp_path):
        """Corrupt update signal file is removed and returns False."""
        update_pending = tmp_path / ".update_pending"
        update_pending.write_text("not valid json{{{")
        with (
            patch.object(watchdog, "UPDATE_PENDING_FILE", update_pending),
            patch.object(watchdog, "_agent_proc", None),
        ):
            result = watchdog.check_and_apply_update()
        assert result is False
        assert not update_pending.exists()

    def test_missing_download_binary_clears_signal(self, tmp_path):
        """Update signal points to a non-existent binary → cleared."""
        update_pending = tmp_path / ".update_pending"
        update_pending.write_text(
            json.dumps({"download_path": str(tmp_path / "nonexistent.bin"), "version": "1.0"})
        )
        with (
            patch.object(watchdog, "UPDATE_PENDING_FILE", update_pending),
            patch.object(watchdog, "_agent_proc", None),
        ):
            result = watchdog.check_and_apply_update()
        assert result is False
        assert not update_pending.exists()

    @patch("watchdog.stop_agent")
    @patch("watchdog.start_agent")
    def test_successful_update_replaces_binary(self, mock_start, mock_stop, tmp_path):
        """A valid update signal replaces the agent binary and returns True."""
        agent_script = tmp_path / "lockdown-agent"
        agent_script.write_text("old binary")
        download = tmp_path / "new_agent.bin"
        download.write_text("new binary content")
        update_pending = tmp_path / ".update_pending"
        update_pending.write_text(json.dumps({"download_path": str(download), "version": "2.0"}))

        mock_start.return_value = MagicMock()

        with (
            patch.object(watchdog, "UPDATE_PENDING_FILE", update_pending),
            patch.object(watchdog, "AGENT_SCRIPT", agent_script),
            patch.object(watchdog, "_agent_proc", MagicMock()),
        ):
            result = watchdog.check_and_apply_update()

        assert result is True
        mock_stop.assert_called_once()
        # Binary was replaced
        assert agent_script.read_text() == "new binary content"
        # Signal file cleaned up
        assert not update_pending.exists()
        # Backup cleaned up
        backup = agent_script.with_suffix(".bak")
        assert not backup.exists()

    @patch("watchdog.stop_agent")
    @patch("watchdog.start_agent")
    def test_failed_update_restores_backup(self, mock_start, mock_stop, tmp_path):
        """If the binary replacement fails, the backup is restored."""
        agent_script = tmp_path / "lockdown-agent"
        agent_script.write_text("old binary")
        download = tmp_path / "new_agent.bin"
        download.write_text("new binary content")
        update_pending = tmp_path / ".update_pending"
        update_pending.write_text(json.dumps({"download_path": str(download), "version": "2.0"}))

        mock_start.return_value = MagicMock()

        # Make shutil.move fail when replacing the binary
        with (
            patch.object(watchdog, "UPDATE_PENDING_FILE", update_pending),
            patch.object(watchdog, "AGENT_SCRIPT", agent_script),
            patch.object(watchdog, "_agent_proc", MagicMock()),
            patch("shutil.move", side_effect=OSError("disk full")),
        ):
            result = watchdog.check_and_apply_update()

        assert result is False
        # Agent was restarted after failure
        mock_start.assert_called_once()
        # Signal file cleaned up
        assert not update_pending.exists()


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


class TestMain:
    def test_main_exits_when_agent_script_missing(self, tmp_path):
        """main() calls sys.exit(1) if the agent script doesn't exist."""
        missing_script = tmp_path / "nonexistent_agent.py"

        with (
            patch.object(watchdog, "AGENT_SCRIPT", missing_script),
            pytest.raises(SystemExit) as exc_info,
        ):
            watchdog.main()

        assert exc_info.value.code == 1
