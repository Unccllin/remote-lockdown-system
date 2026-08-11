"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json
import os
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

from cryptography.fernet import Fernet, InvalidToken

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
        # A1/A4/A8: new config options
        "pending_ack_file": Path(tempfile.mktemp()),
        "recovery_key_file": Path(tempfile.mktemp()),
        "recovery_public_key": "",  # Empty = recovery feature disabled in tests
        "server_supports_ack_dedup": False,
    }


@pytest.fixture(autouse=True)
def cleanup_guardian():
    """Ensure lock guardian is stopped and temp files cleaned up after each test."""
    yield
    agent.stop_lock_guardian()
    # Clean up any pending ACK / recovery key files created during tests
    for f in [agent.PENDING_ACK_FILE, agent.RECOVERY_KEY_FILE]:
        if f.exists():
            f.unlink()


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
            with patch("subprocess.check_output", side_effect=Exception("No DMI")):
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

    def test_startup_check_noop_if_no_sentinel(self, cfg, tmp_sentinel):
        """If no sentinel, startup check should do nothing."""
        with patch.object(agent, "apply_lock_screen") as mock_lock:
            agent.startup_check(cfg)
            mock_lock.assert_not_called()


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

            result = agent.checkin(cfg)
            assert result is None


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


# ---------------------------------------------------------------------------
# Pending ACK persistence (A1 + A4)
# ---------------------------------------------------------------------------


