"""tsdiscon only when there is a console session to disconnect (S225).

The lock guardian re-asserts the lock on a timer. On the live machine it issued
`tsdiscon` every ten seconds while the device already sat at the login screen, which is
both churn and the reason a healthy-looking machine kept dropping its console session.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent as agent_mod  # noqa: E402


def _session_zero(monkeypatch):
    monkeypatch.setattr(agent_mod.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        agent_mod,
        "_detect_session_context",
        lambda: {"is_session_zero": True, "session_id": 0, "console_session_id": 1},
    )
    monkeypatch.setattr(agent_mod, "_DRY_RUN", False)


def test_no_tsdiscon_when_the_console_session_is_not_active(monkeypatch):
    _session_zero(monkeypatch)
    monkeypatch.setattr(agent_mod, "_console_session_active", lambda: False)
    run = MagicMock()
    monkeypatch.setattr(agent_mod.subprocess, "run", run)

    agent_mod._lock_workstation()

    assert not run.called, "tsdiscon must not run when nothing is connected"


def test_tsdiscon_runs_when_the_console_session_is_active(monkeypatch):
    _session_zero(monkeypatch)
    monkeypatch.setattr(agent_mod, "_console_session_active", lambda: True)
    run = MagicMock(return_value=MagicMock(returncode=0))
    monkeypatch.setattr(agent_mod.subprocess, "run", run)

    agent_mod._lock_workstation()

    assert run.called
    args = run.call_args[0][0]
    assert args[0] == "tsdiscon"
    assert args[1] == "1", "the console session id from the context is used"


def test_console_session_active_fails_open_off_windows(monkeypatch):
    """A non-Windows host reports False; the call itself must never raise."""
    monkeypatch.setattr(agent_mod.platform, "system", lambda: "Linux")
    assert agent_mod._console_session_active() is False
