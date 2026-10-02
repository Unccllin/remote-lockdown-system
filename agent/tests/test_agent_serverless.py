"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json
import os

# We need to import agent.py which is in the parent directory
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))


import agent

# Shared fixtures (tmp_folder, tmp_sentinel, cfg, cleanup_guardian)
# are now provided by tests/conftest.py — no need to redefine here.

# ---------------------------------------------------------------------------
# Serverless fallback
# ---------------------------------------------------------------------------


class TestServerlessFallback:
    """Tests for _post_with_fallback — primary server failure → serverless fallback."""

    def test_fallback_on_connection_error(self, cfg):
        """When primary server is unreachable, fall back to serverless_url."""
        import requests as real_requests

        cfg["serverless_url"] = "https://worker.example.workers.dev"
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.side_effect = [
                real_requests.ConnectionError("primary down"),
                mock_resp,
            ]
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            resp = agent._post_with_fallback("/api/agent/checkin", cfg, {"hostname": "TEST"})
            assert resp is mock_resp
            # First call to primary, second to fallback
            assert mock_requests.post.call_count == 2
            assert "test-server.example.com" in str(mock_requests.post.call_args_list[0])
            assert "worker.example.workers.dev" in str(mock_requests.post.call_args_list[1])

    def test_no_fallback_when_serverless_not_configured(self, cfg):
        """Without serverless_url, connection error propagates (no fallback)."""
        import requests as real_requests

        cfg["serverless_url"] = ""
        with patch.object(agent, "requests") as mock_requests:
            mock_requests.post.side_effect = real_requests.ConnectionError("primary down")
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            with pytest.raises(real_requests.ConnectionError):
                agent._post_with_fallback("/api/agent/checkin", cfg, {"hostname": "TEST"})
            assert mock_requests.post.call_count == 1

    def test_no_fallback_on_http_error(self, cfg):
        """HTTP errors (4xx/5xx) are NOT retried on fallback — only connection errors."""
        import requests as real_requests

        cfg["serverless_url"] = "https://worker.example.workers.dev"
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.raise_for_status.side_effect = real_requests.HTTPError("404 Not Found")
            mock_requests.post.return_value = mock_resp
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            resp = agent._post_with_fallback("/api/agent/checkin", cfg, {"hostname": "TEST"})
            # Should return the response (HTTP errors are not connection errors)
            assert resp is mock_resp
            assert mock_requests.post.call_count == 1

    def test_fallback_on_timeout(self, cfg):
        """Timeout triggers fallback to serverless_url."""
        import requests as real_requests

        cfg["serverless_url"] = "https://worker.example.workers.dev"
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.side_effect = [
                real_requests.Timeout("primary timed out"),
                mock_resp,
            ]
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            resp = agent._post_with_fallback("/api/agent/checkin", cfg, {"hostname": "TEST"})
            assert resp is mock_resp
            assert mock_requests.post.call_count == 2

    def test_checkin_uses_fallback(self, cfg):
        """checkin() should succeed via fallback when primary is down."""
        import requests as real_requests

        cfg["serverless_url"] = "https://worker.example.workers.dev"
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"status": "active", "command": None}
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.side_effect = [
                real_requests.ConnectionError("primary down"),
                mock_resp,
            ]
            mock_requests.RequestException = real_requests.RequestException
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            result = agent.checkin(cfg)
            assert result is not None
            assert result["status"] == "active"


