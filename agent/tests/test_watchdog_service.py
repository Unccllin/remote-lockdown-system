"""A service install must not demand a second watchdog process (S226).

The agent and the watchdog were meant to watch each other. Once the agent runs as a
Windows service with SCM crash recovery, that mechanism already exists, so shipping a
watchdog would duplicate it — but the agent kept logging "Watchdog not running" on every
healthy install.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent as agent_mod  # noqa: E402


def _patch(monkeypatch, *, watchdog_running, session_zero, service_ok):
    started = []
    monkeypatch.setattr(agent_mod, "_is_watchdog_running", lambda: watchdog_running)
    monkeypatch.setattr(agent_mod, "_start_watchdog", lambda: started.append(True))
    monkeypatch.setattr(agent_mod.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        agent_mod,
        "_detect_session_context",
        lambda: {"is_session_zero": session_zero, "session_id": 0, "console_session_id": 1},
    )
    monkeypatch.setattr(
        agent_mod.subprocess,
        "run",
        lambda *a, **k: MagicMock(returncode=0 if service_ok else 1),
    )
    return started


def test_service_install_does_not_start_a_watchdog(monkeypatch):
    started = _patch(monkeypatch, watchdog_running=False, session_zero=True, service_ok=True)

    agent_mod.check_watchdog_health()

    assert started == [], "the SCM already restarts the agent"


def test_interactive_run_still_uses_the_watchdog(monkeypatch):
    started = _patch(monkeypatch, watchdog_running=False, session_zero=False, service_ok=True)

    agent_mod.check_watchdog_health()

    assert started == [True], "no service, so the watchdog is the only restart mechanism"


def test_session_zero_without_the_service_falls_back_to_the_watchdog(monkeypatch):
    started = _patch(monkeypatch, watchdog_running=False, session_zero=True, service_ok=False)

    agent_mod.check_watchdog_health()

    assert started == [True]


def test_running_watchdog_is_left_alone(monkeypatch):
    started = _patch(monkeypatch, watchdog_running=True, session_zero=False, service_ok=False)

    agent_mod.check_watchdog_health()

    assert started == []
