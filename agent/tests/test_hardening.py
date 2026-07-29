"""
Phase 3: Security hardening tests for the Remote Lockdown Agent.

Covers edge cases not in the main test_agent.py suite:
  - Fernet key generation produces a valid key
  - Key wipe zeroes a bytearray (secure memory clearing)
  - Concurrent lockdown commands are idempotent (sentinel guard)
  - Decryption with wrong key raises InvalidToken (not a crash)
  - Config validation: invalid SERVER_URL raises error
  - Config validation: relative LOCKDOWN_FOLDER raises error
  - File encryption: partial failure is tracked (resumable encryption)

Tests import functions directly from agent.py — no running server required.
"""

import json
import os
import shutil
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
from cryptography.fernet import Fernet, InvalidToken

# agent.py lives in the parent directory
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
        "pending_ack_file": Path(tempfile.mktemp()),
        "recovery_key_file": Path(tempfile.mktemp()),
        "recovery_public_key": "",
        "server_supports_ack_dedup": False,
    }


@pytest.fixture(autouse=True)
def cleanup_guardian():
    """Ensure lock guardian is stopped and temp files cleaned up after each test."""
    yield
    agent.stop_lock_guardian()
    for f in [agent.PENDING_ACK_FILE, agent.RECOVERY_KEY_FILE]:
        if f.exists():
            f.unlink()


# ---------------------------------------------------------------------------
# Fernet key generation
# ---------------------------------------------------------------------------

class TestKeyGeneration:
    def test_generate_key_produces_valid_fernet_key(self):
        """generate_key() must return a valid Fernet key (not raw os.urandom)."""
        key = agent.generate_key()
        # A valid Fernet key is 44-byte URL-safe base64 (decodes to 32 bytes)
        assert isinstance(key, bytes)
        # Fernet() should accept it without raising
        fernet = Fernet(key)
        # Round-trip a small message to confirm it works
        token = fernet.encrypt(b"test")
        assert fernet.decrypt(token) == b"test"

    def test_generate_key_is_unique_each_call(self):
        """Each call to generate_key() must produce a different key."""
        keys = {agent.generate_key() for _ in range(10)}
        assert len(keys) == 10

    def test_generate_key_is_32_bytes(self):
        """The underlying key material must be 32 bytes (256 bits)."""
        key = agent.generate_key()
        decoded = Fernet._fernet_from_key.__self__ if False else None  # noqa
        # Decode the base64 key to verify it's 32 bytes
        import base64
        raw = base64.urlsafe_b64decode(key)
        assert len(raw) == 32


# ---------------------------------------------------------------------------
# Key wipe
# ---------------------------------------------------------------------------

class TestKeyWipe:
    def test_wipe_key_zeroes_bytearray(self):
        """wipe_key() must zero all bytes of a bytearray (secure memory clearing)."""
        key = bytearray(b"sensitive-key-material-12345678")
        assert any(b != 0 for b in key)  # sanity: not already zeroed
        agent.wipe_key(key)
        assert all(b == 0 for b in key)

    def test_wipe_key_idempotent_on_already_zeroed(self):
        """Wiping an already-zeroed bytearray should not raise."""
        key = bytearray(32)
        agent.wipe_key(key)
        assert all(b == 0 for b in key)

    def test_wipe_key_accepts_bytearray(self):
        """wipe_key() should accept a bytearray (mutable) for in-place zeroing."""
        key = bytearray(os.urandom(32))
        agent.wipe_key(key)
        assert all(b == 0 for b in key)


# ---------------------------------------------------------------------------
# Concurrent lockdown idempotency
# ---------------------------------------------------------------------------

