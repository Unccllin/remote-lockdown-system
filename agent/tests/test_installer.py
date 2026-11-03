"""Tests for the agent installer's enrollment token flow.

Covers:
  - enroll_device_with_token() sends the token to /api/enroll/claim
  - --token CLI argument selects the claim flow (no admin token needed)
  - --admin-token still works (backward compatibility)
  - Error handling for expired / invalid / reused tokens
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# installer.py is in the parent directory
sys.path.insert(0, str(Path(__file__).parent.parent))

import installer

# ---------------------------------------------------------------------------
# enroll_device_with_token
# ---------------------------------------------------------------------------


def _mock_response(status_code=201, json_data=None):
    """Create a mock requests.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.text = str(json_data or {})
    return resp


@patch("installer.requests.post")
def test_enroll_with_token_posts_to_claim_endpoint(mock_post):
    """enroll_device_with_token calls POST /api/enroll/claim with the token."""
    mock_post.return_value = _mock_response(
        201,
        {
            "device": {"id": "dev-1", "hostname": "HOST", "status": "active"},
            "api_key": "secret-key",
        },
    )

    result = installer.enroll_device_with_token(
        "https://example.com",
        "my-token",
        "HOST",
        "Owner",
    )

    # Verify the URL is the claim endpoint
    call_args = mock_post.call_args
    assert "/api/enroll/claim" in call_args[0][0]
    # Verify the token is in the payload, not in the Authorization header
    payload = call_args[1]["json"]
    assert payload["token"] == "my-token"
    assert payload["hostname"] == "HOST"
    assert payload["owner_name"] == "Owner"
    # No Authorization header (token replaces admin password)
    headers = call_args[1]["headers"]
    assert "Authorization" not in headers

    # Verify return shape
    assert result["device"]["id"] == "dev-1"
    assert result["api_key"] == "secret-key"


