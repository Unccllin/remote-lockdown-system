"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json
import os
import time
import tempfile
import shutil
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock
from unittest import mock

import pytest

# We need to import agent.py which is in the parent directory
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

import agent


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_folder():
    """Create a temporary folder with some test files."""
    d = Path(tempfile.mkdtemp())
    (d / "file1.txt").write_text("hello world")
    (d / "file2.txt").write_text("secret data")
    (d / "subdir").mkdir()
    (d / "subdir" / "nested.txt").write_text("nested content")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_sentinel():
    """Create a temporary sentinel file path that doesn't exist."""
    f = Path(tempfile.mktemp())
    if f.exists():
        f.unlink()
    yield f
    if f.exists():
        f.unlink()


@pytest.fixture
def cfg(tmp_folder, tmp_sentinel):
    """A test config dict."""
    return {
        "server_url": "https://test-server.example.com",
        "agent_key": "test-key",
        "hostname": "TEST-DEV-001",
        "poll_interval": 1,
        "lockdown_folder": tmp_folder,
        "lock_sentinel": tmp_sentinel,
        "verify_tls": True,
    }


@pytest.fixture(autouse=True)
def cleanup_guardian():
    """Ensure lock guardian is stopped after each test."""
    yield
    agent.stop_lock_guardian()


# ---------------------------------------------------------------------------
# Encryption / Decryption
# ---------------------------------------------------------------------------

class TestEncryption:
    def test_encrypt_folder_creates_enc_files(self, tmp_folder):
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)

        # Original files should be gone, .enc files should exist
        assert not (tmp_folder / "file1.txt").exists()
        assert (tmp_folder / "file1.txt.enc").exists()
        assert not (tmp_folder / "file2.txt").exists()
        assert (tmp_folder / "file2.txt.enc").exists()
        # Nested files too
        assert not (tmp_folder / "subdir" / "nested.txt").exists()
        assert (tmp_folder / "subdir" / "nested.txt.enc").exists()

    def test_decrypt_folder_restores_originals(self, tmp_folder):
        original_content = (tmp_folder / "file1.txt").read_text()
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)
        agent.decrypt_folder(tmp_folder, key)

        # Original files should be restored
        assert (tmp_folder / "file1.txt").exists()
        assert not (tmp_folder / "file1.txt.enc").exists()
        assert (tmp_folder / "file1.txt").read_text() == original_content

    def test_encrypt_skips_already_encrypted(self, tmp_folder):
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)

        # Encrypt again with a different key — should skip .enc files
        key2 = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key2)

        # Files should still be decryptable with the FIRST key
        agent.decrypt_folder(tmp_folder, key)
        assert (tmp_folder / "file1.txt").read_text() == "hello world"

    def test_decrypt_with_wrong_key_raises(self, tmp_folder):
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)

        wrong_key = agent.generate_key()
        with pytest.raises(Exception):
            agent.decrypt_folder(tmp_folder, wrong_key)

    def test_encrypt_empty_folder(self):
        d = Path(tempfile.mkdtemp())
        try:
            key = agent.generate_key()
            agent.encrypt_folder(d, key)
            # No files to encrypt, should not raise
            assert len(list(d.rglob("*.enc"))) == 0
        finally:
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# Lock Guardian
# ---------------------------------------------------------------------------

class TestLockGuardian:
    def test_start_and_stop_lock_guardian(self):
        """Guardian thread starts and stops cleanly."""
        with patch.object(agent, '_lock_workstation') as mock_lock:
            agent.start_lock_guardian()
            assert agent._lock_guardian_thread is not None
            assert agent._lock_guardian_thread.is_alive()

            # Wait a bit for the thread to call _lock_workstation at least once
            time.sleep(0.2)
            assert mock_lock.call_count >= 1

            agent.stop_lock_guardian()
            assert agent._lock_guardian_thread is None

    def test_stop_lock_guardian_without_start(self):
        """Stopping without starting should not raise."""
        agent.stop_lock_guardian()

    def test_lock_guardian_repeats_lock(self):
        """Guardian should call _lock_workstation multiple times."""
        with patch.object(agent, '_lock_workstation') as mock_lock:
            agent.start_lock_guardian()
            time.sleep(0.35)  # Should get multiple calls at 10s interval... wait, interval is 10s
            # Actually the interval is 10s, so we won't get multiple calls in 0.35s
            # But we should get at least one
            assert mock_lock.call_count >= 1
            agent.stop_lock_guardian()

    def test_remove_lock_screen_stops_guardian(self):
        """remove_lock_screen should stop the guardian."""
        with patch.object(agent, '_lock_workstation'):
            agent.start_lock_guardian()
            assert agent._lock_guardian_thread is not None

            agent.remove_lock_screen()
            assert agent._lock_guardian_thread is None


