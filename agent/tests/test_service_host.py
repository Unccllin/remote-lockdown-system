"""Service host: one agent instance, and keep the machine awake (S224).

Both behaviours exist because the frozen agent cannot enforce them itself: it has no
single-instance guard, and it never asks Windows to stay awake.
"""

import hashlib
import json
import sys
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service_host  # noqa: E402


def test_agent_is_running_detects_the_process():
    completed = MagicMock(returncode=0, stdout="lockdown-agent.exe   7540 Services  0  6,716 K")
    with patch.object(service_host.subprocess, "run", return_value=completed):
        assert service_host.agent_is_running() is True


def test_agent_is_running_when_tasklist_lists_nothing():
    completed = MagicMock(
        returncode=0, stdout="INFO: No tasks are running which match the specified criteria."
    )
    with patch.object(service_host.subprocess, "run", return_value=completed):
        assert service_host.agent_is_running() is False


def test_agent_is_running_survives_a_missing_tasklist():
    with patch.object(service_host.subprocess, "run", side_effect=FileNotFoundError):
        assert service_host.agent_is_running() is False


def test_keep_awake_is_best_effort_off_windows():
    """On a host without kernel32 the call must not raise."""
    assert service_host.acquire_keep_awake() in (True, False)
    service_host.release_keep_awake()  # must not raise


def test_supervisor_does_not_start_a_second_agent(monkeypatch):
    """Two pollers for one device is the bug this guard exists for."""

    class StopNow:
        def __init__(self):
            self.calls = 0

        def is_set(self):
            self.calls += 1
            return self.calls > 2  # let the loop check the guard once, then stop

    spawned = []
    monkeypatch.setattr(service_host, "agent_is_running", lambda: True)
    monkeypatch.setattr(service_host.subprocess, "Popen", lambda *a, **k: spawned.append(a))
    monkeypatch.setattr(service_host.time, "sleep", lambda _s: None)

    service_host.run_supervisor(StopNow())

    assert spawned == []


def test_supervisor_starts_the_agent_when_none_runs(monkeypatch):
    class StopAfterOne:
        def __init__(self):
            self.calls = 0

        def is_set(self):
            self.calls += 1
            return self.calls > 1

    class FakeChild:
        returncode = 0

        def poll(self):
            return 0

        def terminate(self):
            pass

        def wait(self, timeout=None):
            return 0

        def kill(self):
            pass

    spawned = []
    monkeypatch.setattr(service_host, "agent_is_running", lambda: False)
    monkeypatch.setattr(
        service_host.subprocess, "Popen", lambda a, **k: spawned.append(a) or FakeChild()
    )
    monkeypatch.setattr(service_host.time, "sleep", lambda _s: None)

    service_host.run_supervisor(StopAfterOne())

    assert spawned, "the agent should have been started"
    # On a frozen install the first element is the agent exe; from source it is the
    # interpreter and the agent script follows.
    assert any(str(part).endswith(("lockdown-agent.exe", "agent.py")) for part in spawned[0])


# ---------------------------------------------------------------------------
# Liveness: a running process is not a working agent (S270)
# ---------------------------------------------------------------------------


class TestLivenessVerdict:
    """The decision is pure, so the table can be pinned without Windows or a process.

    MOLE spent ~14 hours with the agent process alive, `Get-Service` reporting Running,
    and the server receiving nothing. Every layer that could have noticed was asking
    "is there a process?", which answered yes.
    """

    def test_absent_when_nothing_runs(self):
        assert service_host.agent_liveness(False, None) == "absent"

    def test_healthy_when_a_checkin_was_answered_recently(self):
        assert service_host.agent_liveness(True, 30.0) == "healthy"

    def test_stalled_when_the_process_outlives_its_last_answered_checkin(self):
        assert service_host.agent_liveness(True, 14 * 3600.0, uptime=14 * 3600.0) == "stalled"

    def test_starting_inside_the_grace_window(self):
        # A fresh agent has not reported yet; killing it here would be a restart loop.
        assert service_host.agent_liveness(True, None, uptime=10.0) == "starting"

    def test_unjudged_when_this_build_has_no_marker(self):
        # No `.last_checkin_ok` at all = a build from before the marker existed. Absence of
        # evidence must not be treated as evidence of a wedge.
        assert service_host.agent_liveness(True, None, uptime=3600.0) == "unjudged"

    def test_the_checkin_marker_is_not_the_heartbeat(self, tmp_path):
        """The heartbeat kept ticking on MOLE while nothing reached the server.

        Behavioural, not a source-text check: with ONLY a heartbeat file present,
        `last_checkin_age` must still say "never" — otherwise the two signals are the
        same file and the defect comes straight back.
        """
        (tmp_path / ".heartbeat").write_text("", encoding="utf-8")
        with patch.object(service_host, "install_dir", return_value=tmp_path):
            assert service_host.last_checkin_age() is None

            (tmp_path / ".last_checkin_ok").write_text("", encoding="utf-8")
            age = service_host.last_checkin_age()
            assert age is not None and age >= 0


