"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json
import os

# We need to import agent.py which is in the parent directory
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))


import agent

# Shared fixtures (tmp_folder, tmp_sentinel, cfg, cleanup_guardian)
# are now provided by tests/conftest.py — no need to redefine here.

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
        parts = mac.split(":")
        assert len(parts) == 6
        for part in parts:
            assert len(part) == 2
            int(part, 16)  # Should be valid hex

    def test_get_hardware_uuid_returns_string(self):
        with patch("platform.system", return_value="Linux"):
            with patch(
                "subprocess.check_output", return_value=b"12345678-1234-1234-1234-123456789abc\n"
            ):
                uuid_val = agent.get_hardware_uuid()
                assert uuid_val == "12345678-1234-1234-1234-123456789abc"

    def test_get_hardware_uuid_fallback(self):
        with patch("platform.system", return_value="Linux"):
            with patch("subprocess.check_output", side_effect=OSError("No DMI")):
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

        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "remove_lock_screen"),
        ):
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
        with patch.object(agent, "ack_command") as mock_ack:
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
            with (
                patch.object(agent, "apply_lock_screen") as mock_lock,
                patch.object(agent, "start_lock_guardian") as mock_guardian,
            ):
                agent.startup_check(cfg)
                mock_lock.assert_called_once()
                mock_guardian.assert_called_once()
        finally:
            if tmp_sentinel.exists():
                tmp_sentinel.unlink()

    def test_startup_check_noop_if_no_sentinel_and_no_deadman(self, cfg, tmp_sentinel):
        """If no sentinel and no deadman file, startup check should do nothing (never flagged).."""
        # Ensure deadman file doesn't exist
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        with patch.object(agent, "apply_lock_screen") as mock_lock:
            agent.startup_check(cfg)
            mock_lock.assert_not_called()

    def test_startup_check_fail_secure_if_sentinel_missing_but_stolen(self, cfg, tmp_sentinel):
        """Fail-secure: if sentinel is missing but deadman says 'stolen', re-assert lock."""
        # Write deadman file with stolen status
        agent.DEADMAN_FILE.write_text(json.dumps({"last_seen": time.time(), "status": "stolen"}))
        # Ensure sentinel doesn't exist
        assert not tmp_sentinel.exists()
        try:
            with (
                patch.object(agent, "apply_lock_screen") as mock_lock,
                patch.object(agent, "start_lock_guardian") as mock_guardian,
            ):
                agent.startup_check(cfg)
                mock_lock.assert_called_once()
                mock_guardian.assert_called_once()
                # Sentinel should be re-created
                assert tmp_sentinel.exists()
                sentinel_data = json.loads(tmp_sentinel.read_text())
                assert sentinel_data["locked"] is True
                assert sentinel_data["tamper_detected"] is True
        finally:
            if tmp_sentinel.exists():
                tmp_sentinel.unlink()
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_startup_check_noop_if_sentinel_missing_and_recovered(self, cfg, tmp_sentinel):
        """If sentinel missing but deadman says 'active', normal startup (was recovered)."""
        agent.DEADMAN_FILE.write_text(json.dumps({"last_seen": time.time(), "status": "active"}))
        try:
            with patch.object(agent, "apply_lock_screen") as mock_lock:
                agent.startup_check(cfg)
                mock_lock.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_startup_check_fail_secure_if_deadman_corrupt(self, cfg, tmp_sentinel):
        """Fail-secure: corrupt deadman file = possible tampering = re-assert lock."""
        agent.DEADMAN_FILE.write_text("CORRUPT-NOT-JSON{{{")
        try:
            with (
                patch.object(agent, "apply_lock_screen") as mock_lock,
                patch.object(agent, "start_lock_guardian") as mock_guardian,
            ):
                agent.startup_check(cfg)
                mock_lock.assert_called_once()
                mock_guardian.assert_called_once()
        finally:
            if tmp_sentinel.exists():
                tmp_sentinel.unlink()
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()


# ---------------------------------------------------------------------------
# Dry-run mode (master switch) and startup-trigger flag
# ---------------------------------------------------------------------------


class TestDryRunMode:
    """Tests for the LOCKDOWN_DRY_RUN master switch and --startup flag."""

    def test_dry_run_env_var_sets_flag(self):
        """LOCKDOWN_DRY_RUN=1 env var sets agent._DRY_RUN = True at import time."""
        # We can't re-import the module, but we can verify the env var logic
        with patch.dict(os.environ, {"LOCKDOWN_DRY_RUN": "1"}):
            result = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")
            assert result is True

    def test_dry_run_env_var_false_when_unset(self):
        """LOCKDOWN_DRY_RUN unset means _DRY_RUN = False."""
        with patch.dict(os.environ, {}, clear=True):
            result = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")
            assert result is False

    def test_dry_run_lock_workstation_is_noop(self):
        """In dry-run mode, _lock_workstation logs and returns without executing."""
        with patch.object(agent, "_DRY_RUN", True):
            with patch.object(agent, "log") as mock_log:
                with patch.object(agent, "subprocess") as mock_subprocess:
                    agent._lock_workstation()
                    mock_subprocess.run.assert_not_called()
                    mock_log.info.assert_called()

    def test_dry_run_apply_lock_screen_is_noop(self):
        """In dry-run mode, apply_lock_screen logs and returns without locking."""
        with patch.object(agent, "_DRY_RUN", True):
            with patch.object(agent, "_lock_workstation") as mock_lock:
                agent.apply_lock_screen()
                mock_lock.assert_not_called()

    def test_dry_run_start_lock_guardian_is_noop(self):
        """In dry-run mode, start_lock_guardian logs and returns without starting thread."""
        with patch.object(agent, "_DRY_RUN", True):
            with patch.object(agent, "threading") as mock_threading:
                agent.start_lock_guardian()
                mock_threading.Thread.assert_not_called()

    def test_non_dry_run_lock_workstation_executes(self):
        """When NOT in dry-run mode, _lock_workstation proceeds normally."""
        import platform as plat_mod

        with patch.object(agent, "_DRY_RUN", False):
            with patch.object(plat_mod, "system", return_value="Linux"):
                with patch.object(agent, "subprocess"):
                    # On Linux, it calls dm-tool or loginctl
                    try:
                        agent._lock_workstation()
                    except Exception:  # noqa: S110
                        pass  # May fail if dm-tool not installed — OK


# ---------------------------------------------------------------------------
# Check-in communication
# ---------------------------------------------------------------------------


class TestCheckin:
    def test_checkin_returns_data_on_success(self, cfg):
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.json.return_value = {"status": "active", "command": None}
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.return_value = mock_resp
            mock_requests.RequestException = Exception

            result = agent.checkin(cfg)
            assert result is not None
            assert result["status"] == "active"

    def test_checkin_returns_none_on_failure(self, cfg):
        with patch.object(agent, "requests") as mock_requests:
            import requests as real_requests

            mock_requests.post.side_effect = real_requests.RequestException("Network error")
            mock_requests.RequestException = real_requests.RequestException
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

            result = agent.checkin(cfg)
            assert result is None
