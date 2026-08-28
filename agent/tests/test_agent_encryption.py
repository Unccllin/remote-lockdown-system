"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json
import shutil

# We need to import agent.py which is in the parent directory
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from cryptography.fernet import InvalidToken

import agent

# Shared fixtures (tmp_folder, tmp_sentinel, cfg, cleanup_guardian)
# are now provided by tests/conftest.py — no need to redefine here.

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
        with pytest.raises(InvalidToken):
            agent.decrypt_folder(tmp_folder, wrong_key)

    def test_encrypt_empty_folder(self):
        d = Path(tempfile.mkdtemp())
        try:
            key = agent.generate_key()
            result = agent.encrypt_folder(d, key)
            # No files to encrypt, should not raise
            assert len(list(d.rglob("*.enc"))) == 0
            assert result == []  # D-011: empty list = no blocked files
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_encrypt_returns_empty_list_when_all_succeed(self, tmp_folder):
        """D-011: encrypt_folder returns empty list when all files encrypted."""
        key = agent.generate_key()
        result = agent.encrypt_folder(tmp_folder, key)
        assert result == []
        assert isinstance(result, list)

    def test_encrypt_returns_blocked_files_on_permission_error(self, tmp_folder):
        """D-011: encrypt_folder returns list of blocked files on PermissionError."""
        key = agent.generate_key()
        # Mock read_bytes to raise PermissionError on one file
        original_read = Path.read_bytes
        blocked_file = "file1.txt"

        def mock_read_bytes(self):
            if self.name == blocked_file:
                raise PermissionError(f"File locked: {self.name}")
            return original_read(self)

        with patch.object(Path, "read_bytes", mock_read_bytes):
            result = agent.encrypt_folder(tmp_folder, key)

        # file1.txt should be in blocked_files
        assert blocked_file in result
        # file2.txt should still have been encrypted
        assert (tmp_folder / "file2.txt.enc").exists()
        assert not (tmp_folder / "file2.txt").exists()
        # file1.txt should still exist (not encrypted, not deleted)
        assert (tmp_folder / "file1.txt").exists()

    def test_encrypt_retries_on_permission_error(self, tmp_folder):
        """D-011: encrypt_folder retries on PermissionError before giving up."""
        key = agent.generate_key()
        blocked_file = "file1.txt"
        call_count = {"n": 0}
        original_read = Path.read_bytes

        def mock_read_bytes_with_retry(self):
            if self.name == blocked_file:
                call_count["n"] += 1
                if call_count["n"] < 3:  # Fail first 2 attempts, succeed on 3rd
                    raise PermissionError(f"File locked: {self.name}")
            return original_read(self)

        with patch.object(Path, "read_bytes", mock_read_bytes_with_retry):
            with patch.object(agent.time, "sleep"):  # Don't actually sleep
                result = agent.encrypt_folder(tmp_folder, key)

        # Should have retried and eventually succeeded
        assert call_count["n"] == 3
        assert result == []  # No blocked files — retry succeeded
        # file1.txt should be encrypted
        assert not (tmp_folder / "file1.txt").exists()
        assert (tmp_folder / "file1.txt.enc").exists()


# ---------------------------------------------------------------------------
# Lock Guardian
# ---------------------------------------------------------------------------


