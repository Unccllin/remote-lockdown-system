"""Runtime geolocation-key override reconcile + precedence (ADR-010)."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent  # noqa: E402


def _state_dir(tmp_path, monkeypatch):
    d = tmp_path / "state"
    d.mkdir()
    monkeypatch.setattr(agent, "_STATE_DIR", d)
    monkeypatch.setattr(agent, "RUNTIME_SETTINGS_FILE", d / ".runtime_settings")
    return d


def test_settings_present_with_key_writes_file(tmp_path, monkeypatch):
    d = _state_dir(tmp_path, monkeypatch)
    settings = {"google_api_key": "secret-key", "revision": "rev1"}
    agent._reconcile_runtime_settings({"settings": settings})
    f = d / ".runtime_settings"
    assert f.exists()
    data = json.loads(f.read_text())
    assert data["google_api_key"] == "secret-key"
    assert data["revision"] == "rev1"


def test_response_without_settings_leaves_file_untouched(tmp_path, monkeypatch):
    d = _state_dir(tmp_path, monkeypatch)
    f = d / ".runtime_settings"
    f.write_text(json.dumps({"google_api_key": "old", "revision": "r0"}))
    mtime_before = f.stat().st_mtime_ns
    agent._reconcile_runtime_settings({"status": "ok"})
    assert f.read_text() == json.dumps({"google_api_key": "old", "revision": "r0"})
    assert f.stat().st_mtime_ns == mtime_before


def test_null_removes_override_falls_back_to_cfg(tmp_path, monkeypatch):
    d = _state_dir(tmp_path, monkeypatch)
    (d / ".runtime_settings").write_text(json.dumps({"google_api_key": "old", "revision": "r0"}))
    agent._reconcile_runtime_settings({"settings": {"google_api_key": None, "revision": "rev2"}})
    data = json.loads((d / ".runtime_settings").read_text())
    assert data["google_api_key"] is None
    cfg = {"google_api_key": "cfg-key"}
    assert agent._effective_google_key(cfg) == "cfg-key"


def test_same_revision_no_write(tmp_path, monkeypatch):
    d = _state_dir(tmp_path, monkeypatch)
    f = d / ".runtime_settings"
    f.write_text(json.dumps({"google_api_key": "k", "revision": "rev1"}))
    mtime_before = f.stat().st_mtime_ns
    agent._reconcile_runtime_settings({"settings": {"google_api_key": "k", "revision": "rev1"}})
    assert f.stat().st_mtime_ns == mtime_before


def test_write_failure_returns_quietly_no_key_in_warning(tmp_path, monkeypatch, caplog):
    _state_dir(tmp_path, monkeypatch)
    with patch("os.replace", side_effect=OSError("boom")):
        settings = {"google_api_key": "secret-key", "revision": "revx"}
        agent._reconcile_runtime_settings({"settings": settings})
    # no exception
    assert "secret-key" not in caplog.text


def test_precedence_matrix(tmp_path, monkeypatch):
    d = _state_dir(tmp_path, monkeypatch)
    # none -> cfg
    (d / ".runtime_settings").unlink(missing_ok=True)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert agent._effective_google_key({"google_api_key": "cfg-key"}) == "cfg-key"

    # runtime override alone
    (d / ".runtime_settings").write_text(json.dumps({"google_api_key": "rt-key", "revision": "r"}))
    assert agent._effective_google_key({"google_api_key": "cfg-key"}) == "rt-key"

    # env alone
    (d / ".runtime_settings").unlink(missing_ok=True)
    monkeypatch.setenv("GOOGLE_API_KEY", "env-key")
    assert agent._effective_google_key({"google_api_key": "cfg-key"}) == "env-key"
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)

    # none -> None when cfg empty
    assert agent._effective_google_key({}) is None


def test_both_call_sites_use_helper(tmp_path, monkeypatch):
    _state_dir(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "_effective_google_key", lambda cfg: "patched-key")
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: [])
    # Just ensure helper invoked
    calls = {"n": 0}

    def tracked(cfg):
        calls["n"] += 1
        return None

    monkeypatch.setattr(agent, "_effective_google_key", tracked)
    agent.get_geolocation({"google_api_key": "x"})
    agent.resolve_pending_wifi_scans({"google_api_key": "x"})
    assert calls["n"] == 2
