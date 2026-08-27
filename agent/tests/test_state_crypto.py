"""Tests for the state cryptography module.

Tests cover:
- Encryption/decryption round-trip
- HMAC tamper detection
- File format (magic header)
- Missing/corrupt file handling
- Machine key derivation
- Fail-secure behavior (errors return None)
"""

import sys
from pathlib import Path
from unittest.mock import patch

# Add agent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
import state_crypto


class TestEncryptDecryptRoundTrip:
    def test_encrypt_then_decrypt_returns_original(self):
        plaintext = b'{"status": "stolen", "last_seen": 1234567890}'
        encrypted = state_crypto.encrypt_data(plaintext)
        decrypted = state_crypto.decrypt_data(encrypted)
        assert decrypted == plaintext

    def test_encrypt_produces_different_output(self):
        plaintext = b'{"status": "active"}'
        encrypted = state_crypto.encrypt_data(plaintext)
        assert encrypted != plaintext

    def test_encrypt_empty_data(self):
        plaintext = b''
        encrypted = state_crypto.encrypt_data(plaintext)
        decrypted = state_crypto.decrypt_data(encrypted)
        assert decrypted == plaintext

    def test_encrypt_large_data(self):
        plaintext = b'{"data": "' + b'A' * 10000 + b'"}'
        encrypted = state_crypto.encrypt_data(plaintext)
        decrypted = state_crypto.decrypt_data(encrypted)
        assert decrypted == plaintext


class TestSaveLoadEncryptedState:
    def test_save_and_load_round_trip(self, tmp_path):
        path = tmp_path / ".deadman"
        data = {"status": "stolen", "last_seen": 1234567890}

        assert state_crypto.save_encrypted_state(path, data) is True
        loaded = state_crypto.load_encrypted_state(path)

        assert loaded is not None
        assert loaded["status"] == "stolen"
        assert loaded["last_seen"] == 1234567890

    def test_load_returns_none_if_file_missing(self, tmp_path):
        path = tmp_path / ".nonexistent"
        assert state_crypto.load_encrypted_state(path) is None

    def test_save_creates_file_with_magic(self, tmp_path):
        path = tmp_path / ".test_state"
        state_crypto.save_encrypted_state(path, {"status": "active"})

        blob = path.read_bytes()
        assert blob[:4] == state_crypto._MAGIC

    def test_load_returns_none_for_corrupt_file(self, tmp_path):
        path = tmp_path / ".corrupt"
        path.write_bytes(b"CORRUPT_DATA_NOT_ENCRYPTED{{{")
        assert state_crypto.load_encrypted_state(path) is None

    def test_load_returns_none_for_too_small_file(self, tmp_path):
        path = tmp_path / ".small"
        path.write_bytes(b"LDS1")  # Magic but no HMAC or data
        assert state_crypto.load_encrypted_state(path) is None

    def test_load_returns_none_for_wrong_magic(self, tmp_path):
        path = tmp_path / ".wrong_magic"
        path.write_bytes(b"XXXX" + b'\x00' * 32 + b'data')
        assert state_crypto.load_encrypted_state(path) is None


class TestTamperDetection:
    def test_tampered_hmac_detected(self, tmp_path):
        path = tmp_path / ".tampered"
        state_crypto.save_encrypted_state(path, {"status": "stolen"})

        # Tamper with the HMAC (flip a bit)
        blob = bytearray(path.read_bytes())
        blob[4] ^= 0x01  # Flip first byte of HMAC
        path.write_bytes(bytes(blob))

        assert state_crypto.load_encrypted_state(path) is None

    def test_tampered_ciphertext_detected(self, tmp_path):
        path = tmp_path / ".tampered_ct"
        state_crypto.save_encrypted_state(path, {"status": "stolen"})

        # Tamper with the ciphertext (flip a bit after magic + HMAC)
        blob = bytearray(path.read_bytes())
        blob[36] ^= 0x01  # Flip first byte of ciphertext
        path.write_bytes(bytes(blob))

        assert state_crypto.load_encrypted_state(path) is None

    def test_truncated_file_detected(self, tmp_path):
        path = tmp_path / ".truncated"
        state_crypto.save_encrypted_state(path, {"status": "stolen"})

        # Truncate the file
        blob = path.read_bytes()
        path.write_bytes(blob[:20])

        assert state_crypto.load_encrypted_state(path) is None


class TestMachineKey:
    def test_get_machine_guid_returns_bytes(self):
        guid = state_crypto._get_machine_guid()
        assert isinstance(guid, bytes)
        assert len(guid) > 0

    def test_get_hmac_key_returns_32_bytes(self):
        key = state_crypto._get_hmac_key()
        assert len(key) == 32  # SHA-256 = 32 bytes

    def test_keys_are_consistent(self):
        key1 = state_crypto._get_hmac_key()
        key2 = state_crypto._get_hmac_key()
        assert key1 == key2  # Same machine = same key


class TestIsEncryptedStateFile:
    def test_returns_true_for_encrypted_file(self, tmp_path):
        path = tmp_path / ".test"
        state_crypto.save_encrypted_state(path, {"status": "active"})
        assert state_crypto.is_encrypted_state_file(path) is True

    def test_returns_false_for_plain_file(self, tmp_path):
        path = tmp_path / ".plain"
        path.write_text('{"status": "active"}')
        assert state_crypto.is_encrypted_state_file(path) is False

    def test_returns_false_for_missing_file(self, tmp_path):
        path = tmp_path / ".missing"
        assert state_crypto.is_encrypted_state_file(path) is False


class TestFailSecure:
    """Verify that all error paths return None (fail-secure)."""

    def test_load_permission_error_returns_none(self, tmp_path):
        path = tmp_path / ".noperm"
        state_crypto.save_encrypted_state(path, {"status": "active"})

        with patch.object(Path, "read_bytes", side_effect=PermissionError("denied")):
            assert state_crypto.load_encrypted_state(path) is None

    def test_save_permission_error_returns_false(self, tmp_path):
        path = tmp_path / ".noperm_save"

        with patch.object(Path, "write_bytes", side_effect=PermissionError("denied")):
            assert state_crypto.save_encrypted_state(path, {"status": "active"}) is False