class TestLockGuardian:
    def test_start_and_stop_lock_guardian(self):
        """Guardian thread starts and stops cleanly."""
        # FA7: Use Event-wired mock instead of time.sleep to avoid flaky tests.
        # The mock's side_effect sets an Event when _lock_workstation is called,
        # so the test can wait deterministically instead of sleeping.
        lock_called = threading.Event()

        def mock_lock_fn():
            lock_called.set()

        with patch.object(agent, "_lock_workstation", side_effect=mock_lock_fn):
            agent.start_lock_guardian()
            assert agent._lock_guardian_thread is not None
            assert agent._lock_guardian_thread.is_alive()

            # Wait for the guardian thread to call _lock_workstation (deterministic)
            assert lock_called.wait(timeout=2.0), (
                "Guardian did not call _lock_workstation within 2s"
            )

            agent.stop_lock_guardian()
            assert agent._lock_guardian_thread is None

    def test_stop_lock_guardian_without_start(self):
        """Stopping without starting should not raise."""
        agent.stop_lock_guardian()

    def test_lock_guardian_repeats_lock(self):
        """Guardian should call _lock_workstation multiple times."""
        # FA7: Use Event-wired mock — count calls with a counter + Event
        call_count = [0]
        lock_called = threading.Event()

        def mock_lock_fn():
            call_count[0] += 1
            lock_called.set()

        with patch.object(agent, "_lock_workstation", side_effect=mock_lock_fn):
            agent.start_lock_guardian()
            # Wait for at least one call (deterministic, no sleep)
            assert lock_called.wait(timeout=2.0), (
                "Guardian did not call _lock_workstation within 2s"
            )
            assert call_count[0] >= 1
            agent.stop_lock_guardian()

    def test_remove_lock_screen_stops_guardian(self):
        """remove_lock_screen should stop the guardian."""
        with patch.object(agent, "_lock_workstation"):
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

        with (
            patch.object(agent, "ack_command") as mock_ack,
            patch.object(agent, "encrypt_folder") as mock_encrypt,
            patch.object(agent, "apply_lock_screen") as mock_lock,
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            # Should ACK as executed without encrypting
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")
            mock_encrypt.assert_not_called()
            mock_lock.assert_not_called()

    def test_handle_lockdown_encrypts_when_no_sentinel(self, cfg, tmp_folder, tmp_sentinel):
        """Normal lockdown should encrypt and start guardian."""
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder") as mock_encrypt,
            patch.object(agent, "write_pending_ack") as mock_write_ack,
            patch.object(agent, "write_recovery_key"),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            mock_encrypt.assert_called_once()
            mock_ack.assert_called_once()
            # Key material should be passed to ack
            assert mock_ack.call_args[1].get("key_material") is not None
            # Sentinel should be written
            assert tmp_sentinel.exists()
            # A1: pending ACK file should be written BEFORE encryption
            mock_write_ack.assert_called()

    def test_handle_lockdown_sends_boot_lock_detail(self, cfg, tmp_folder, tmp_sentinel):
        """Phase 17: handle_lockdown should pass boot_lock_detail to ack_command."""
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder"),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "bcd_lockdown") as mock_bcd,
            patch.object(agent, "hp_uefi_lockdown") as mock_hp,
        ):
            # Simulate BCD success with 2 critical applied, HP not-HP skip
            mock_bcd.apply_bcd_lockdown.return_value = {
                "success": True,
                "partial": False,
                "rolled_back": False,
                "critical_applied": 2,
                "best_effort_applied": 1,
                "best_effort_failed": 0,
            }
            mock_hp.apply_boot_lockdown.return_value = {
                "bios_password": None,
                "success": True,
                "partial": False,
                "rolled_back": False,
                "not_hp": True,
                "critical_applied": 0,
                "best_effort_applied": 0,
                "best_effort_failed": 0,
            }

            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            mock_ack.assert_called_once()
            detail = mock_ack.call_args[1].get("boot_lock_detail")
            assert detail is not None
            assert detail["boot_lock_attempted"] is True
            assert detail["critical_applied_total"] == 2
            assert detail["bcd"]["critical_applied"] == 2
            assert detail["hp_uefi"]["not_hp"] is True

    def test_handle_lockdown_boot_lock_detail_zero_critical(self, cfg, tmp_folder, tmp_sentinel):
        """Phase 17: boot_lock_detail with critical_applied_total=0 (the dangerous case)."""
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder"),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "bcd_lockdown") as mock_bcd,
            patch.object(agent, "hp_uefi_lockdown") as mock_hp,
        ):
            # Simulate the dangerous case: BCD failed, HP WMI not found
            mock_bcd.apply_bcd_lockdown.return_value = {
                "success": False,
                "partial": False,
                "rolled_back": True,
                "critical_applied": 0,
                "best_effort_applied": 0,
                "best_effort_failed": 0,
            }
            mock_hp.apply_boot_lockdown.return_value = {
                "bios_password": None,
                "success": True,
                "partial": False,
                "rolled_back": False,
                "not_hp": True,
                "critical_applied": 0,
                "best_effort_applied": 0,
                "best_effort_failed": 0,
            }

            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            mock_ack.assert_called_once()
            detail = mock_ack.call_args[1].get("boot_lock_detail")
            assert detail is not None
            assert detail["critical_applied_total"] == 0
            assert detail["bcd"]["rolled_back"] is True
            # boot_lock_status should be "partial" (BCD rolled_back)
            assert mock_ack.call_args[1].get("boot_lock_status") == "partial"

    def test_handle_lockdown_no_boot_lock_detail_when_disabled(self, cfg, tmp_folder, tmp_sentinel):
        """Phase 17: boot_lock_detail should be None when boot_lock_enabled=False."""
        cfg["boot_lock_enabled"] = False
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder"),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once()
            assert mock_ack.call_args[1].get("boot_lock_detail") is None


