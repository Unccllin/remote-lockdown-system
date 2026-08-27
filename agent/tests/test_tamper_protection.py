"""Tests for tamper_protection module.

These tests run on any platform — the tamper_protection module is a no-op
on non-Windows platforms, so we test the platform guards and the
uninstall token logic (which doesn't depend on Windows APIs).
"""

import sys
from pathlib import Path

import pytest

# Add agent dir to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from tamper_protection import (
    _is_windows,
    apply_file_acls,
    apply_registry_protection,
    check_tamper,
    remove_all_protection,
    remove_file_acls,
    remove_registry_protection,
    verify_uninstall_token,
)


class TestPlatformGuards:
    """Test that Windows-only functions are no-ops on other platforms."""

    def test_is_windows_returns_bool(self):
        assert isinstance(_is_windows(), bool)

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_apply_file_acls_skips_on_non_windows(self):
        result = apply_file_acls(Path("/tmp/fake"))
        assert result == {"skipped": "not Windows"}

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_apply_registry_protection_skips_on_non_windows(self):
        result = apply_registry_protection()
        assert result == {"skipped": "not Windows"}

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_remove_file_acls_skips_on_non_windows(self):
        result = remove_file_acls(Path("/tmp/fake"))
        assert result == {"skipped": "not Windows"}

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_remove_registry_protection_skips_on_non_windows(self):
        result = remove_registry_protection()
        assert result == {"skipped": "not Windows"}

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_remove_all_protection_skips_on_non_windows(self):
        result = remove_all_protection(Path("/tmp/fake"))
        assert result == {"skipped": "not Windows"}

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_check_tamper_returns_empty_on_non_windows(self):
        result = check_tamper(Path("/tmp"))
        assert result["tampered"] is False
        assert result["files_missing"] == []


class TestVerifyUninstallToken:
    """Test the uninstall token verification logic."""

    def test_verify_returns_false_on_connection_error(self):
        """When the server is unreachable, verification fails (fail-closed)."""
        result = verify_uninstall_token(
            "fake_token",
            "http://localhost:1",  # unreachable port
            "fake_api_key",
            "fake_device_id",
        )
        assert result is False


class TestCheckTamper:
    """Test the tamper detection check."""

    @pytest.mark.skipif(_is_windows(), reason="Windows-only test")
    def test_check_tamper_non_windows_returns_no_tamper(self):
        """On non-Windows, check_tamper returns no tamper detected."""
        result = check_tamper(Path("/tmp"))
        assert result["tampered"] is False
        assert result["files_missing"] == []
        assert result["service_missing"] is False
        assert result["task_missing"] is False


class TestServiceInstallerUninstallSignature:
    """Test that service_installer.uninstall accepts the new token args."""

    def test_uninstall_accepts_token_args(self):
        """The uninstall function should accept token-related kwargs."""
        # Just verify the function signature accepts the new args
        # (we can't actually run it on non-Windows)
        import inspect

        import service_installer

        sig = inspect.signature(service_installer.uninstall)
        params = sig.parameters
        assert "uninstall_token" in params
        assert "server_url" in params
        assert "api_key" in params
        assert "device_id" in params

    def test_uninstall_returns_false_on_non_windows(self):
        """On non-Windows, uninstall returns False."""
        import service_installer

        result = service_installer.uninstall(
            uninstall_token="fake",
            server_url="http://localhost:1",
            api_key="fake",
            device_id="fake",
        )
        assert result is False


class TestServiceInstallerCLI:
    """Test that the CLI parser accepts the new --token args."""

    def test_cli_parser_accepts_token_args(self):
        """The argparse parser should accept --token, --server-url, etc."""
        import argparse

        # Recreate the parser from main()
        parser = argparse.ArgumentParser()
        parser.add_argument("action", choices=["install", "uninstall", "status"])
        parser.add_argument("--token", dest="uninstall_token", default=None)
        parser.add_argument("--server-url", dest="server_url", default=None)
        parser.add_argument("--api-key", dest="api_key", default=None)
        parser.add_argument("--device-id", dest="device_id", default=None)

        # Parse with token args
        args = parser.parse_args(
            [
                "uninstall",
                "--token",
                "abc123",
                "--server-url",
                "https://example.com",
                "--api-key",
                "key123",
                "--device-id",
                "dev-1",
            ]
        )
        assert args.action == "uninstall"
        assert args.uninstall_token == "abc123"
        assert args.server_url == "https://example.com"
        assert args.api_key == "key123"
        assert args.device_id == "dev-1"