@patch("installer.requests.post")
def test_enroll_with_token_expired_raises(mock_post):
    """Expired token produces a clear error message."""
    mock_post.return_value = _mock_response(401, {"error": "Enrollment token has expired"})

    with pytest.raises(Exception, match="expired"):
        installer.enroll_device_with_token(
            "https://example.com",
            "expired-token",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_invalid_raises(mock_post):
    """Invalid/used token produces a rejection error."""
    mock_post.return_value = _mock_response(
        401, {"error": "Invalid or already-used enrollment token"}
    )

    with pytest.raises(Exception, match="rejected"):
        installer.enroll_device_with_token(
            "https://example.com",
            "bad-token",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_connection_error(mock_post):
    """Connection error is raised as a clear message."""
    import requests

    mock_post.side_effect = requests.exceptions.ConnectionError("boom")

    with pytest.raises(Exception, match="Cannot reach server"):
        installer.enroll_device_with_token(
            "https://example.com",
            "tok",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_timeout(mock_post):
    """Timeout is raised as a clear message."""
    import requests

    mock_post.side_effect = requests.exceptions.Timeout()

    with pytest.raises(Exception, match="30 seconds"):
        installer.enroll_device_with_token(
            "https://example.com",
            "tok",
            "HOST",
            "Owner",
        )


# ---------------------------------------------------------------------------
# Backward compatibility: --admin-token still uses /api/enroll
# ---------------------------------------------------------------------------


@patch("installer.requests.post")
def test_enroll_with_admin_token_uses_enroll_endpoint(mock_post):
    """The legacy --admin-token flow still calls POST /api/enroll."""
    mock_post.return_value = _mock_response(
        201,
        {
            "device": {"id": "dev-2", "hostname": "HOST2", "status": "active"},
            "api_key": "legacy-key",
        },
    )

    result = installer.enroll_device(
        "https://example.com",
        "admin-pass",
        "HOST2",
        "Owner2",
    )

    call_args = mock_post.call_args
    assert "/api/enroll" in call_args[0][0]
    assert "/api/enroll/claim" not in call_args[0][0]
    # Admin token goes in the Authorization header
    headers = call_args[1]["headers"]
    assert headers["Authorization"] == "Bearer admin-pass"
    # No token field in the payload
    payload = call_args[1]["json"]
    assert "token" not in payload

    assert result["api_key"] == "legacy-key"


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


def test_argparse_accepts_token_argument():
    """The --token argument is recognized by the real parser."""
    args = installer.build_parser().parse_args(["--token", "abc123", "--server-url", "https://x"])
    assert args.token == "abc123"
    assert args.admin_token is None
    assert args.uninstall is False


def test_argparse_accepts_admin_token_argument():
    """The --admin-token argument is still recognized (backward compat)."""
    args = installer.build_parser().parse_args(
        ["--admin-token", "secret", "--server-url", "https://x"]
    )
    assert args.admin_token == "secret"
    assert args.token is None


def test_argparse_accepts_uninstall_arguments():
    """--uninstall and --uninstall-token exist on the real parser.

    The generic NSIS uninstaller calls exactly this pair, so a rename here
    silently breaks removal (the wrapper only sees a non-zero exit code).
    """
    args = installer.build_parser().parse_args(["--uninstall", "--uninstall-token", "tok-123"])
    assert args.uninstall is True
    assert args.uninstall_token == "tok-123"


# ---------------------------------------------------------------------------
# run_uninstall — server-authorized removal
# ---------------------------------------------------------------------------


def _write_config(tmp_path, monkeypatch, **overrides):
    """Point installer.CONFIG_FILE at a temp config.json and write it."""
    import json

    config = {
        "server_url": "https://backend.example",
        "api_key": "device-key",
        "hostname": "TEST-HOST",
        "device_id": "dev-9",
    }
    config.update(overrides)
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(config))
    monkeypatch.setattr(installer, "CONFIG_FILE", cfg_path)
    return cfg_path


def test_run_uninstall_without_config_refuses(tmp_path, monkeypatch, capsys):
    """Nothing installed → exit 1 and say so, before asking for a token."""
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "config.json")

    assert installer.run_uninstall("tok") == 1
    assert "nothing is installed" in capsys.readouterr().out


def test_run_uninstall_without_token_does_not_touch_persistence(tmp_path, monkeypatch, capsys):
    """No token → exit 1, and no call reaches service_installer.uninstall().

    This is the tamper-bypass guard: an unauthenticated removal must not even be
    attempted, because a *failed* attempt still resets nothing but logs a local
    admin's attempt as the thing to retry.
    """
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall(None) == 1
    fake.uninstall.assert_not_called()
    out = capsys.readouterr().out
    assert "uninstall token is required" in out
    assert "/api/agent/uninstall-auth" in out


def test_run_uninstall_passes_config_values_to_service_installer(tmp_path, monkeypatch):
    """The token, backend URL, API key and device id come from config.json."""
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    fake.uninstall.return_value = True
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("tok-abc") == 0
    fake.uninstall.assert_called_once_with(
        uninstall_token="tok-abc",
        server_url="https://backend.example",
        api_key="device-key",
        device_id="dev-9",
    )


def test_run_uninstall_reports_backend_refusal(tmp_path, monkeypatch, capsys):
    """When the backend refuses the token, exit 1 and say nothing was removed."""
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    fake.uninstall.return_value = False
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("stale-token") == 1
    assert "did not authorize" in capsys.readouterr().out


def test_run_uninstall_requires_server_url_and_api_key(tmp_path, monkeypatch, capsys):
    """A config without credentials cannot verify a token → refuse."""
    _write_config(tmp_path, monkeypatch, api_key=None)
    fake = MagicMock()
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("tok") == 1
    fake.uninstall.assert_not_called()
    assert "cannot verify" in capsys.readouterr().out


def test_run_uninstall_reports_corrupt_config(tmp_path, monkeypatch, capsys):
    """A malformed config.json is a refusal, not a traceback."""
    cfg = tmp_path / "config.json"
    cfg.write_text("{not json")
    monkeypatch.setattr(installer, "CONFIG_FILE", cfg)

    assert installer.run_uninstall("tok") == 1
    assert "Cannot read" in capsys.readouterr().out


def test_run_uninstall_without_service_installer_module(tmp_path, monkeypatch, capsys):
    """A build without service_installer refuses instead of half-removing."""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "service_installer", None)

    assert installer.run_uninstall("tok") == 1
    assert "service_installer" in capsys.readouterr().out