class TestServerlessConfig:
    """Tests for serverless_url config loading and validation."""

    def test_load_config_serverless_url_from_env(self):
        """SERVERLESS_URL env var should populate serverless_url."""
        env = {"SERVERLESS_URL": "https://my-worker.workers.dev"}
        with patch.dict(os.environ, env, clear=True):
            cfg = agent.load_config()
            assert cfg["serverless_url"] == "https://my-worker.workers.dev"

    def test_load_config_serverless_url_default_empty(self):
        """serverless_url should default to empty string when not set."""
        with patch.dict(os.environ, {}, clear=True):
            cfg = agent.load_config()
            assert cfg["serverless_url"] == ""

    def test_validate_config_accepts_valid_serverless_url(self, cfg):
        """validate_config should accept a valid https serverless_url."""
        cfg["serverless_url"] = "https://my-worker.workers.dev"
        agent.validate_config(cfg)  # should not raise

    def test_validate_config_rejects_http_serverless_url(self, cfg):
        """validate_config should reject http:// serverless_url (TLS required)."""
        cfg["serverless_url"] = "http://insecure.example.com"
        with pytest.raises(ValueError, match="SERVERLESS_URL must use https://"):
            agent.validate_config(cfg)

    def test_validate_config_allows_http_serverless_in_dev_mode(self, cfg):
        """validate_config should allow http:// serverless_url when verify_tls=False."""
        cfg["serverless_url"] = "http://localhost:8787"
        cfg["verify_tls"] = False
        agent.validate_config(cfg)  # should not raise

    def test_validate_config_rejects_serverless_url_without_host(self, cfg):
        """validate_config should reject serverless_url with no host."""
        cfg["serverless_url"] = "https://"
        with pytest.raises(ValueError, match="SERVERLESS_URL is missing a host"):
            agent.validate_config(cfg)


# ---------------------------------------------------------------------------
# Geolocation
# ---------------------------------------------------------------------------


class TestGeolocation:
    def test_get_ip_geolocation_returns_location(self):
        """IP geolocation should return lat/long from ip-api.com."""
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {
                "status": "success",
                "lat": 37.7749,
                "lon": -122.4194,
                "city": "San Francisco",
                "regionName": "CA",
                "countryCode": "US",
                "query": "1.2.3.4",
            }
            mock_resp.raise_for_status = MagicMock()
            mock_requests.get.return_value = mock_resp

            result = agent.get_ip_geolocation()
            assert result is not None
            assert result["latitude"] == 37.7749
            assert result["longitude"] == -122.4194
            assert result["source"] == "ip"
            assert result["city"] == "San Francisco"

    def test_get_ip_geolocation_returns_none_on_failure(self):
        import requests as real_requests

        with patch.object(agent, "requests") as mock_requests:
            mock_requests.RequestException = real_requests.RequestException
            mock_requests.get.side_effect = real_requests.RequestException("Network error")
            result = agent.get_ip_geolocation()
            assert result is None

    def test_get_geolocation_falls_back_to_ip_without_api_key(self, cfg):
        """Without a Google API key, should fall back to IP geolocation."""
        cfg["google_api_key"] = ""
        with patch.object(agent, "get_ip_geolocation") as mock_ip:
            mock_ip.return_value = {"latitude": 1, "longitude": 2, "source": "ip"}
            result = agent.get_geolocation(cfg)
            assert result["source"] == "ip"
            mock_ip.assert_called_once()

    def test_get_geolocation_uses_wifi_with_api_key(self, cfg):
        """With a Google API key and WiFi networks, should use WiFi triangulation."""
        cfg["google_api_key"] = "test-key"
        with (
            patch.object(agent, "scan_wifi_networks") as mock_scan,
            patch.object(agent, "requests") as mock_requests,
        ):
            mock_scan.return_value = [{"bssid": "AA:BB:CC:DD:EE:FF", "signal": 80}]
            mock_resp = MagicMock()
            mock_resp.json.return_value = {
                "location": {"lat": 37.77, "lng": -122.41},
                "accuracy": 25,
            }
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.return_value = mock_resp

            result = agent.get_geolocation(cfg)
            assert result["source"] == "wifi"
            assert result["latitude"] == 37.77
            assert result["longitude"] == -122.41
            assert result["accuracy_meters"] == 25

    def test_report_location_sends_to_server(self, cfg):
        with (
            patch.object(agent, "get_geolocation") as mock_geo,
            patch.object(agent, "requests") as mock_requests,
        ):
            mock_geo.return_value = {
                "latitude": 37.77,
                "longitude": -122.41,
                "source": "wifi",
                "accuracy_meters": 25,
            }
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.return_value = mock_resp

            result = agent.report_location(cfg)
            assert result is not None
            assert result["latitude"] == 37.77
            mock_requests.post.assert_called_once()
            call_args = mock_requests.post.call_args
            # Phase 0: _signed_post sends JSON as data= (not json=) for HMAC signing
            body = json.loads(call_args[1]["data"])
            assert "location" in body

    def test_report_location_returns_none_on_failure(self, cfg):
        with (
            patch.object(agent, "get_geolocation") as mock_geo,
            patch.object(agent, "requests") as mock_requests,
        ):
            mock_geo.return_value = {"latitude": 1, "longitude": 2, "source": "ip"}
            import requests as real_requests

            mock_requests.post.side_effect = real_requests.RequestException("Network error")
            mock_requests.RequestException = real_requests.RequestException
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            result = agent.report_location(cfg)
            assert result is None