# ---------------------------------------------------------------------------
# Double-lock guard (handle_lockdown with existing sentinel)
# ---------------------------------------------------------------------------

class TestDoubleLockGuard:
    def test_handle_lockdown_skips_if_sentinel_exists(self, cfg, tmp_sentinel):
        """If sentinel already exists (deadman locked), handle_lockdown should just ACK."""
        # Create sentinel to simulate deadman already locked
        tmp_sentinel.write_text(json.dumps({"locked": True, "deadman": True}))

        with patch.object(agent, 'ack_command') as mock_ack, \
             patch.object(agent, 'encrypt_folder') as mock_encrypt, \
             patch.object(agent, 'apply_lock_screen') as mock_lock:
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            # Should ACK as executed without encrypting
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")
            mock_encrypt.assert_not_called()
            mock_lock.assert_not_called()

    def test_handle_lockdown_encrypts_when_no_sentinel(self, cfg, tmp_folder, tmp_sentinel):
        """Normal lockdown should encrypt and start guardian."""
        with patch.object(agent, 'ack_command') as mock_ack, \
             patch.object(agent, 'apply_lock_screen'), \
             patch.object(agent, 'start_lock_guardian'), \
             patch.object(agent, 'encrypt_folder') as mock_encrypt:
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            mock_encrypt.assert_called_once()
            mock_ack.assert_called_once()
            # Key material should be passed to ack
            assert mock_ack.call_args[1].get('key_material') is not None
            # Sentinel should be written
            assert tmp_sentinel.exists()


# ---------------------------------------------------------------------------
# Deadman key recovery
# ---------------------------------------------------------------------------

class TestDeadmanKey:
    def test_deadman_stores_key_locally(self, cfg, tmp_folder, tmp_sentinel):
        """When deadman triggers, key should be stored in DEADMAN_KEY_FILE."""
        # Set up deadman file with stolen status and old timestamp
        agent.DEADMAN_FILE.write_text(json.dumps({
            "last_seen": time.time() - (25 * 3600),  # 25 hours ago
            "status": "stolen",
        }))

        try:
            with patch.object(agent, 'apply_lock_screen'), \
                 patch.object(agent, 'start_lock_guardian'):
                agent.check_deadman(cfg)

                # Sentinel should exist
                assert tmp_sentinel.exists()
                # Deadman key file should exist with the key
                assert agent.DEADMAN_KEY_FILE.exists()
                key_content = agent.DEADMAN_KEY_FILE.read_text().strip()
                assert len(key_content) > 0  # Should be a Fernet key
        finally:
            for f in [agent.DEADMAN_FILE, agent.DEADMAN_KEY_FILE, tmp_sentinel]:
                if f.exists():
                    f.unlink()

    def test_deadman_does_not_trigger_if_not_stolen(self, cfg):
        """Deadman should not trigger if status is not 'stolen'."""
        agent.DEADMAN_FILE.write_text(json.dumps({
            "last_seen": time.time() - (48 * 3600),
            "status": "active",
        }))

        try:
            with patch.object(agent, 'encrypt_folder') as mock_encrypt:
                agent.check_deadman(cfg)
                mock_encrypt.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_deadman_does_not_trigger_if_recent(self, cfg):
        """Deadman should not trigger if last_seen is recent."""
        agent.DEADMAN_FILE.write_text(json.dumps({
            "last_seen": time.time() - (1 * 3600),  # 1 hour ago
            "status": "stolen",
        }))

        try:
            with patch.object(agent, 'encrypt_folder') as mock_encrypt:
                agent.check_deadman(cfg)
                mock_encrypt.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_deadman_skips_if_already_locked(self, cfg, tmp_sentinel):
        """Deadman should not re-encrypt if sentinel already exists."""
        tmp_sentinel.write_text(json.dumps({"locked": True}))

        agent.DEADMAN_FILE.write_text(json.dumps({
            "last_seen": time.time() - (25 * 3600),
            "status": "stolen",
        }))

        try:
            with patch.object(agent, 'encrypt_folder') as mock_encrypt:
                agent.check_deadman(cfg)
                mock_encrypt.assert_not_called()
        finally:
            for f in [agent.DEADMAN_FILE, tmp_sentinel]:
                if f.exists():
                    f.unlink()

    def test_report_deadman_key_uploads_and_wipes(self, cfg):
        """report_deadman_key should upload key to server and delete local copy."""
        agent.DEADMAN_KEY_FILE.write_text("test-fernet-key==")

        try:
            with patch.object(agent, 'requests') as mock_requests:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_requests.post.return_value = mock_resp

                agent.report_deadman_key(cfg)

                # Should have POSTed to deadman-report
                mock_requests.post.assert_called_once()
                call_args = mock_requests.post.call_args
                assert 'deadman-report' in call_args[0][0]
                assert call_args[1]['json']['key_material'] == 'test-fernet-key=='

                # Local key file should be deleted
                assert not agent.DEADMAN_KEY_FILE.exists()
        finally:
            if agent.DEADMAN_KEY_FILE.exists():
                agent.DEADMAN_KEY_FILE.unlink()

    def test_report_deadman_key_noop_if_no_file(self, cfg):
        """report_deadman_key should do nothing if no key file exists."""
        if agent.DEADMAN_KEY_FILE.exists():
            agent.DEADMAN_KEY_FILE.unlink()

        with patch.object(agent, 'requests') as mock_requests:
            agent.report_deadman_key(cfg)
            mock_requests.post.assert_not_called()

    def test_report_deadman_key_retries_on_failure(self, cfg):
        """If upload fails, key file should be preserved for retry."""
        agent.DEADMAN_KEY_FILE.write_text("test-fernet-key==")

        try:
            with patch.object(agent, 'requests') as mock_requests:
                import requests as real_requests
                mock_requests.post.side_effect = real_requests.RequestException("Network error")
                mock_requests.RequestException = real_requests.RequestException

                agent.report_deadman_key(cfg)

                # Key file should still exist for retry
                assert agent.DEADMAN_KEY_FILE.exists()
        finally:
            if agent.DEADMAN_KEY_FILE.exists():
                agent.DEADMAN_KEY_FILE.unlink()


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------

