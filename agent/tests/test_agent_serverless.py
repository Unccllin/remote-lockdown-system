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
        with patch.object(agent, "requests") as mock_requests:
            mock_requests.get.side_effect = Exception("Network error")
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
    def test_handle_track_reports_location_and_acks(self, cfg):
        with (
            patch.object(agent, "report_location") as mock_loc,
            patch.object(agent, "ack_command") as mock_ack,
        ):
            agent.handle_track(cfg, {"id": "cmd-1"})
            mock_loc.assert_called_once_with(cfg)
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_handle_stop_track_acks(self, cfg):
        with patch.object(agent, "ack_command") as mock_ack:
            agent.handle_stop_track(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_command_handlers_include_track(self):
        assert "track" in agent.COMMAND_HANDLERS
        assert "stop_track" in agent.COMMAND_HANDLERS
        assert agent.COMMAND_HANDLERS["track"] == agent.handle_track
        assert agent.COMMAND_HANDLERS["stop_track"] == agent.handle_stop_track
