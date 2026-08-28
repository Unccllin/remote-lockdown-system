"""
Tests for the duress code + hidden file trigger module.

Covers:
  - Hidden file trigger: creating the trigger file causes lockdown
  - Trigger file is deleted after lockdown
  - Duress code: unlock with duress_code re-encrypts and re-locks after delay
  - Normal unlock (no duress_code) works as before (no duress thread started)
  - is_duress_unlock detection logic
"""

import shutil
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).parent.parent))

# duress.py is in the parent directory (agent root)
import duress  # noqa: E402, I001


# Shared fixtures (tmp_sentinel, cfg, cleanup_guardian) are provided by
# tests/conftest.py. This file keeps its own tmp_folder (2 files only,
# no subdir) because several duress tests assert exact file counts.

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def tmp_state_dir():
    """Create a temporary state directory."""
    d = Path(tempfile.mkdtemp())
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_folder():
    """Create a temporary folder with exactly 2 test files (no subdir).

    Duress tests assert exact .enc file counts, so the folder must have
    a known number of files. The conftest tmp_folder creates 3 files
    (including subdir/nested.txt) which would break these assertions.
    """
    d = Path(tempfile.mkdtemp())
    (d / "file1.txt").write_text("hello world")
    (d / "file2.txt").write_text("secret data")
    yield d
    shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# Hidden file trigger tests
# ---------------------------------------------------------------------------


class TestHiddenFileTrigger:
    """Tests for the hidden file trigger mechanism."""

    def test_trigger_file_absent_returns_false(self, tmp_state_dir):
        """check_hidden_trigger returns False when no trigger file exists."""
        assert duress.check_hidden_trigger(tmp_state_dir) is False

    def test_trigger_file_present_returns_true(self, tmp_state_dir):
        """check_hidden_trigger returns True when the trigger file exists."""
        trigger = tmp_state_dir / duress.HIDDEN_TRIGGER_FILENAME
        trigger.write_text("cleanup")
        assert duress.check_hidden_trigger(tmp_state_dir) is True

    def test_trigger_filename_looks_innocuous(self):
        """The trigger file name should look like a system cache file."""
        assert "cache" in duress.HIDDEN_TRIGGER_FILENAME
        assert duress.HIDDEN_TRIGGER_FILENAME.startswith(".")

    def test_consume_trigger_deletes_file(self, tmp_state_dir):
        """consume_hidden_trigger deletes the trigger file."""
        trigger = tmp_state_dir / duress.HIDDEN_TRIGGER_FILENAME
        trigger.write_text("cleanup")
        assert duress.consume_hidden_trigger(tmp_state_dir) is True
        assert not trigger.exists()

    def test_consume_trigger_returns_false_when_absent(self, tmp_state_dir):
        """consume_hidden_trigger returns False when no trigger file exists."""
        assert duress.consume_hidden_trigger(tmp_state_dir) is False

    def test_hidden_trigger_path_is_in_state_dir(self, tmp_state_dir):
        """The trigger path is inside the given state directory."""
        path = duress.hidden_trigger_path(tmp_state_dir)
        assert path.parent == tmp_state_dir
        assert path.name == duress.HIDDEN_TRIGGER_FILENAME


# ---------------------------------------------------------------------------
# Duress code detection tests
# ---------------------------------------------------------------------------


class TestDuressDetection:
    """Tests for is_duress_unlock detection logic."""

    def test_normal_unlock_no_duress_field(self):
        """An unlock command without duress_code is not a duress unlock."""
        cmd = {"id": "cmd-1", "type": "unlock", "key_material": "abc"}
        assert duress.is_duress_unlock(cmd) is False

    def test_duress_unlock_true(self):
        """An unlock command with duress_code=True is a duress unlock."""
        cmd = {"id": "cmd-1", "type": "unlock", "key_material": "abc", "duress_code": True}
        assert duress.is_duress_unlock(cmd) is True

    def test_duress_unlock_false_explicit(self):
        """An unlock command with duress_code=False is NOT a duress unlock."""
        cmd = {"id": "cmd-1", "type": "unlock", "key_material": "abc", "duress_code": False}
        assert duress.is_duress_unlock(cmd) is False

    def test_duress_unlock_none(self):
        """An unlock command with duress_code=None is NOT a duress unlock."""
        cmd = {"id": "cmd-1", "type": "unlock", "key_material": "abc", "duress_code": None}
        assert duress.is_duress_unlock(cmd) is False

    def test_duress_unlock_empty_string(self):
        """An empty string duress_code is falsy — not a duress unlock."""
        cmd = {"id": "cmd-1", "type": "unlock", "key_material": "abc", "duress_code": ""}
        assert duress.is_duress_unlock(cmd) is False

    def test_duress_unlock_non_unlock_command(self):
        """A lockdown command with duress_code is not a duress unlock (field ignored)."""
        # is_duress_unlock only checks the field, not the command type.
        # The caller (handle_unlock) only calls it for unlock commands.
        cmd = {"id": "cmd-1", "type": "lockdown", "duress_code": True}
        # The function checks the field regardless of type — the caller
        # is responsible for only calling it on unlock commands.
        assert duress.is_duress_unlock(cmd) is True


