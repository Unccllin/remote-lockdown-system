"""Tests for the TPM 2.0 sealed storage module.

Tests cover:
- TPM availability check (graceful on non-Windows)
- Blob format (magic header, length encoding)
- AES-GCM encrypt/decrypt round-trip
- Fail-secure behavior (errors return None)
- Blob parsing and validation

All TPM/CNG calls are mocked — no real TPM access in tests.
"""

import os
import struct
import sys
from pathlib import Path
from unittest.mock import patch

# Add agent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
import tpm_seal


class TestTPMAvailability:
    def test_is_tpm_available_returns_false_on_non_windows(self):
        with patch.object(tpm_seal, "_is_windows", return_value=False):
            assert tpm_seal.is_tpm_available() is False

    def test_is_tpm_available_returns_bool(self):
        result = tpm_seal.is_tpm_available()
        assert isinstance(result, bool)


class TestAESGCM:
    def test_aes_gcm_encrypt_decrypt_round_trip(self):
        key = os.urandom(32)
        plaintext = b'{"status": "stolen", "last_seen": 1234567890}'

        encrypted = tpm_seal._aes_gcm_encrypt(key, plaintext)
        decrypted = tpm_seal._aes_gcm_decrypt(key, encrypted)

        assert decrypted == plaintext

    def test_aes_gcm_decrypt_with_wrong_key_returns_none(self):
        key1 = os.urandom(32)
        key2 = os.urandom(32)
        plaintext = b'{"status": "stolen"}'

        encrypted = tpm_seal._aes_gcm_encrypt(key1, plaintext)
        decrypted = tpm_seal._aes_gcm_decrypt(key2, encrypted)

        assert decrypted is None

    def test_aes_gcm_decrypt_tampered_data_returns_none(self):
        key = os.urandom(32)
        plaintext = b'{"status": "stolen"}'

        encrypted = bytearray(tpm_seal._aes_gcm_encrypt(key, plaintext))
        encrypted[15] ^= 0x01  # Tamper with ciphertext
        decrypted = tpm_seal._aes_gcm_decrypt(key, bytes(encrypted))

        assert decrypted is None

    def test_aes_gcm_decrypt_too_short_returns_none(self):
        key = os.urandom(32)
        assert tpm_seal._aes_gcm_decrypt(key, b'short') is None


class TestBlobFormat:
    def test_sealed_blob_has_magic(self):
        # Create a fake blob with the correct magic
        sealed_key = b'\x00' * 256  # RSA 2048 = 256 bytes
        encrypted_state = b'\x00' * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        assert tpm_seal.is_tpm_sealed_blob(blob) is True

    def test_non_tpm_blob_rejected(self):
        assert tpm_seal.is_tpm_sealed_blob(b'XXXX' + b'\x00' * 100) is False

    def test_empty_blob_rejected(self):
        assert tpm_seal.is_tpm_sealed_blob(b'') is False


class TestSealUnseal:
    """Test seal/unseal with mocked TPM access."""

    @patch.object(tpm_seal, "is_tpm_available", return_value=False)
    def test_seal_returns_none_without_tpm(self, mock_tpm):
        result = tpm_seal.seal_state(b'{"status": "stolen"}')
        assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=False)
    def test_unseal_returns_none_on_non_windows(self, mock_win):
        # Create a valid-looking blob
        sealed_key = b'\x00' * 256
        encrypted_state = b'\x00' * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None

    @patch.object(tpm_seal, "is_tpm_available", return_value=True)
    @patch.object(tpm_seal, "_cng_create_key", return_value=True)
    @patch.object(tpm_seal, "_cng_encrypt_with_tpm")
    @patch.object(tpm_seal, "_cng_decrypt_with_tpm")
    @patch.object(tpm_seal, "_is_windows", return_value=True)
    def test_seal_unseal_round_trip(self, mock_win, mock_decrypt, mock_encrypt, mock_key, mock_tpm):
        """Test full seal/unseal round-trip with mocked TPM."""
        # Mock: _cng_encrypt_with_tpm returns the plaintext as-is
        # (in reality it encrypts with RSA, but for testing we just pass through)
        mock_encrypt.side_effect = lambda data: data  # Return as-is
        mock_decrypt.side_effect = lambda data: data  # Return as-is

        plaintext = b'{"status": "stolen", "last_seen": 1234567890}'

        # Seal
        sealed_blob = tpm_seal.seal_state(plaintext)
        assert sealed_blob is not None
        assert tpm_seal.is_tpm_sealed_blob(sealed_blob)

        # Unseal
        unsealed = tpm_seal.unseal_state(sealed_blob)
        assert unsealed is not None
        assert unsealed == plaintext

    @patch.object(tpm_seal, "is_tpm_available", return_value=True)
    @patch.object(tpm_seal, "_cng_create_key", return_value=False)
    def test_seal_returns_none_if_key_creation_fails(self, mock_key, mock_tpm):
        result = tpm_seal.seal_state(b'{"status": "stolen"}')
        assert result is None


class TestUnsealFailSecure:
    """Verify that all error paths in unseal return None (fail-secure)."""

    def test_unseal_too_short_blob(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            result = tpm_seal.unseal_state(b'TPM1')
            assert result is None

    def test_unseal_wrong_magic(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            blob = b'XXXX' + struct.pack("<I", 4) + b'\x00' * 100
            result = tpm_seal.unseal_state(blob)
            assert result is None

    def test_unseal_truncated_sealed_key(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            # Claim 256 bytes of sealed key but only provide 10
            blob = tpm_seal._MAGIC + struct.pack("<I", 256) + b'\x00' * 10
            result = tpm_seal.unseal_state(blob)
            assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=True)
    @patch.object(tpm_seal, "_cng_decrypt_with_tpm", return_value=None)
    def test_unseal_tpm_decrypt_fails(self, mock_decrypt, mock_win):
        sealed_key = b'\x00' * 256
        encrypted_state = b'\x00' * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=True)
    @patch.object(tpm_seal, "_cng_decrypt_with_tpm", return_value=b'wrong_key')
    def test_unseal_aes_decrypt_fails(self, mock_decrypt, mock_win):
        sealed_key = b'\x00' * 256
        encrypted_state = b'\x00' * 100  # Not valid AES-GCM
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None


class TestDeleteTPMKey:
    def test_delete_returns_false_on_non_windows(self):
        with patch.object(tpm_seal, "_is_windows", return_value=False):
            assert tpm_seal.delete_tpm_key() is False