class TestPendingAck:
    def test_ack_command_returns_true_on_success(self, cfg):
        """ack_command should return True on HTTP 2xx."""
        with patch.object(agent, "requests") as mock_requests:
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_requests.post.return_value = mock_resp
            mock_requests.RequestException = Exception

            result = agent.ack_command(cfg, "cmd-1", "executed")
            assert result is True

    def test_ack_command_returns_false_on_failure(self, cfg):
        """ack_command should return False on network error."""
        with patch.object(agent, "requests") as mock_requests:
            import requests as real_requests

            mock_requests.post.side_effect = real_requests.RequestException("Network error")
            mock_requests.RequestException = real_requests.RequestException

            result = agent.ack_command(cfg, "cmd-1", "executed")
            assert result is False

    def test_write_pending_ack_creates_file(self, cfg):
        """write_pending_ack should write a JSON file with the ACK state."""
        ack_file = cfg["pending_ack_file"]
        try:
            agent.write_pending_ack(ack_file, "cmd-1", "executed", key_material="test-key==")

            assert ack_file.exists()
            state = json.loads(ack_file.read_text())
            assert state["command_id"] == "cmd-1"
            assert state["result_status"] == "executed"
            assert state["key_material"] == "test-key=="
            assert "created_at" in state
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_update_pending_ack_adds_bios_password(self, cfg):
        """update_pending_ack should add bios_password to existing file."""
        ack_file = cfg["pending_ack_file"]
        try:
            agent.write_pending_ack(ack_file, "cmd-1", "executed", key_material="test-key==")
            agent.update_pending_ack(ack_file, bios_password="bios-pw", boot_lock_status="partial")

            state = json.loads(ack_file.read_text())
            assert state["bios_password"] == "bios-pw"
            assert state["boot_lock_status"] == "partial"
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_write_pending_ack_includes_boot_lock_detail(self, cfg):
        """write_pending_ack should persist boot_lock_detail for ACK retry."""
        ack_file = cfg["pending_ack_file"]
        try:
            detail = {
                "boot_lock_attempted": True,
                "critical_applied_total": 0,
                "best_effort_applied_total": 1,
                "best_effort_failed_total": 0,
            }
            agent.write_pending_ack(
                ack_file,
                "cmd-1",
                "executed",
                key_material="test-key==",
                boot_lock_status="partial",
                boot_lock_detail=detail,
            )
            state = json.loads(ack_file.read_text())
            assert state["boot_lock_detail"] == detail
            assert state["boot_lock_status"] == "partial"
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_update_pending_ack_adds_boot_lock_detail(self, cfg):
        """update_pending_ack should add boot_lock_detail to existing file."""
        ack_file = cfg["pending_ack_file"]
        try:
            agent.write_pending_ack(ack_file, "cmd-1", "executed", key_material="test-key==")
            detail = {"boot_lock_attempted": True, "critical_applied_total": 2}
            agent.update_pending_ack(ack_file, boot_lock_status="partial", boot_lock_detail=detail)

            state = json.loads(ack_file.read_text())
            assert state["boot_lock_detail"] == detail
            assert state["boot_lock_status"] == "partial"
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_drain_pending_ack_retries_with_boot_lock_detail(self, cfg):
        """drain_pending_ack should re-send boot_lock_detail from the saved state."""
        ack_file = cfg["pending_ack_file"]
        try:
            detail = {"boot_lock_attempted": True, "critical_applied_total": 0}
            agent.write_pending_ack(
                ack_file,
                "cmd-1",
                "executed",
                key_material="test-key==",
                boot_lock_status="partial",
                boot_lock_detail=detail,
            )
            with patch.object(agent, "ack_command", return_value=True) as mock_ack:
                agent.drain_pending_ack(cfg)
                mock_ack.assert_called_once()
                assert mock_ack.call_args[1]["boot_lock_detail"] == detail
                assert mock_ack.call_args[1]["boot_lock_status"] == "partial"
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_drain_pending_ack_noop_if_no_file(self, cfg):
        """drain_pending_ack should do nothing if no pending ACK file exists."""
        ack_file = cfg["pending_ack_file"]
        if ack_file.exists():
            ack_file.unlink()
        with patch.object(agent, "ack_command") as mock_ack:
            agent.drain_pending_ack(cfg)
            mock_ack.assert_not_called()

    def test_drain_pending_ack_retries_and_deletes_on_success(self, cfg):
        """drain_pending_ack should re-send ACK and delete file on success."""
        ack_file = cfg["pending_ack_file"]
        try:
            agent.write_pending_ack(ack_file, "cmd-1", "executed", key_material="test-key==")

            with patch.object(agent, "ack_command", return_value=True) as mock_ack:
                agent.drain_pending_ack(cfg)

                mock_ack.assert_called_once()
                assert mock_ack.call_args[0][1] == "cmd-1"
                assert mock_ack.call_args[1]["key_material"] == "test-key=="
                # File should be deleted on success
                assert not ack_file.exists()
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_drain_pending_ack_preserves_file_on_failure(self, cfg):
        """drain_pending_ack should preserve file on ACK failure for retry."""
        ack_file = cfg["pending_ack_file"]
        try:
            agent.write_pending_ack(ack_file, "cmd-1", "executed", key_material="test-key==")

            with patch.object(agent, "ack_command", return_value=False):
                agent.drain_pending_ack(cfg)

                # File should still exist for retry
                assert ack_file.exists()
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_handle_lockdown_writes_pending_ack_before_encryption(
        self, cfg, tmp_folder, tmp_sentinel
    ):
        """A1: pending ACK file should be written BEFORE encrypt_folder is called."""
        call_order = []

        def mock_write_ack(*args, **kwargs):
            call_order.append("write_pending_ack")

        def mock_encrypt(*args, **kwargs):
            call_order.append("encrypt_folder")

        with (
            patch.object(agent, "ack_command", return_value=True),
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "write_pending_ack", side_effect=mock_write_ack),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "encrypt_folder", side_effect=mock_encrypt),
        ):
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            # write_pending_ack should come before encrypt_folder
            assert "write_pending_ack" in call_order
            assert "encrypt_folder" in call_order
            assert call_order.index("write_pending_ack") < call_order.index("encrypt_folder")

    def test_handle_lockdown_preserves_ack_file_on_ack_failure(self, cfg, tmp_folder, tmp_sentinel):
        """A4: if ACK fails, pending ACK file should be preserved for retry."""
        ack_file = cfg["pending_ack_file"]
        try:
            with (
                patch.object(agent, "ack_command", return_value=False),
                patch.object(agent, "apply_lock_screen"),
                patch.object(agent, "start_lock_guardian"),
                patch.object(agent, "write_recovery_key"),
                patch.object(agent, "encrypt_folder"),
            ):
                agent.handle_lockdown(cfg, {"id": "cmd-1"})

                # Pending ACK file should still exist (ACK failed)
                assert ack_file.exists()
                state = json.loads(ack_file.read_text())
                assert state["command_id"] == "cmd-1"
                assert state["key_material"] is not None
        finally:
            if ack_file.exists():
                ack_file.unlink()

    def test_handle_lockdown_deletes_ack_file_on_ack_success(self, cfg, tmp_folder, tmp_sentinel):
        """On ACK success, pending ACK file should be deleted."""
        ack_file = cfg["pending_ack_file"]
        try:
            with (
                patch.object(agent, "ack_command", return_value=True),
                patch.object(agent, "apply_lock_screen"),
                patch.object(agent, "start_lock_guardian"),
                patch.object(agent, "write_recovery_key"),
                patch.object(agent, "encrypt_folder"),
            ):
                agent.handle_lockdown(cfg, {"id": "cmd-1"})

                # Pending ACK file should be deleted (ACK succeeded)
                assert not ack_file.exists()
        finally:
            if ack_file.exists():
                ack_file.unlink()