# ---------------------------------------------------------------------------
# Duress re-encryption engine tests
# ---------------------------------------------------------------------------


class TestDuressReencrypt:
    """Tests for the duress re-encryption + re-lock background thread."""

    def test_duress_reencrypts_after_delay(self, tmp_folder, tmp_state_dir):
        """The duress thread re-encrypts files after the reencrypt delay."""
        sentinel = tmp_state_dir / ".sentinel"
        encrypt_calls = []
        lock_calls = []
        guardian_calls = []
        reported_keys = []

        def fake_encrypt(folder, key):
            encrypt_calls.append((str(folder), key))
            fernet = Fernet(key)
            for fp in folder.rglob("*"):
                if fp.is_file() and not fp.name.endswith(".enc"):
                    enc = fp.with_suffix(fp.suffix + ".enc")
                    enc.write_bytes(fernet.encrypt(fp.read_bytes()))
                    fp.unlink()
            return []

        def fake_generate_key():
            return Fernet.generate_key()

        def fake_apply_lock():
            lock_calls.append(True)

        def fake_start_guardian():
            guardian_calls.append(True)

        def fake_report(cmd_id, key_b64):
            reported_keys.append((cmd_id, key_b64))
            return True

        cmd = {"id": "cmd-duress-1", "type": "unlock", "duress_code": True}

        thread = duress.start_duress_relock(
            cfg={},
            command=cmd,
            encrypt_fn=fake_encrypt,
            generate_key_fn=fake_generate_key,
            apply_lock_screen_fn=fake_apply_lock,
            start_lock_guardian_fn=fake_start_guardian,
            sentinel_path=sentinel,
            lockdown_folder=tmp_folder,
            report_key_fn=fake_report,
            reencrypt_delay=0.1,
            relock_delay=0.1,
        )

        thread.join(timeout=5)

        # Files were re-encrypted
        assert len(encrypt_calls) == 1
        enc_files = list(tmp_folder.rglob("*.enc"))
        assert len(enc_files) == 2

        # Sentinel was written
        assert sentinel.exists()

        # Key was reported
        assert len(reported_keys) == 1
        assert reported_keys[0][0] == "cmd-duress-1"

        # Lock screen + guardian were applied
        assert len(lock_calls) == 1
        assert len(guardian_calls) == 1

    def test_duress_thread_is_daemon(self, tmp_folder, tmp_state_dir):
        """The duress thread is a daemon thread (won't block process exit)."""
        sentinel = tmp_state_dir / ".sentinel"
        cmd = {"id": "cmd-1", "duress_code": True}

        thread = duress.start_duress_relock(
            cfg={},
            command=cmd,
            encrypt_fn=lambda f, k: [],
            generate_key_fn=Fernet.generate_key,
            apply_lock_screen_fn=lambda: None,
            start_lock_guardian_fn=lambda: None,
            sentinel_path=sentinel,
            lockdown_folder=tmp_folder,
            report_key_fn=None,
            reencrypt_delay=10,
            relock_delay=10,
        )
        assert thread.daemon is True
        # Clean up — cancel the thread
        duress.stop_duress_thread()

    def test_stop_duress_thread_cancels_before_reencrypt(self, tmp_folder, tmp_state_dir):
        """stop_duress_thread cancels the thread before re-encryption happens."""
        sentinel = tmp_state_dir / ".sentinel"
        encrypt_calls = []

        cmd = {"id": "cmd-1", "duress_code": True}

        duress.start_duress_relock(
            cfg={},
            command=cmd,
            encrypt_fn=lambda f, k: encrypt_calls.append(k) or [],
            generate_key_fn=Fernet.generate_key,
            apply_lock_screen_fn=lambda: None,
            start_lock_guardian_fn=lambda: None,
            sentinel_path=sentinel,
            lockdown_folder=tmp_folder,
            report_key_fn=None,
            reencrypt_delay=1.0,
            relock_delay=1.0,
        )

        # Stop immediately — before the 1s reencrypt delay
        duress.stop_duress_thread()
        time.sleep(0.2)

        # Encryption should NOT have happened
        assert len(encrypt_calls) == 0
        assert not sentinel.exists()

    def test_duress_no_report_fn_when_none(self, tmp_folder, tmp_state_dir):
        """When report_key_fn is None, the thread still works (no upload)."""
        sentinel = tmp_state_dir / ".sentinel"
        cmd = {"id": "cmd-1", "duress_code": True}

        thread = duress.start_duress_relock(
            cfg={},
            command=cmd,
            encrypt_fn=lambda f, k: [],
            generate_key_fn=Fernet.generate_key,
            apply_lock_screen_fn=lambda: None,
            start_lock_guardian_fn=lambda: None,
            sentinel_path=sentinel,
            lockdown_folder=tmp_folder,
            report_key_fn=None,
            reencrypt_delay=0.05,
            relock_delay=0.05,
        )
        thread.join(timeout=5)

        # Sentinel written, no crash
        assert sentinel.exists()