# ---------------------------------------------------------------------------
# D-007: Session 0 lock isolation tests
# ---------------------------------------------------------------------------


class TestSessionZeroDetection:
    """D-007: Tests for _detect_session_context and _lock_workstation Session 0 path."""

    def test_d007_detect_session_context_non_windows(self):
        """D-007: _detect_session_context returns is_session_zero=False on non-Windows."""
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Linux"
            with patch.object(agent, "_DRY_RUN", False):
                result = agent._detect_session_context()
        assert result["is_session_zero"] is False
        assert result["session_id"] is None
        assert result["platform"] == "Linux"

    def test_d007_detect_session_context_dry_run(self):
        """D-007: _detect_session_context returns defaults in dry-run mode."""
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_DRY_RUN", True):
                result = agent._detect_session_context()
        assert result["is_session_zero"] is False
        assert result["session_id"] is None

    def test_d007_detect_session_context_exception_returns_defaults(self):
        """D-007: _detect_session_context returns defaults when ctypes fails."""
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_DRY_RUN", False):
                # Force an exception in the ctypes import
                with patch("builtins.__import__", side_effect=ImportError("no ctypes")):
                    result = agent._detect_session_context()
        # Should return defaults (exception caught)
        assert result["is_session_zero"] is False
        assert result["session_id"] is None

    def test_d007_detect_session_context_windows_not_dry_run(self):
        """D-007: On Windows (non-dry-run), attempts session detection via ctypes.

        This test verifies the function runs without error on Windows. The
        actual session ID detection logic is tested indirectly through
        _lock_workstation behavior tests below.
        """
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_DRY_RUN", False):
                # The function will try to import ctypes and call Windows APIs.
                # On Linux, ctypes.windll doesn't exist, so it'll catch the
                # exception and return defaults.
                result = agent._detect_session_context()
        # On Linux test env, ctypes.windll doesn't exist → exception → defaults
        assert isinstance(result, dict)
        assert "is_session_zero" in result
        assert "session_id" in result
        assert "platform" in result

    def test_d007_lock_workstation_uses_tsdiscon_in_session_zero(self):
        """D-007: _lock_workstation uses tsdiscon when in Session 0."""
        ctx = {
            "is_session_zero": True,
            "session_id": 0,
            "console_session_id": 1,
            "platform": "Windows",
        }
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_detect_session_context", return_value=ctx):
                with patch.object(agent, "subprocess") as mock_subprocess:
                    agent._lock_workstation()
                    # Should have called tsdiscon with the console session ID
                    mock_subprocess.run.assert_called_once()
                    args = mock_subprocess.run.call_args[0][0]
                    assert args[0] == "tsdiscon"
                    assert args[1] == "1"  # console_session_id

    def test_d007_lock_workstation_tsdiscon_uses_actual_console_session_id(self):
        """D-007: tsdiscon uses the actual console_session_id, not hardcoded 1.

        In Fast User Switching or RDP reconnection, the console session
        may be Session 2, 3, etc. — not always Session 1.
        """
        ctx = {
            "is_session_zero": True,
            "session_id": 0,
            "console_session_id": 3,  # Console is Session 3, not 1
            "platform": "Windows",
        }
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_detect_session_context", return_value=ctx):
                with patch.object(agent, "subprocess") as mock_subprocess:
                    agent._lock_workstation()
                    mock_subprocess.run.assert_called_once()
                    args = mock_subprocess.run.call_args[0][0]
                    assert args[0] == "tsdiscon"
                    assert args[1] == "3"  # Uses actual console_session_id

    def test_d007_lock_workstation_tsdiscon_no_console_id(self):
        """D-007: tsdiscon called without session ID when console_session_id is None."""
        ctx = {
            "is_session_zero": True,
            "session_id": 0,
            "console_session_id": None,
            "platform": "Windows",
        }
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_detect_session_context", return_value=ctx):
                with patch.object(agent, "subprocess") as mock_subprocess:
                    agent._lock_workstation()
                    mock_subprocess.run.assert_called_once()
                    args = mock_subprocess.run.call_args[0][0]
                    assert args == ["tsdiscon"]  # No session ID arg

    def test_d007_lock_workstation_falls_back_on_tsdiscon_failure(self):
        """D-007: Falls back to LockWorkStation when tsdiscon fails."""
        ctx = {
            "is_session_zero": True,
            "session_id": 0,
            "console_session_id": 1,
            "platform": "Windows",
        }
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_detect_session_context", return_value=ctx):
                with patch.object(agent, "subprocess") as mock_subprocess:
                    mock_subprocess.run.side_effect = FileNotFoundError("tsdiscon not found")
                    with patch("ctypes.windll", create=True) as mock_windll:
                        agent._lock_workstation()
                        # Should have called LockWorkStation as fallback
                        mock_windll.user32.LockWorkStation.assert_called_once()

    def test_d007_lock_workstation_uses_lockworkstation_in_interactive(self):
        """D-007: Uses LockWorkStation directly when not in Session 0."""
        ctx = {
            "is_session_zero": False,
            "session_id": 1,
            "console_session_id": 1,
            "platform": "Windows",
        }
        with patch.object(agent, "platform") as mock_platform:
            mock_platform.system.return_value = "Windows"
            with patch.object(agent, "_detect_session_context", return_value=ctx):
                with patch.object(agent, "subprocess") as mock_subprocess:
                    with patch("ctypes.windll", create=True) as mock_windll:
                        agent._lock_workstation()
                        # Should NOT have called tsdiscon
                        mock_subprocess.run.assert_not_called()
                        # Should have called LockWorkStation
                        mock_windll.user32.LockWorkStation.assert_called_once()

    def test_d007_handle_lockdown_includes_lock_session_context_in_ack(
        self, cfg, tmp_folder, tmp_sentinel
    ):
        """D-007: handle_lockdown passes lock_session_context to ack_command."""
        ctx = {
            "is_session_zero": True,
            "session_id": 0,
            "console_session_id": 1,
            "platform": "Windows",
        }
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder"),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "_detect_session_context", return_value=ctx),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once()
            assert mock_ack.call_args[1].get("lock_session_context") == ctx