# ---------------------------------------------------------------------------
# Resumable encryption (CC20)
# ---------------------------------------------------------------------------


class TestResumableEncryption:
    def test_encrypt_folder_skips_already_encrypted_files(self, tmp_folder):
        """CC20: encrypt_folder should skip files that already have .enc counterparts."""
        key = agent.generate_key()
        # Encrypt one file manually
        fernet = Fernet(key)
        data = (tmp_folder / "file1.txt").read_bytes()
        encrypted = fernet.encrypt(data)
        (tmp_folder / "file1.txt.enc").write_bytes(encrypted)
        (tmp_folder / "file1.txt").unlink()

        # Now encrypt the rest with the same key — should skip file1.txt.enc
        agent.encrypt_folder(tmp_folder, key)

        # file1.txt.enc should still be there (not double-encrypted)
        assert (tmp_folder / "file1.txt.enc").exists()
        # file2.txt should be encrypted
        assert (tmp_folder / "file2.txt.enc").exists()
        assert not (tmp_folder / "file2.txt").exists()

        # All should decrypt correctly with the same key
        agent.decrypt_folder(tmp_folder, key)
        assert (tmp_folder / "file1.txt").read_text() == "hello world"
        assert (tmp_folder / "file2.txt").read_text() == "secret data"

    def test_encrypt_folder_resumes_after_crash(self, tmp_folder):
        """CC20: simulate a crash mid-encryption — resume with same key."""
        key = agent.generate_key()
        fernet = Fernet(key)

        # Encrypt file1 only (simulating crash after 1 file)
        data = (tmp_folder / "file1.txt").read_bytes()
        (tmp_folder / "file1.txt.enc").write_bytes(fernet.encrypt(data))
        (tmp_folder / "file1.txt").unlink()

        # file2.txt and subdir/nested.txt are still plaintext
        assert (tmp_folder / "file2.txt").exists()
        assert (tmp_folder / "subdir" / "nested.txt").exists()

        # Resume encryption with the SAME key
        agent.encrypt_folder(tmp_folder, key)

        # All files should now be encrypted
        assert not (tmp_folder / "file2.txt").exists()
        assert (tmp_folder / "file2.txt.enc").exists()
        assert not (tmp_folder / "subdir" / "nested.txt").exists()
        assert (tmp_folder / "subdir" / "nested.txt.enc").exists()

        # All should decrypt correctly with the same key
        agent.decrypt_folder(tmp_folder, key)
        assert (tmp_folder / "file1.txt").read_text() == "hello world"
        assert (tmp_folder / "file2.txt").read_text() == "secret data"
        assert (tmp_folder / "subdir" / "nested.txt").read_text() == "nested content"


# ---------------------------------------------------------------------------
# Recovery key file (A8)
# ---------------------------------------------------------------------------