# ---------------------------------------------------------------------------
# Integration: agent.handle_unlock with duress code
# ---------------------------------------------------------------------------


class TestAgentUnlockDuressIntegration:
    """Integration tests verifying agent.handle_unlock duress wiring."""

    def test_normal_unlock_does_not_start_duress_thread(self, tmp_folder, tmp_state_dir):
        """A normal unlock (no duress_code) does NOT start the duress thread."""
        import agent

        # Create encrypted files first
        key = Fernet.generate_key()
        fernet = Fernet(key)
        for fp in tmp_folder.rglob("*"):
            if fp.is_file():
                enc = fp.with_suffix(fp.suffix + ".enc")
                enc.write_bytes(fernet.encrypt(fp.read_bytes()))
                fp.unlink()

        sentinel = tmp_state_dir / ".sentinel"
        sentinel.write_text('{"locked": true}')

        cfg = {
            "server_url": "https://test.example.com",
            "agent_key": "test-key",
            "hostname": "test-host",
            "lockdown_folder": tmp_folder,
            "lock_sentinel": sentinel,
            "verify_tls": True,
            "boot_lock_enabled": False,
            "pending_ack_file": tmp_state_dir / ".pending_ack",
            "recovery_key_file": tmp_state_dir / ".recovery_key",
        }

        cmd = {"id": "cmd-1", "type": "unlock", "key_material": key.decode()}

        # Mock ack_command so we don't hit the network
        with (
            patch.object(agent, "ack_command", return_value=True),
            patch.object(agent, "remove_lock_screen"),
            patch.object(agent, "_DURESS_AVAILABLE", True),
            patch.object(agent, "_start_duress_relock") as mock_start,
        ):
            agent.handle_unlock(cfg, cmd)
            # _start_duress_relock should NOT have been called
            mock_start.assert_not_called()

        # Files should be decrypted (normal unlock worked)
        enc_files = list(tmp_folder.rglob("*.enc"))
        assert len(enc_files) == 0
        # Sentinel should be removed
        assert not sentinel.exists()

    def test_duress_unlock_starts_duress_thread(self, tmp_folder, tmp_state_dir):
        """A duress unlock (duress_code=True) starts the duress relock thread."""
        import agent

        # Create encrypted files
        key = Fernet.generate_key()
        fernet = Fernet(key)
        for fp in tmp_folder.rglob("*"):
            if fp.is_file():
                enc = fp.with_suffix(fp.suffix + ".enc")
                enc.write_bytes(fernet.encrypt(fp.read_bytes()))
                fp.unlink()

        sentinel = tmp_state_dir / ".sentinel"
        sentinel.write_text('{"locked": true}')

        cfg = {
            "server_url": "https://test.example.com",
            "agent_key": "test-key",
            "hostname": "test-host",
            "lockdown_folder": tmp_folder,
            "lock_sentinel": sentinel,
            "verify_tls": True,
            "boot_lock_enabled": False,
            "pending_ack_file": tmp_state_dir / ".pending_ack",
            "recovery_key_file": tmp_state_dir / ".recovery_key",
        }

        cmd = {"id": "cmd-1", "type": "unlock", "key_material": key.decode(), "duress_code": True}

        with (
            patch.object(agent, "ack_command", return_value=True),
            patch.object(agent, "remove_lock_screen"),
            patch.object(agent, "_DURESS_AVAILABLE", True),
            patch.object(agent, "_start_duress_relock") as mock_start,
        ):
            agent.handle_unlock(cfg, cmd)
            # _start_duress_relock SHOULD have been called
            mock_start.assert_called_once()

        # Files should still be decrypted (the fake unlock completed)
        enc_files = list(tmp_folder.rglob("*.enc"))
        assert len(enc_files) == 0
        # Sentinel should be removed (fake unlock)
        assert not sentinel.exists()