class TestProcessDiscovery:
    def test_agent_pids_reads_every_matching_pid(self):
        # A PyInstaller onefile build is a parent bootloader plus its child; `tasklist`
        # showing two rows is ONE agent (measured on FRANKENSTEIN).
        completed = MagicMock(
            returncode=0,
            stdout=(
                "lockdown-agent.exe   6124 Services  0  6,716 K\n"
                "lockdown-agent.exe  20124 Services  0  6,716 K\n"
            ),
        )
        with patch.object(service_host.subprocess, "run", return_value=completed):
            assert service_host.agent_pids() == [6124, 20124]

    def test_agent_pids_ignores_the_tasklist_banner(self):
        completed = MagicMock(
            returncode=0,
            stdout="INFO: No tasks are running which match the specified criteria.\n",
        )
        with patch.object(service_host.subprocess, "run", return_value=completed):
            assert service_host.agent_pids() == []

    def test_terminate_signals_every_pid(self):
        calls = []
        with (
            patch.object(service_host, "agent_pids", return_value=[6124, 20124]),
            patch.object(
                service_host.subprocess,
                "run",
                side_effect=lambda argv, **kw: calls.append(argv),
            ),
        ):
            assert service_host.terminate_agent_processes() == 2
        assert calls[0][:2] == ["taskkill", "/F"]
        assert "6124" in calls[0] and "20124" in calls[1]


class TestStalledAgentIsRestartedOnlyWhenTheServerAnswers:
    """Offline is not the same as wedged, and only the server can tell them apart."""

    class _Stop:
        def __init__(self, after: int):
            self.calls = 0
            self.after = after

        def is_set(self):
            self.calls += 1
            return self.calls > self.after

    def _run(self, monkeypatch, reachable: bool, age: float):
        spawns = []
        kills = []
        monkeypatch.setattr(service_host, "agent_is_running", lambda: True)
        monkeypatch.setattr(service_host, "last_checkin_age", lambda now=None: age)
        monkeypatch.setattr(service_host, "server_reachable", lambda *a, **k: reachable)
        monkeypatch.setattr(service_host, "terminate_agent_processes", lambda: kills.append(1) or 1)
        monkeypatch.setattr(
            service_host, "agent_command", lambda: ["lockdown-agent.exe", "--silent"]
        )
        monkeypatch.setattr(
            service_host.subprocess, "Popen", lambda *a, **k: spawns.append(a) or None
        )
        monkeypatch.setattr(service_host.time, "sleep", lambda _s: None)
        service_host.run_supervisor(self._Stop(after=3))
        return spawns, kills

    def test_a_stalled_agent_with_a_live_server_is_killed_and_replaced(self, monkeypatch):
        spawns, kills = self._run(monkeypatch, reachable=True, age=14 * 3600.0)
        assert kills == [1], "a stalled agent must be terminated"
        assert spawns, "a replacement must be started after the kill"

    def test_a_stalled_agent_while_offline_is_left_alone(self, monkeypatch):
        spawns, kills = self._run(monkeypatch, reachable=False, age=14 * 3600.0)
        assert kills == [], "an offline device must not have its agent killed"
        assert spawns == []

    def test_a_healthy_agent_is_neither_killed_nor_duplicated(self, monkeypatch):
        spawns, kills = self._run(monkeypatch, reachable=True, age=30.0)
        assert kills == []
        assert spawns == []


