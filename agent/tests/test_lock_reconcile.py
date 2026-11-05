"""A latched lockdown must not outlive the state that justified it (S222).

On the live machine a corrupt deadman file reported status "stolen", a sentinel was
written, and every restart re-asserted it — disconnecting the console session every ten
seconds while the dashboard showed the device as "active".
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent as agent_mod  # noqa: E402


def _cfg(tmp_path):
    return {"lock_sentinel": tmp_path / ".locked"}


@pytest.mark.parametrize("status", ["active", "recovering", "inactive"])
def test_stale_sentinel_is_cleared_when_the_server_says_active(monkeypatch, tmp_path, status):
    cfg = _cfg(tmp_path)
    cfg["lock_sentinel"].write_text('{"locked": true}')

    stopped = []
    monkeypatch.setattr(agent_mod, "stop_lock_guardian", lambda: stopped.append(True))

    agent_mod.reconcile_lock_state(cfg, status)

    assert not cfg["lock_sentinel"].exists(), "the stale latch must be removed"
    assert stopped == [True], "the guardian must be stopped, or it keeps re-locking"


@pytest.mark.parametrize("status", ["stolen", "locked", "tracking"])
def test_sentinel_is_kept_when_the_server_wants_it_locked(monkeypatch, tmp_path, status):
    cfg = _cfg(tmp_path)
    cfg["lock_sentinel"].write_text('{"locked": true}')

    monkeypatch.setattr(
        agent_mod, "stop_lock_guardian", lambda: pytest.fail("must not stop the guardian")
    )

    agent_mod.reconcile_lock_state(cfg, status)

    assert cfg["lock_sentinel"].exists()


def test_no_sentinel_is_a_no_op(monkeypatch, tmp_path):
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(agent_mod, "stop_lock_guardian", lambda: pytest.fail("nothing to stop"))

    agent_mod.reconcile_lock_state(cfg, "active")

    assert not cfg["lock_sentinel"].exists()