# ---------------------------------------------------------------------------
# Integration: hidden file trigger in agent main loop
# ---------------------------------------------------------------------------


class TestHiddenTriggerIntegration:
    """Integration tests for the hidden file trigger in the agent."""

    def test_trigger_file_causes_lockdown_and_is_deleted(self, tmp_folder, tmp_state_dir):
        """Creating the trigger file causes lockdown and the file is deleted."""
        import agent

        sentinel = tmp_state_dir / ".sentinel"
        deadman_key = tmp_state_dir / ".deadman_key"

        cfg = {
            "server_url": "https://test.example.com",
            "agent_key": "test-key",
            "hostname": "test-host",
            "lockdown_folder": tmp_folder,
            "lock_sentinel": sentinel,
            "verify_tls": True,
            "boot_lock_enabled": False,
            "pending_ack_file": tmp_state_dir / ".pending_ack",
            "recovery_key_file": tmp_state_dir / ".recovery_key",
        }

        # Create the hidden trigger file
        trigger = tmp_state_dir / duress.HIDDEN_TRIGGER_FILENAME
        trigger.write_text("cleanup")

        with (
            patch.object(agent, "_DURESS_AVAILABLE", True),
            patch.object(agent, "_STATE_DIR", tmp_state_dir),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "start_lock_guardian") as mock_guardian,
            patch.object(agent, "show_lockdown_notification"),
            patch.object(agent, "DEADMAN_KEY_FILE", deadman_key),
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
        ):
            agent._trigger_hidden_lockdown(cfg)

            # Lock screen + guardian were applied
            mock_lock.assert_called_once()
            mock_guardian.assert_called_once()

        # Sentinel was created
        assert sentinel.exists()
        # Trigger file was deleted
        assert not trigger.exists()
        # Deadman key file was written (for upload on next checkin)
        assert deadman_key.exists()

    def test_trigger_when_already_locked_just_relocks(self, tmp_folder, tmp_state_dir):
        """If already locked, the trigger just re-applies the lock screen."""
        import agent

        sentinel = tmp_state_dir / ".sentinel"
        sentinel.write_text('{"locked": true}')

        cfg = {
            "lockdown_folder": tmp_folder,
            "lock_sentinel": sentinel,
            "boot_lock_enabled": False,
            "pending_ack_file": tmp_state_dir / ".pending_ack",
            "recovery_key_file": tmp_state_dir / ".recovery_key",
        }

        trigger = tmp_state_dir / duress.HIDDEN_TRIGGER_FILENAME
        trigger.write_text("cleanup")

        with (
            patch.object(agent, "_DURESS_AVAILABLE", True),
            patch.object(agent, "_STATE_DIR", tmp_state_dir),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "start_lock_guardian") as mock_guardian,
            patch.object(agent, "generate_key") as mock_gen_key,
        ):
            agent._trigger_hidden_lockdown(cfg)

            # Lock screen re-applied
            mock_lock.assert_called_once()
            mock_guardian.assert_called_once()
            # Encryption should NOT have happened (already locked)
            mock_gen_key.assert_not_called()

        # Trigger file was still deleted
        assert not trigger.exists()