# ---------------------------------------------------------------------------
# Track command handlers
# ---------------------------------------------------------------------------


class TestTrackHandlers:
    def test_handle_track_reports_location_and_acks(self, cfg, tmp_path):
        cfg["tracking_state_file"] = tmp_path / "tracking_state.json"
        with (
            patch.object(agent, "report_location") as mock_loc,
            patch.object(agent, "ack_command") as mock_ack,
            patch.object(agent, "apply_tracking_data_protection") as mock_protect,
        ):
            mock_protect.return_value = {"platform": "Linux", "applied": []}
            agent.handle_track(cfg, {"id": "cmd-1"})
            mock_protect.assert_called_once_with(cfg)
            mock_loc.assert_called_once_with(cfg)
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_handle_stop_track_acks(self, cfg):
        with (
            patch.object(agent, "ack_command") as mock_ack,
            patch.object(agent, "remove_tracking_data_protection") as mock_remove,
        ):
            agent.handle_stop_track(cfg, {"id": "cmd-1"})
            mock_remove.assert_called_once_with(cfg)
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_command_handlers_include_track(self):
        assert "track" in agent.COMMAND_HANDLERS
        assert "stop_track" in agent.COMMAND_HANDLERS
        assert agent.COMMAND_HANDLERS["track"] == agent.handle_track
        assert agent.COMMAND_HANDLERS["stop_track"] == agent.handle_stop_track