class TestConcurrentLockdownIdempotency:
    def test_handle_lockdown_skips_if_sentinel_exists(self, cfg, tmp_sentinel):
        """If sentinel already exists, handle_lockdown must NOT re-encrypt."""
        # Simulate a prior lockdown: sentinel exists
        tmp_sentinel.write_text(json.dumps({"locked": True}))

        with patch.object(agent, 'ack_command') as mock_ack, \
             patch.object(agent, 'encrypt_folder') as mock_encrypt, \
             patch.object(agent, 'apply_lock_screen') as mock_lock:
            agent.handle_lockdown(cfg, {"id": "cmd-1"})

            # Should ACK as executed without encrypting or locking
            mock_ack.assert_called_once_with(cfg, "cmd-1", "executed")
            mock_encrypt.assert_not_called()
            mock_lock.assert_not_called()

    def test_concurrent_handle_lockdown_does_not_double_encrypt(self, cfg, tmp_folder, tmp_sentinel):
        """Two concurrent handle_lockdown calls must not both encrypt.

        The sentinel guard ensures only the first call encrypts; the second
        sees the sentinel and skips. We simulate concurrency by pre-creating
        the sentinel before the second call runs.
        """
        call_count = {"encrypt": 0}

        def counting_encrypt(folder, key):
            call_count["encrypt"] += 1
            # Simulate the real encrypt_folder behavior for the first call
            real_encrypt = agent.__dict__.get('encrypt_folder')
            # Call the original via Fernet directly (avoid recursion)
            fernet = Fernet(key)
            for filepath in folder.rglob("*"):
                if filepath.is_file() and not filepath.name.endswith(".enc"):
                    enc_path = filepath.with_suffix(filepath.suffix + ".enc")
                    if not enc_path.exists():
                        data = filepath.read_bytes()
                        enc_path.write_bytes(fernet.encrypt(data))
                        filepath.unlink()

        with patch.object(agent, 'ack_command', return_value=True), \
             patch.object(agent, 'apply_lock_screen'), \
             patch.object(agent, 'start_lock_guardian'), \
             patch.object(agent, 'write_pending_ack'), \
             patch.object(agent, 'write_recovery_key'), \
             patch.object(agent, 'encrypt_folder', side_effect=counting_encrypt):
            # First lockdown — should encrypt
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            assert call_count["encrypt"] == 1
            assert tmp_sentinel.exists()

            # Second lockdown (concurrent/retried) — sentinel exists, should skip
            agent.handle_lockdown(cfg, {"id": "cmd-1"})
            assert call_count["encrypt"] == 1  # still 1, not 2

    def test_handle_lockdown_is_safe_under_thread_contention(self, cfg, tmp_folder, tmp_sentinel):
        """Multiple threads calling handle_lockdown should not corrupt state.

        This is a smoke test — true race conditions are hard to reproduce
        deterministically, but we verify the sentinel guard prevents
        multiple encrypt_folder calls when the sentinel is set early.
        """
        encrypt_calls = []
        lock = threading.Lock()

        def tracking_encrypt(folder, key):
            with lock:
                encrypt_calls.append(threading.current_thread().name)
            # Write sentinel immediately to simulate the guard
            tmp_sentinel.write_text(json.dumps({"locked": True}))

        with patch.object(agent, 'ack_command', return_value=True), \
             patch.object(agent, 'apply_lock_screen'), \
             patch.object(agent, 'start_lock_guardian'), \
             patch.object(agent, 'write_pending_ack'), \
             patch.object(agent, 'write_recovery_key'), \
             patch.object(agent, 'encrypt_folder', side_effect=tracking_encrypt):
            threads = []
            for i in range(5):
                t = threading.Thread(
                    target=agent.handle_lockdown,
                    args=(cfg, {"id": f"cmd-{i}"}),
                    name=f"lockdown-{i}",
                )
                threads.append(t)
                t.start()
            for t in threads:
                t.join(timeout=5)

            # At most one thread should have called encrypt_folder
            # (the one that won the sentinel race). The others skip.
            assert len(encrypt_calls) <= 1


# ---------------------------------------------------------------------------
# Decryption with wrong key
# ---------------------------------------------------------------------------

class TestDecryptionWrongKey:
    def test_decrypt_folder_with_wrong_key_raises_invalid_token(self, tmp_folder):
        """Decryption with the wrong key must raise InvalidToken, not crash silently."""
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)

        wrong_key = agent.generate_key()
        with pytest.raises(InvalidToken):
            agent.decrypt_folder(tmp_folder, wrong_key)

    def test_decrypt_with_wrong_key_does_not_produce_garbage(self, tmp_folder):
        """Wrong key must not silently produce garbage output files."""
        key = agent.generate_key()
        agent.encrypt_folder(tmp_folder, key)

        wrong_key = agent.generate_key()
        # Count .enc files before
        enc_before = list(tmp_folder.rglob("*.enc"))
        assert len(enc_before) > 0

        with pytest.raises(InvalidToken):
            agent.decrypt_folder(tmp_folder, wrong_key)

        # The first .enc file should still exist (decryption failed before
        # any file was written — Fernet.decrypt raises before write)
        assert len(list(tmp_folder.rglob("*.enc"))) == len(enc_before)

    def test_fernet_decrypt_raises_invalid_token_for_tampered_token(self):
        """Fernet.decrypt must raise InvalidToken for tampered ciphertext."""
        key = agent.generate_key()
        fernet = Fernet(key)
        token = fernet.encrypt(b"secret data")
        # Tamper with the token
        tampered = token[:-5] + b"XXXXX"
        with pytest.raises(InvalidToken):
            fernet.decrypt(tampered)


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------