class TestServerReachable:
    def test_a_non_http_server_url_is_not_probed(self):
        # urllib would happily open a file:// URL; the scheme is checked first.
        with patch.object(service_host, "_config", return_value={"server_url": "file:///etc"}):
            assert service_host.server_reachable() is False

    def test_an_unreadable_config_is_not_reachable(self):
        with patch.object(service_host, "_config", return_value={}):
            assert service_host.server_reachable() is False

    def test_a_200_health_response_counts_as_reachable(self):
        response = MagicMock()
        response.status = 200
        response.__enter__ = lambda self: self
        response.__exit__ = lambda self, *a: False
        with (
            patch.object(
                service_host,
                "_config",
                return_value={"server_url": "http://192.0.2.20:8787", "verify_tls": False},
            ),
            patch.object(urllib.request, "urlopen", return_value=response),
        ):
            assert service_host.server_reachable() is True


# ---------------------------------------------------------------------------
# S298: the service host applies what the agent verified
# ---------------------------------------------------------------------------
# On MOLE the agent downloaded and signature-verified 1.0.1 and nothing consumed the
# signal, because only agent/watchdog.py reads .update_pending and a service install has
# no watchdog. These tests pin the consumer: what it swaps, what it refuses, and that a
# refused swap leaves the working binary alone.
class TestApplyPendingUpdate:
    def _setup(self, tmp_path, *, sha_ok=True, raw_signal=None):
        target = tmp_path / "lockdown-agent.exe"
        target.write_bytes(b"OLD")
        download = tmp_path / ".update_downloaded"
        download.write_bytes(b"NEW")
        digest = hashlib.sha256(b"NEW").hexdigest() if sha_ok else "0" * 64
        signal = (
            raw_signal
            if raw_signal is not None
            else json.dumps(
                {
                    "version": "1.0.1",
                    "sha256": digest,
                    "download_path": str(download),
                    "signature_verified": True,
                }
            )
        )
        (tmp_path / ".update_pending").write_text(signal, encoding="utf-8")
        return target, download

    def test_no_signal_is_none(self, tmp_path):
        assert service_host.apply_pending_update(tmp_path) == "none"

    def test_a_valid_update_is_swapped_in_and_backed_up(self, tmp_path):
        target, download = self._setup(tmp_path)

        assert service_host.apply_pending_update(tmp_path) == "applied"

        assert target.read_bytes() == b"NEW"
        assert (tmp_path / "lockdown-agent.bak").read_bytes() == b"OLD"
        assert not (tmp_path / ".update_pending").exists()
        assert not download.exists()

    def test_bytes_that_do_not_match_the_signed_hash_are_refused(self, tmp_path):
        """The agent verified the signature; the supervisor still refuses bytes that are
        not the bytes the signal names — that is the whole point of checking twice."""
        target, download = self._setup(tmp_path, sha_ok=False)

        assert service_host.apply_pending_update(tmp_path) == "corrupt"

        assert target.read_bytes() == b"OLD"
        assert not (tmp_path / ".update_pending").exists()
        assert not download.exists()

    def test_an_unreadable_signal_is_corrupt_and_cleared(self, tmp_path):
        target, _ = self._setup(tmp_path, raw_signal="{not json")

        assert service_host.apply_pending_update(tmp_path) == "corrupt"

        assert target.read_bytes() == b"OLD"
        assert not (tmp_path / ".update_pending").exists()

    def test_a_missing_download_is_corrupt(self, tmp_path):
        target, download = self._setup(tmp_path)
        download.unlink()

        assert service_host.apply_pending_update(tmp_path) == "corrupt"
        assert target.read_bytes() == b"OLD"

    def test_restore_backup_puts_the_previous_binary_back(self, tmp_path):
        target = tmp_path / "lockdown-agent.exe"
        target.write_bytes(b"NEW")
        (tmp_path / "lockdown-agent.bak").write_bytes(b"OLD")

        assert service_host.restore_backup(tmp_path) is True
        assert target.read_bytes() == b"OLD"

    def test_restore_backup_without_one_reports_false(self, tmp_path):
        (tmp_path / "lockdown-agent.exe").write_bytes(b"NEW")

        assert service_host.restore_backup(tmp_path) is False