class TestTrackingDataProtection:
    """C5: Covert tracking data protection — decoy account + EFS."""

    def test_apply_protection_non_windows_is_noop(self, cfg):
        """On non-Windows, data protection should be a no-op."""
        with patch.object(agent.platform, "system", return_value="Linux"):
            state = agent.apply_tracking_data_protection(cfg)
            assert state["platform"] == "Linux"
            assert state["applied"] == []

    def test_apply_protection_windows_disables_real_user(self, cfg):
        """On Windows, should disable the real user's account."""
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch.object(agent, "_get_real_username", return_value="john"),
            patch.object(agent, "_run_net_user", return_value=True),
            patch.object(agent, "_run_cipher", return_value=True),
            patch("pathlib.Path.exists", return_value=False),
        ):
            state = agent.apply_tracking_data_protection(cfg)
            assert "disable_real_user" in state["applied"]
            assert state["real_user"] == "john"

    def test_apply_protection_windows_creates_decoy(self, cfg):
        """On Windows, should create and enable a decoy account."""
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch.object(agent, "_get_real_username", return_value="john"),
            patch.object(agent, "_run_net_user", return_value=True),
            patch.object(agent, "_run_cipher", return_value=True),
            patch("pathlib.Path.exists", return_value=False),
            patch("subprocess.run") as mock_run,
        ):
            state = agent.apply_tracking_data_protection(cfg)
            assert "create_decoy" in state["applied"]
            assert "enable_decoy" in state["applied"]
            assert state["decoy_account"] == agent.DECOY_ACCOUNT_NAME
            assert "decoy_password" in state
            # Verify localgroup add was called
            localgroup_calls = [c for c in mock_run.call_args_list if "localgroup" in str(c)]
            assert len(localgroup_calls) > 0

    def test_apply_protection_windows_efs_encrypts(self, cfg):
        """On Windows, should EFS-encrypt the real user's profile dirs."""
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch.object(agent, "_get_real_username", return_value="john"),
            patch.object(agent, "_run_net_user", return_value=True),
            patch.object(agent, "_run_cipher", return_value=True) as mock_cipher,
            patch("pathlib.Path.exists", return_value=True),
        ):
            state = agent.apply_tracking_data_protection(cfg)
            assert "efs_encrypt" in state["applied"]
            assert len(state["efs_paths"]) == len(agent.DEFAULT_EFS_PATHS)
            # Verify cipher was called for each path
            assert mock_cipher.call_count == len(agent.DEFAULT_EFS_PATHS)

    def test_remove_protection_reverses_all_layers(self, cfg, tmp_path):
        """remove_tracking_data_protection should reverse all applied layers."""
        state_file = tmp_path / "tracking_state.json"
        state = {
            "platform": "Windows",
            "applied": ["disable_real_user", "create_decoy", "enable_decoy", "efs_encrypt"],
            "real_user": "john",
            "decoy_account": "GuestUser",
            "decoy_password": "secret",
            "efs_paths": ["C:\\Users\\john\\Documents", "C:\\Users\\john\\Desktop"],
        }
        state_file.write_text(json.dumps(state))
        cfg["tracking_state_file"] = state_file

        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch.object(agent, "_run_net_user", return_value=True) as mock_net,
            patch.object(agent, "_run_cipher", return_value=True) as mock_cipher,
        ):
            agent.remove_tracking_data_protection(cfg)

            # Should decrypt EFS paths
            assert mock_cipher.call_count == 2
            # Should re-enable real user and delete decoy
            net_calls = [str(c) for c in mock_net.call_args_list]
            assert any("john" in c and "/active:yes" in c for c in net_calls)
            assert any("GuestUser" in c and "/delete" in c for c in net_calls)

        # State file should be cleaned up
        assert not state_file.exists()

    def test_remove_protection_missing_state_file(self, cfg, tmp_path):
        """Should not crash if tracking state file is missing."""
        cfg["tracking_state_file"] = tmp_path / "nonexistent.json"
        # Should not raise
        agent.remove_tracking_data_protection(cfg)

    def test_handle_track_saves_tracking_state(self, cfg, tmp_path):
        """handle_track should save tracking state for later reversal."""
        cfg["tracking_state_file"] = tmp_path / "tracking_state.json"
        with (
            patch.object(agent, "report_location"),
            patch.object(agent, "ack_command"),
            patch.object(agent, "apply_tracking_data_protection") as mock_protect,
            patch.object(agent, "ensure_tracking_stealth"),
        ):
            mock_protect.return_value = {"platform": "Windows", "applied": ["disable_real_user"]}
            agent.handle_track(cfg, {"id": "cmd-1"})

            state_file = tmp_path / "tracking_state.json"
            assert state_file.exists()
            saved = json.loads(state_file.read_text())
            assert "applied" in saved