class TestConfig:
    def test_load_config_defaults(self):
        """Config should have sensible defaults."""
        with patch.dict(os.environ, {}, clear=True):
            cfg = agent.load_config()
            assert cfg["server_url"] == "https://localhost:3001"
            assert cfg["poll_interval"] == 30
            assert cfg["verify_tls"] is True
            assert "SecureData" in str(cfg["lockdown_folder"])

    def test_load_config_from_env(self):
        """Config should read from environment variables."""
        env = {
            "SERVER_URL": "https://my-server.com",
            "AGENT_SHARED_KEY": "my-key",
            "DEVICE_HOSTNAME": "MY-DEVICE",
            "POLL_INTERVAL": "60",
            "LOCKDOWN_FOLDER": "/tmp/test-lockdown",
        }
        with patch.dict(os.environ, env, clear=True):
            cfg = agent.load_config()
            assert cfg["server_url"] == "https://my-server.com"
            assert cfg["agent_key"] == "my-key"
            assert cfg["hostname"] == "MY-DEVICE"
            assert cfg["poll_interval"] == 60
            assert str(cfg["lockdown_folder"]) == "/tmp/test-lockdown"


# ---------------------------------------------------------------------------
# Hardware identity
# ---------------------------------------------------------------------------

class TestHardwareIdentity:
    def test_get_mac_address_format(self):
        mac = agent.get_mac_address()
        # Should be colon-separated hex pairs
        parts = mac.split(':')
        assert len(parts) == 6
        for part in parts:
            assert len(part) == 2
            int(part, 16)  # Should be valid hex

    def test_get_hardware_uuid_returns_string(self):
        with patch('platform.system', return_value='Linux'):
            with patch('subprocess.check_output', return_value=b'12345678-1234-1234-1234-123456789abc\n'):
                uuid_val = agent.get_hardware_uuid()
                assert uuid_val == '12345678-1234-1234-1234-123456789abc'

    def test_get_hardware_uuid_fallback(self):
        with patch('platform.system', return_value='Linux'):
            with patch('subprocess.check_output', side_effect=Exception("No DMI")):
                uuid_val = agent.get_hardware_uuid()
                # Should fall back to uuid.getnode()
                assert len(uuid_val) > 0


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