class TestConfigValidation:
    def test_invalid_server_url_raises_error(self, cfg):
        """validate_config must reject an invalid SERVER_URL."""
        cfg["server_url"] = "not-a-valid-url"
        with pytest.raises((ValueError, AssertionError, SystemExit)):
            agent.validate_config(cfg)

    def test_relative_lockdown_folder_raises_error(self, cfg, tmp_folder):
        """validate_config must reject a relative LOCKDOWN_FOLDER."""
        cfg["lockdown_folder"] = Path("relative/path/to/folder")
        with pytest.raises((ValueError, AssertionError, SystemExit)):
            agent.validate_config(cfg)

    def test_valid_config_passes_validation(self, cfg):
        """A valid config must pass validation without raising."""
        # cfg fixture has a valid https URL and absolute lockdown_folder
        agent.validate_config(cfg)

    def test_http_server_url_raises_error(self, cfg):
        """validate_config must reject http:// (non-TLS) SERVER_URL."""
        cfg["server_url"] = "http://insecure-server.example.com"
        with pytest.raises((ValueError, AssertionError, SystemExit)):
            agent.validate_config(cfg)

    def test_empty_server_url_raises_error(self, cfg):
        """validate_config must reject an empty SERVER_URL."""
        cfg["server_url"] = ""
        with pytest.raises((ValueError, AssertionError, SystemExit)):
            agent.validate_config(cfg)


# ---------------------------------------------------------------------------
# File encryption partial failure tracking (resumable encryption)
# ---------------------------------------------------------------------------

class TestPartialFailureTracking:
    def test_encrypt_folder_resumes_after_partial_failure(self, tmp_folder):
        """If encryption is interrupted (some files encrypted, some not),
        re-running encrypt_folder with the same key completes without
        double-encrypting already-encrypted files."""
        key = agent.generate_key()
        fernet = Fernet(key)

        # Simulate a crash after encrypting only file1.txt
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

    def test_encrypt_folder_skips_already_encrypted_files(self, tmp_folder):
        """encrypt_folder must skip files that already have .enc counterparts."""
        key = agent.generate_key()
        fernet = Fernet(key)

        # Manually encrypt file1.txt
        data = (tmp_folder / "file1.txt").read_bytes()
        (tmp_folder / "file1.txt.enc").write_bytes(fernet.encrypt(data))
        (tmp_folder / "file1.txt").unlink()

        # Encrypt the rest
        agent.encrypt_folder(tmp_folder, key)

        # file1.txt.enc should still be there (not double-encrypted)
        assert (tmp_folder / "file1.txt.enc").exists()
        # No .enc.enc files should exist (double encryption)
        assert len(list(tmp_folder.rglob("*.enc.enc"))) == 0

    def test_partial_encryption_is_recoverable_with_correct_key(self, tmp_folder):
        """A folder with a mix of .enc and plaintext files (partial failure)
        can be fully recovered by resuming encryption then decrypting."""
        key = agent.generate_key()
        fernet = Fernet(key)

        # Partially encrypt: only file1.txt
        data = (tmp_folder / "file1.txt").read_bytes()
        (tmp_folder / "file1.txt.enc").write_bytes(fernet.encrypt(data))
        (tmp_folder / "file1.txt").unlink()

        # Resume and complete encryption
        agent.encrypt_folder(tmp_folder, key)

        # Decrypt everything
        agent.decrypt_folder(tmp_folder, key)

        # All original files should be restored
        assert (tmp_folder / "file1.txt").read_text() == "hello world"
        assert (tmp_folder / "file2.txt").read_text() == "secret data"
        assert (tmp_folder / "subdir" / "nested.txt").read_text() == "nested content"
        assert len(list(tmp_folder.rglob("*.enc"))) == 0