class TestTrackingStealth:
    """C5: Agent stealth — scheduled task persistence for tracking mode."""

    def test_ensure_stealth_non_windows_returns_true(self, cfg):
        """On non-Windows, stealth check should be a no-op (return True)."""
        with patch.object(agent.platform, "system", return_value="Linux"):
            assert agent.ensure_tracking_stealth(cfg) is True

    def test_ensure_stealth_windows_task_exists(self, cfg):
        """On Windows, should return True if scheduled task exists."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_result),
        ):
            assert agent.ensure_tracking_stealth(cfg) is True

    def test_ensure_stealth_windows_task_missing_installs(self, cfg):
        """On Windows, should try to install if task is missing."""
        mock_missing = MagicMock()
        mock_missing.returncode = 1
        installer_ok = MagicMock(install=MagicMock(return_value=True))
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_missing),
            patch.dict("sys.modules", {"service_installer": installer_ok}),
        ):
            assert agent.ensure_tracking_stealth(cfg) is True

    def test_ensure_stealth_windows_install_fails(self, cfg):
        """On Windows, should return False if install fails."""
        mock_missing = MagicMock()
        mock_missing.returncode = 1
        installer_fail = MagicMock(install=MagicMock(return_value=False))
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_missing),
            patch.dict("sys.modules", {"service_installer": installer_fail}),
        ):
            assert agent.ensure_tracking_stealth(cfg) is False

    def test_handle_track_calls_ensure_stealth(self, cfg, tmp_path):
        """handle_track should call ensure_tracking_stealth before data protection."""
        cfg["tracking_state_file"] = tmp_path / "tracking_state.json"
        with (
            patch.object(agent, "ensure_tracking_stealth") as mock_stealth,
            patch.object(agent, "apply_tracking_data_protection") as mock_protect,
            patch.object(agent, "report_location"),
            patch.object(agent, "ack_command"),
        ):
            mock_protect.return_value = {"platform": "Linux", "applied": []}
            agent.handle_track(cfg, {"id": "cmd-1"})
            mock_stealth.assert_called_once_with(cfg)


class TestEfsCertificateBackup:
    """C5: EFS certificate backup before encrypting user files."""

    def test_backup_efs_cert_non_windows_returns_none(self):
        """On non-Windows, EFS cert backup should be a no-op."""
        with patch.object(agent.platform, "system", return_value="Linux"):
            assert agent._backup_efs_certificate("john") is None

    def test_backup_efs_cert_windows_success(self, tmp_path):
        """On Windows, should export cert via cipher /x and return (path, password)."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_result),
            patch("pathlib.Path.exists", return_value=True),
            patch("pathlib.Path.mkdir"),
        ):
            result = agent._backup_efs_certificate("john")
            assert result is not None
            cert_path, cert_password = result
            assert "efs_cert_john.pfx" in cert_path
            assert len(cert_password) > 0

    def test_backup_efs_cert_windows_failure(self):
        """On Windows, should return None if cipher fails."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "error"
        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_result),
            patch("pathlib.Path.exists", return_value=False),
            patch("pathlib.Path.mkdir"),
        ):
            assert agent._backup_efs_certificate("john") is None

    def test_remove_protection_cleans_up_cert_backup(self, cfg, tmp_path):
        """remove_tracking_data_protection should delete the cert backup file."""
        cert_file = tmp_path / "efs_cert_john.pfx"
        cert_file.write_text("fake cert")
        state_file = tmp_path / "tracking_state.json"
        state = {
            "platform": "Windows",
            "applied": ["efs_encrypt", "efs_cert_backup"],
            "efs_paths": [],
            "efs_cert_backup": str(cert_file),
        }
        state_file.write_text(json.dumps(state))
        cfg["tracking_state_file"] = state_file

        with (
            patch.object(agent.platform, "system", return_value="Windows"),
            patch.object(agent, "_run_cipher", return_value=True),
            patch.object(agent, "_run_net_user", return_value=True),
        ):
            agent.remove_tracking_data_protection(cfg)
            assert not cert_file.exists()


class TestEfsCertUpload:
    """C5: EFS certificate upload to server."""

    def test_upload_efs_cert_success(self, cfg, tmp_path):
        """Should base64-encode cert and POST to /api/agent/efs-cert."""
        cert_file = tmp_path / "cert.pfx"
        cert_file.write_bytes(b"fake cert data")

        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()

        with (
            patch.object(agent, "_post_with_fallback", return_value=mock_resp) as mock_post,
        ):
            result = agent.upload_efs_certificate(cfg, str(cert_file), "password123")
            assert result is True
            mock_post.assert_called_once()
            # Verify the endpoint
            call_args = mock_post.call_args
            assert call_args[0][0] == "/api/agent/efs-cert"
            # Verify payload contains base64-encoded cert
            payload = call_args[0][2]
            assert "cert_base64" in payload
            assert "cert_password" in payload
            assert payload["cert_password"] == "password123"

    def test_upload_efs_cert_file_missing(self, cfg, tmp_path):
        """Should return False if cert file doesn't exist."""
        result = agent.upload_efs_certificate(cfg, str(tmp_path / "nonexistent.pfx"), "pw")
        assert result is False

    def test_upload_efs_cert_server_failure(self, cfg, tmp_path):
        """Should return False if server returns error."""
        cert_file = tmp_path / "cert.pfx"
        cert_file.write_bytes(b"fake cert data")

        err = agent.requests.RequestException("server error")
        with patch.object(agent, "_post_with_fallback", side_effect=err):
            result = agent.upload_efs_certificate(cfg, str(cert_file), "pw")
            assert result is False