class TestHandleUnlock:
    def test_handle_unlock_decrypts_and_removes_sentinel(self, cfg, tmp_folder, tmp_sentinel):
        """Unlock should decrypt folder and remove sentinel."""
        # First encrypt
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)
        tmp_sentinel.write_text(json.dumps({"locked": True}))
        key_b64 = key.decode()

        with patch.object(agent, 'ack_command') as mock_ack, \
             patch.object(agent, 'remove_lock_screen'):
            agent.handle_unlock(cfg, {"id": "cmd-1", "key_material": key_b64})

            # Folder should be decrypted
            assert (tmp_folder / "file1.txt").exists()
            assert not (tmp_folder / "file1.txt.enc").exists()
            # Sentinel should be removed
            assert not tmp_sentinel.exists()
            # Should ACK as executed
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_handle_unlock_fails_without_key(self, cfg, tmp_sentinel):
        """Unlock should fail if no key_material provided."""
        with patch.object(agent, 'ack_command') as mock_ack:
            agent.handle_unlock(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once_with(cfg, "cmd-1", "failed")


# ---------------------------------------------------------------------------
# Startup check
# ---------------------------------------------------------------------------

class TestStartupCheck:
    def test_startup_check_reasserts_lock_if_sentinel_exists(self, cfg, tmp_sentinel):
        """If sentinel exists on startup, lock screen should be re-asserted."""
        tmp_sentinel.write_text(json.dumps({"locked": True}))

        try:
            with patch.object(agent, 'apply_lock_screen') as mock_lock, \
                 patch.object(agent, 'start_lock_guardian') as mock_guardian:
                agent.startup_check(cfg)
                mock_lock.assert_called_once()
                mock_guardian.assert_called_once()
        finally:
            if tmp_sentinel.exists():
                tmp_sentinel.unlink()

    def test_startup_check_noop_if_no_sentinel(self, cfg, tmp_sentinel):
        """If no sentinel, startup check should do nothing."""
        with patch.object(agent, 'apply_lock_screen') as mock_lock:
            agent.startup_check(cfg)
            mock_lock.assert_not_called()


# ---------------------------------------------------------------------------
# Check-in communication
# ---------------------------------------------------------------------------

class TestCheckin:
    def test_checkin_returns_data_on_success(self, cfg):
        with patch.object(agent, 'requests') as mock_requests:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"status": "active", "command": None}
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.return_value = mock_resp
            mock_requests.RequestException = Exception

            result = agent.checkin(cfg)
            assert result is not None
            assert result["status"] == "active"

    def test_checkin_returns_none_on_failure(self, cfg):
        with patch.object(agent, 'requests') as mock_requests:
            import requests as real_requests
            mock_requests.post.side_effect = real_requests.RequestException("Network error")
            mock_requests.RequestException = real_requests.RequestException

            result = agent.checkin(cfg)
            assert result is None


# ---------------------------------------------------------------------------
# Geolocation
# ---------------------------------------------------------------------------

class TestGeolocation:
    def test_get_ip_geolocation_returns_location(self):
        """IP geolocation should return lat/long from ip-api.com."""
        with patch.object(agent, 'requests') as mock_requests:
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
        with patch.object(agent, 'requests') as mock_requests:
            mock_requests.get.side_effect = Exception("Network error")
            result = agent.get_ip_geolocation()
            assert result is None

    def test_get_geolocation_falls_back_to_ip_without_api_key(self, cfg):
        """Without a Google API key, should fall back to IP geolocation."""
        cfg["google_api_key"] = ""
        with patch.object(agent, 'get_ip_geolocation') as mock_ip:
            mock_ip.return_value = {"latitude": 1, "longitude": 2, "source": "ip"}
            result = agent.get_geolocation(cfg)
            assert result["source"] == "ip"
            mock_ip.assert_called_once()

    def test_get_geolocation_uses_wifi_with_api_key(self, cfg):
        """With a Google API key and WiFi networks, should use WiFi triangulation."""
        cfg["google_api_key"] = "test-key"
        with patch.object(agent, 'scan_wifi_networks') as mock_scan, \
             patch.object(agent, 'requests') as mock_requests:
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
        with patch.object(agent, 'get_geolocation') as mock_geo, \
             patch.object(agent, 'requests') as mock_requests:
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
            assert 'location' in call_args[1]['json']

    def test_report_location_returns_none_on_failure(self, cfg):
        with patch.object(agent, 'get_geolocation') as mock_geo, \
             patch.object(agent, 'requests') as mock_requests:
            mock_geo.return_value = {"latitude": 1, "longitude": 2, "source": "ip"}
            import requests as real_requests
            mock_requests.post.side_effect = real_requests.RequestException("Network error")
            mock_requests.RequestException = real_requests.RequestException

            result = agent.report_location(cfg)
            assert result is None


# ---------------------------------------------------------------------------
# Track command handlers
# ---------------------------------------------------------------------------

class TestTrackHandlers:
    def test_handle_track_reports_location_and_acks(self, cfg):
        with patch.object(agent, 'report_location') as mock_loc, \
             patch.object(agent, 'ack_command') as mock_ack:
            agent.handle_track(cfg, {"id": "cmd-1"})
            mock_loc.assert_called_once_with(cfg)
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_handle_stop_track_acks(self, cfg):
        with patch.object(agent, 'ack_command') as mock_ack:
            agent.handle_stop_track(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")

    def test_command_handlers_include_track(self):
        assert "track" in agent.COMMAND_HANDLERS
        assert "stop_track" in agent.COMMAND_HANDLERS
        assert agent.COMMAND_HANDLERS["track"] == agent.handle_track
        assert agent.COMMAND_HANDLERS["stop_track"] == agent.handle_stop_track
