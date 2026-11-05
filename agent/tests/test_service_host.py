"""Service host: one agent instance, and keep the machine awake (S224).

Both behaviours exist because the frozen agent cannot enforce them itself: it has no
single-instance guard, and it never asks Windows to stay awake.
"""

import sys
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