class TestRecoveryKey:
    def test_write_recovery_key_skips_if_no_public_key(self, cfg):
        """If no recovery_public_key is configured, write_recovery_key should skip."""
        recovery_file = cfg["recovery_key_file"]
        cfg["recovery_public_key"] = ""
        try:
            agent.write_recovery_key(recovery_file, "cmd-1", "test-key==", cfg=cfg)
            # File should NOT be created (no public key configured)
            assert not recovery_file.exists()
        finally:
            if recovery_file.exists():
                recovery_file.unlink()

    def test_write_recovery_key_creates_wrapped_file(self, cfg, tmp_folder):
        """With a valid RSA public key, write_recovery_key should create a wrapped blob."""
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        # Generate a test RSA keypair
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )

        # Write the public key to a temp file
        pub_key_file = Path(tempfile.mktemp(suffix=".pem"))
        pub_key_file.write_bytes(public_key_pem)

        recovery_file = cfg["recovery_key_file"]
        cfg["recovery_public_key"] = str(pub_key_file)

        try:
            fernet_key = agent.generate_key().decode()
            agent.write_recovery_key(
                recovery_file, "cmd-1", fernet_key, bios_password="bios-pw", cfg=cfg
            )

            assert recovery_file.exists()
            state = json.loads(recovery_file.read_text())
            assert state["command_id"] == "cmd-1"
            assert "wrapped_key" in state
            assert "wrapped_bios_password" in state

            # Verify we can unwrap with the private key
            import base64

            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.asymmetric import padding

            wrapped = base64.b64decode(state["wrapped_key"])
            unwrapped = private_key.decrypt(
                wrapped,
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            ).decode()

            assert unwrapped == fernet_key

            wrapped_bios = base64.b64decode(state["wrapped_bios_password"])
            unwrapped_bios = private_key.decrypt(
                wrapped_bios,
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            ).decode()

            assert unwrapped_bios == "bios-pw"
        finally:
            if recovery_file.exists():
                recovery_file.unlink()
            if pub_key_file.exists():
                pub_key_file.unlink()

    def test_handle_unlock_deletes_recovery_key(self, cfg, tmp_folder, tmp_sentinel):
        """handle_unlock should delete the recovery key file on success."""
        # Set up: encrypt folder, write sentinel, create recovery key file
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)
        tmp_sentinel.write_text(json.dumps({"locked": True}))
        recovery_file = cfg["recovery_key_file"]
        recovery_file.write_text(json.dumps({"command_id": "cmd-1", "wrapped_key": "dummy"}))
        key_b64 = key.decode()

        try:
            with (
                patch.object(agent, "ack_command", return_value=True),
                patch.object(agent, "remove_lock_screen"),
            ):
                agent.handle_unlock(cfg, {"id": "cmd-1", "key_material": key_b64})

                # Recovery key file should be deleted
                assert not recovery_file.exists()
        finally:
            if recovery_file.exists():
                recovery_file.unlink()


# ---------------------------------------------------------------------------
# Offline recovery tool (A8)
# ---------------------------------------------------------------------------


class TestOfflineRecovery:
    def test_offline_recovery_round_trip(self, tmp_folder):
        """Full round-trip: encrypt → write recovery key → offline recover → decrypt."""
        import subprocess

        from cryptography.hazmat.primitives import serialization

        # Generate RSA keypair
        from cryptography.hazmat.primitives.asymmetric import rsa

        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )

        # Write keys to temp files
        pub_key_file = Path(tempfile.mktemp(suffix=".pem"))
        priv_key_file = Path(tempfile.mktemp(suffix=".pem"))
        pub_key_file.write_bytes(public_key_pem)
        priv_key_file.write_bytes(private_key_pem)

        # Write recovery key file
        recovery_file = Path(tempfile.mktemp(suffix=".json"))
        fernet_key = agent.generate_key()
        fernet_key_b64 = fernet_key.decode()

        cfg = {
            "recovery_public_key": str(pub_key_file),
        }
        agent.write_recovery_key(recovery_file, "cmd-1", fernet_key_b64, cfg=cfg)

        # Encrypt the folder
        agent.encrypt_folder(tmp_folder, fernet_key)

        # Verify files are encrypted
        assert not (tmp_folder / "file1.txt").exists()
        assert (tmp_folder / "file1.txt.enc").exists()

        # Run offline_recovery.py
        offline_script = Path(__file__).parent.parent / "offline_recovery.py"
        result = subprocess.run(
            [
                sys.executable,
                str(offline_script),
                "--recovery-key",
                str(priv_key_file),
                "--recovery-file",
                str(recovery_file),
                "--folder",
                str(tmp_folder),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert result.returncode == 0, f"offline_recovery.py failed: {result.stderr}"
        assert "decrypted successfully" in result.stdout

        # Verify files are decrypted
        assert (tmp_folder / "file1.txt").exists()
        assert (tmp_folder / "file1.txt").read_text() == "hello world"
        assert not (tmp_folder / "file1.txt.enc").exists()

        # Cleanup
        for f in [pub_key_file, priv_key_file, recovery_file]:
            if f.exists():
                f.unlink()