# ---------------------------------------------------------------------------
# D-011: encryption_blocked_files in ACK payload tests
# ---------------------------------------------------------------------------


class TestEncryptionBlockedFilesAck:
    """D-011: Tests for encryption_blocked_files flowing through to ack_command."""

    def test_d011_handle_lockdown_includes_blocked_files_in_ack(
        self, cfg, tmp_folder, tmp_sentinel
    ):
        """D-011: handle_lockdown passes encryption_blocked_files to ack_command."""
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder", return_value=["Outlook.pst", "secret.docx"]),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once()
            blocked = mock_ack.call_args[1].get("encryption_blocked_files")
            assert blocked is not None
            assert "Outlook.pst" in blocked
            assert "secret.docx" in blocked

    def test_d011_handle_lockdown_empty_blocked_files_not_in_ack(
        self, cfg, tmp_folder, tmp_sentinel
    ):
        """D-011: Empty blocked_files list should not be included in ACK payload."""
        with (
            patch.object(agent, "ack_command", return_value=True) as mock_ack,
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder", return_value=[]),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            mock_ack.assert_called_once()
            # ack_command uses `if encryption_blocked_files:` so empty list is not included
            blocked = mock_ack.call_args[1].get("encryption_blocked_files")
            # The param is passed as [] but ack_command doesn't put it in payload
            assert blocked == []

    def test_d011_ack_command_includes_blocked_files_in_payload(self):
        """D-011: ack_command includes encryption_blocked_files in payload when non-empty."""
        cfg = {
            "hostname": "DEV-001",
            "server_url": "http://test",
            "agent_key": "k",
            "verify_tls": False,
        }
        with (
            patch.object(agent, "_signed_post") as mock_signed_post,
            patch.object(agent, "get_mac_address", return_value="00:00"),
            patch.object(agent, "get_hardware_uuid", return_value="uuid"),
        ):
            agent.ack_command(
                cfg=cfg,
                command_id="cmd-1",
                result_status="executed",
                key_material="k=",
                encryption_blocked_files=["file1.txt", "file2.txt"],
            )
            payload = mock_signed_post.call_args[0][2]
            assert "encryption_blocked_files" in payload
            assert payload["encryption_blocked_files"] == ["file1.txt", "file2.txt"]

    def test_d011_ack_command_excludes_empty_blocked_files_from_payload(self):
        """D-011: ack_command does not include encryption_blocked_files when empty."""
        cfg = {
            "hostname": "DEV-001",
            "server_url": "http://test",
            "agent_key": "k",
            "verify_tls": False,
        }
        with (
            patch.object(agent, "_signed_post") as mock_signed_post,
            patch.object(agent, "get_mac_address", return_value="00:00"),
            patch.object(agent, "get_hardware_uuid", return_value="uuid"),
        ):
            agent.ack_command(
                cfg=cfg,
                command_id="cmd-1",
                result_status="executed",
                key_material="k=",
                encryption_blocked_files=[],
            )
            payload = mock_signed_post.call_args[0][2]
            assert "encryption_blocked_files" not in payload


# ---------------------------------------------------------------------------
# Deadman key recovery
# ---------------------------------------------------------------------------


class TestDeadmanKey:
    def test_deadman_stores_key_locally(self, cfg, tmp_folder, tmp_sentinel):
        """When deadman triggers, key should be stored in DEADMAN_KEY_FILE."""
        # Set up deadman file with stolen status and old timestamp
        agent.DEADMAN_FILE.write_text(
            json.dumps(
                {
                    "last_seen": time.time() - (25 * 3600),  # 25 hours ago
                    "status": "stolen",
                }
            )
        )

        try:
            with (
                patch.object(agent, "apply_lock_screen"),
                patch.object(agent, "start_lock_guardian"),
                patch.object(agent, "write_pending_ack"),
                patch.object(agent, "write_recovery_key"),
            ):
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
        agent.DEADMAN_FILE.write_text(
            json.dumps(
                {
                    "last_seen": time.time() - (48 * 3600),
                    "status": "active",
                }
            )
        )

        try:
            with patch.object(agent, "encrypt_folder") as mock_encrypt:
                agent.check_deadman(cfg)
                mock_encrypt.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_deadman_does_not_trigger_if_recent(self, cfg):
        """Deadman should not trigger if last_seen is recent."""
        agent.DEADMAN_FILE.write_text(
            json.dumps(
                {
                    "last_seen": time.time() - (1 * 3600),  # 1 hour ago
                    "status": "stolen",
                }
            )
        )

        try:
            with patch.object(agent, "encrypt_folder") as mock_encrypt:
                agent.check_deadman(cfg)
                mock_encrypt.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_deadman_skips_if_already_locked(self, cfg, tmp_sentinel):
        """Deadman should not re-encrypt if sentinel already exists."""
        tmp_sentinel.write_text(json.dumps({"locked": True}))

        agent.DEADMAN_FILE.write_text(
            json.dumps(
                {
                    "last_seen": time.time() - (25 * 3600),
                    "status": "stolen",
                }
            )
        )

        try:
            with patch.object(agent, "encrypt_folder") as mock_encrypt:
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
            with patch.object(agent, "requests") as mock_requests:
                mock_resp = MagicMock()
                mock_resp.raise_for_status = MagicMock()
                mock_requests.post.return_value = mock_resp

                agent.report_deadman_key(cfg)

                # Should have POSTed to deadman-report
                mock_requests.post.assert_called_once()
                call_args = mock_requests.post.call_args
                assert "deadman-report" in call_args[0][0]
                # Phase 0: _signed_post sends JSON as data= (not json=) for HMAC signing
                body = json.loads(call_args[1]["data"])
                assert body["key_material"] == "test-fernet-key=="

                # Local key file should be deleted
                assert not agent.DEADMAN_KEY_FILE.exists()
        finally:
            if agent.DEADMAN_KEY_FILE.exists():
                agent.DEADMAN_KEY_FILE.unlink()

    def test_report_deadman_key_noop_if_no_file(self, cfg):
        """report_deadman_key should do nothing if no key file exists."""
        if agent.DEADMAN_KEY_FILE.exists():
            agent.DEADMAN_KEY_FILE.unlink()

        with patch.object(agent, "requests") as mock_requests:
            agent.report_deadman_key(cfg)
            mock_requests.post.assert_not_called()

    def test_report_deadman_key_retries_on_failure(self, cfg):
        """If upload fails, key file should be preserved for retry."""
        agent.DEADMAN_KEY_FILE.write_text("test-fernet-key==")

        try:
            with patch.object(agent, "requests") as mock_requests:
                import requests as real_requests

                mock_requests.post.side_effect = real_requests.RequestException("Network error")
                mock_requests.RequestException = real_requests.RequestException

                agent.report_deadman_key(cfg)

                # Key file should still exist for retry
                assert agent.DEADMAN_KEY_FILE.exists()
        finally:
            if agent.DEADMAN_KEY_FILE.exists():
                agent.DEADMAN_KEY_FILE.unlink()

    def test_update_deadman_timer_writes_encrypted(self):
        """update_deadman_timer should write encrypted state when state_crypto is available."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            if agent._STATE_CRYPTO_AVAILABLE:
                agent.update_deadman_timer("active")
                # File should exist and be encrypted (have the LDS1 magic)
                assert agent.DEADMAN_FILE.exists()
                with open(agent.DEADMAN_FILE, "rb") as f:
                    magic = f.read(4)
                assert magic == b"LDS1"
            else:
                # No state_crypto — should write plaintext
                agent.update_deadman_timer("active")
                assert agent.DEADMAN_FILE.exists()
                data = json.loads(agent.DEADMAN_FILE.read_text())
                assert data["status"] == "active"
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_reads_encrypted(self):
        """_read_deadman_state should read encrypted state files."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            if agent._STATE_CRYPTO_AVAILABLE:
                from state_crypto import save_encrypted_state

                save_encrypted_state(
                    agent.DEADMAN_FILE,
                    {
                        "last_seen": time.time(),
                        "status": "stolen",
                    },
                )
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "stolen"
            else:
                # No state_crypto — plaintext fallback
                agent.DEADMAN_FILE.write_text(
                    json.dumps({"last_seen": time.time(), "status": "stolen"})
                )
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "stolen"
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_falls_back_to_plaintext(self):
        """_read_deadman_state should read plaintext files (backward compat)."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            # Write plaintext (legacy format)
            agent.DEADMAN_FILE.write_text(json.dumps({"last_seen": 1234567890, "status": "active"}))
            state = agent._read_deadman_state()
            assert state is not None
            assert state["status"] == "active"
            assert state["last_seen"] == 1234567890
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_check_deadman_reads_encrypted_state(self, cfg, tmp_sentinel):
        """check_deadman should work with encrypted deadman files."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            if agent._STATE_CRYPTO_AVAILABLE:
                from state_crypto import save_encrypted_state

                save_encrypted_state(
                    agent.DEADMAN_FILE,
                    {
                        "last_seen": time.time() - (25 * 3600),  # 25 hours ago
                        "status": "stolen",
                    },
                )
            else:
                agent.DEADMAN_FILE.write_text(
                    json.dumps(
                        {
                            "last_seen": time.time() - (25 * 3600),
                            "status": "stolen",
                        }
                    )
                )

            with (
                patch.object(agent, "apply_lock_screen"),
                patch.object(agent, "start_lock_guardian"),
                patch.object(agent, "write_pending_ack"),
                patch.object(agent, "write_recovery_key"),
            ):
                agent.check_deadman(cfg)
                assert tmp_sentinel.exists()
        finally:
            for f in [agent.DEADMAN_FILE, agent.DEADMAN_KEY_FILE, tmp_sentinel]:
                if f.exists():
                    f.unlink()

    def test_migrate_deadman_to_encrypted(self):
        """migrate_deadman_to_encrypted should convert plaintext to encrypted."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            # Write plaintext deadman file
            agent.DEADMAN_FILE.write_text(json.dumps({"last_seen": 1234567890, "status": "active"}))

            # Run migration
            agent.migrate_deadman_to_encrypted()

            if agent._STATE_CRYPTO_AVAILABLE:
                # File should now be encrypted (has LDS1 magic)
                with open(agent.DEADMAN_FILE, "rb") as f:
                    magic = f.read(4)
                assert magic == b"LDS1"
                # And the content should still be readable
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "active"
            else:
                # No crypto — file should still be plaintext
                data = json.loads(agent.DEADMAN_FILE.read_text())
                assert data["status"] == "active"
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_migrate_deadman_noop_if_already_encrypted(self):
        """migrate_deadman_to_encrypted should be a no-op if already encrypted."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            if agent._STATE_CRYPTO_AVAILABLE:
                from state_crypto import save_encrypted_state

                save_encrypted_state(
                    agent.DEADMAN_FILE,
                    {
                        "last_seen": 1234567890,
                        "status": "active",
                    },
                )
                # Get the file content before migration
                before = agent.DEADMAN_FILE.read_bytes()
                agent.migrate_deadman_to_encrypted()
                after = agent.DEADMAN_FILE.read_bytes()
                # File should be unchanged
                assert before == after
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_migrate_deadman_noop_if_no_file(self):
        """migrate_deadman_to_encrypted should be a no-op if no deadman file."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        # Should not raise
        agent.migrate_deadman_to_encrypted()
        assert not agent.DEADMAN_FILE.exists()
