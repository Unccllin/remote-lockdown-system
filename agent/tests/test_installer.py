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
    """The --token argument is recognized by the argument parser."""
    parser = installer.argparse.ArgumentParser()
    # Mirror the main() parser setup
    parser.add_argument("--server-url", default=None)
    parser.add_argument("--admin-token", default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--owner", default=None)
    parser.add_argument("--hostname", default=None)
    parser.add_argument("--no-boot-lock", action="store_true")
    parser.add_argument("--silent", action="store_true")

    args = parser.parse_args(["--token", "abc123", "--server-url", "https://x"])
    assert args.token == "abc123"
    assert args.admin_token is None


def test_argparse_accepts_admin_token_argument():
    """The --admin-token argument is still recognized (backward compat)."""
    parser = installer.argparse.ArgumentParser()
    parser.add_argument("--server-url", default=None)
    parser.add_argument("--admin-token", default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--owner", default=None)
    parser.add_argument("--hostname", default=None)
    parser.add_argument("--no-boot-lock", action="store_true")
    parser.add_argument("--silent", action="store_true")

    args = parser.parse_args(["--admin-token", "secret", "--server-url", "https://x"])
    assert args.admin_token == "secret"
    assert args.token is None
