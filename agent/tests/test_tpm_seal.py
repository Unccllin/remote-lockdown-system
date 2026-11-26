"""Tests for the TPM 2.0 sealed storage module.

Tests cover:
- TPM availability check (graceful on non-Windows)
- Blob format (magic header, length encoding)
- AES-GCM encrypt/decrypt round-trip
- Fail-secure behavior (errors return None)
- The key's address: a certificate in the machine certificate store (LocalMachine/My), not
  a CNG key name (measured on MOLE, 2026-11-26: CngKey.Create against the Platform Crypto
  Provider is not supported, New-SelfSignedCertificate with that provider is)

All TPM/PowerShell calls are mocked — no real TPM access in tests. The shapes below
were taken from a real run on MOLE; real hardware verification is a separate artifact.
"""

import os
import struct
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Add agent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
import tpm_seal

THUMBPRINT = "07BB56094337306551C587A73DC0DFA7F790A166"


@pytest.fixture(autouse=True)
def _clear_thumbprint_cache():
    """The resolved thumbprint is cached per process; a leak would hide a real lookup."""
    tpm_seal._tpm_thumbprint = None
    yield
    tpm_seal._tpm_thumbprint = None


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
        assert tpm_seal._aes_gcm_decrypt(key, b"short") is None


class TestBlobFormat:
    def test_sealed_blob_has_magic(self):
        # Create a fake blob with the correct magic
        sealed_key = b"\x00" * 256  # RSA 2048 = 256 bytes
        encrypted_state = b"\x00" * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        assert tpm_seal.is_tpm_sealed_blob(blob) is True

    def test_non_tpm_blob_rejected(self):
        assert tpm_seal.is_tpm_sealed_blob(b"XXXX" + b"\x00" * 100) is False

    def test_empty_blob_rejected(self):
        assert tpm_seal.is_tpm_sealed_blob(b"") is False


class TestSealUnseal:
    """Test seal/unseal with mocked TPM access."""

    @patch.object(tpm_seal, "is_tpm_available", return_value=False)
    def test_seal_returns_none_without_tpm(self, mock_tpm):
        result = tpm_seal.seal_state(b'{"status": "stolen"}')
        assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=False)
    def test_unseal_returns_none_on_non_windows(self, mock_win):
        # Create a valid-looking blob
        sealed_key = b"\x00" * 256
        encrypted_state = b"\x00" * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None

    @patch.object(tpm_seal, "is_tpm_available", return_value=True)
    @patch.object(tpm_seal, "_seal_cert_thumbprint", return_value=THUMBPRINT)
    @patch.object(tpm_seal, "_tpm_seal_key")
    @patch.object(tpm_seal, "_tpm_unseal_key")
    @patch.object(tpm_seal, "_is_windows", return_value=True)
    def test_seal_unseal_round_trip(self, mock_win, mock_unseal, mock_seal, mock_thumb, mock_tpm):
        """Test full seal/unseal round-trip with the TPM calls mocked."""
        # The RSA wrap is mocked to pass through: what is under test is the envelope
        # (magic, length, AES-GCM) and the plumbing between it and the TPM key.
        mock_seal.side_effect = lambda thumbprint, data: data
        mock_unseal.side_effect = lambda thumbprint, data: data

        plaintext = b'{"status": "stolen", "last_seen": 1234567890}'

        # Seal
        sealed_blob = tpm_seal.seal_state(plaintext)
        assert sealed_blob is not None
        assert tpm_seal.is_tpm_sealed_blob(sealed_blob)
        assert mock_seal.call_args[0][0] == THUMBPRINT

        # Unseal
        unsealed = tpm_seal.unseal_state(sealed_blob)
        assert unsealed is not None
        assert unsealed == plaintext
        assert mock_unseal.call_args[0][0] == THUMBPRINT

    @patch.object(tpm_seal, "is_tpm_available", return_value=True)
    @patch.object(tpm_seal, "_seal_cert_thumbprint", return_value=None)
    @patch.object(tpm_seal, "_tpm_seal_key")
    def test_seal_returns_none_if_key_creation_fails(self, mock_seal, mock_thumb, mock_tpm):
        result = tpm_seal.seal_state(b'{"status": "stolen"}')
        assert result is None
        assert not mock_seal.called, "no data key may be wrapped when there is no key"


class TestUnsealFailSecure:
    """Verify that all error paths in unseal return None (fail-secure)."""

    def test_unseal_too_short_blob(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            result = tpm_seal.unseal_state(b"TPM1")
            assert result is None

    def test_unseal_wrong_magic(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            blob = b"XXXX" + struct.pack("<I", 4) + b"\x00" * 100
            result = tpm_seal.unseal_state(blob)
            assert result is None

    def test_unseal_truncated_sealed_key(self):
        with patch.object(tpm_seal, "_is_windows", return_value=True):
            # Claim 256 bytes of sealed key but only provide 10
            blob = tpm_seal._MAGIC + struct.pack("<I", 256) + b"\x00" * 10
            result = tpm_seal.unseal_state(blob)
            assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=True)
    @patch.object(tpm_seal, "_seal_cert_thumbprint", return_value=THUMBPRINT)
    @patch.object(tpm_seal, "_tpm_unseal_key", return_value=None)
    def test_unseal_tpm_decrypt_fails(self, mock_decrypt, mock_thumb, mock_win):
        sealed_key = b"\x00" * 256
        encrypted_state = b"\x00" * 100
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=True)
    @patch.object(tpm_seal, "_seal_cert_thumbprint", return_value=THUMBPRINT)
    @patch.object(tpm_seal, "_tpm_unseal_key", return_value=b"wrong_key")
    def test_unseal_aes_decrypt_fails(self, mock_decrypt, mock_thumb, mock_win):
        sealed_key = b"\x00" * 256
        encrypted_state = b"\x00" * 100  # Not valid AES-GCM
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + encrypted_state

        result = tpm_seal.unseal_state(blob)
        assert result is None

    @patch.object(tpm_seal, "_is_windows", return_value=True)
    @patch.object(tpm_seal, "_seal_cert_thumbprint", return_value=None)
    @patch.object(tpm_seal, "_tpm_unseal_key")
    def test_unseal_without_certificate_does_not_attempt_decrypt(
        self, mock_decrypt, mock_thumb, mock_win
    ):
        """A missing certificate must not become a new key on the read path."""
        sealed_key = b"\x00" * 256
        blob = tpm_seal._MAGIC + struct.pack("<I", len(sealed_key)) + sealed_key + b"\x00" * 100

        assert tpm_seal.unseal_state(blob) is None
        assert not mock_decrypt.called


class TestDeleteTPMKey:
    def test_delete_returns_false_on_non_windows(self):
        with patch.object(tpm_seal, "_is_windows", return_value=False):
            assert tpm_seal.delete_tpm_key() is False

    @staticmethod
    def _call(monkeypatch, stdout, returncode=0):
        captured = {}

        class _Result:
            def __init__(self) -> None:
                self.stdout = stdout
                self.stderr = ""
                self.returncode = returncode

        result = _Result()

        def _fake_run(args, **kwargs):
            captured["args"] = args
            return result

        monkeypatch.setattr(tpm_seal, "_is_windows", lambda: True)
        monkeypatch.setattr(tpm_seal.subprocess, "run", _fake_run)
        return tpm_seal.delete_tpm_key(), captured["args"][-1]

    def test_delete_removes_the_tpm_key_and_the_certificate(self, monkeypatch):
        """Deleting one half is not enough — measured on MOLE, 2026-11-26.

        `$rsa.Key.Delete()` succeeds while the certificate stays (and encryption afterwards
        is refused), so the certificate must be removed too; and removing the certificate
        alone leaves the persisted `te-<guid>` key in the TPM.
        """
        ok, script = self._call(monkeypatch, "STATE=DELETED\nCOUNT=1")

        assert ok is True
        assert "$rsa.Key.Delete()" in script
        assert "Remove-Item" in script

    def test_delete_does_not_use_the_nonexistent_static_overload(self, monkeypatch):
        _, script = self._call(monkeypatch, "STATE=NOTFOUND")
        assert "[System.Security.Cryptography.CngKey]::Delete(" not in script, (
            "that static overload does not exist on .NET Framework, so the old code threw "
            "and deleted nothing"
        )

    def test_delete_reports_success_only_for_a_known_state(self, monkeypatch):
        ok, _ = self._call(monkeypatch, "STATE=NOTFOUND")
        assert ok is True, "an absent key is already the desired state"

        ok, _ = self._call(monkeypatch, "unexpected output")
        assert ok is False

    def test_delete_failure_is_not_reported_as_success(self, monkeypatch):
        ok, _ = self._call(monkeypatch, "ERROR: access denied", returncode=1)
        assert ok is False


class TestCertAddressing:
    """The key is addressed by a certificate, which is the only path that works.

    Measured on MOLE (Windows 11, TPM 2.0 Infineon present and ready, Windows PowerShell
    5.1) on 2026-11-26: `CngKey.Create` against the Platform Crypto Provider returns "The
    requested operation is not supported"; `New-SelfSignedCertificate` with that provider
    creates a key whose export is refused, i.e. a genuinely TPM-resident key. These tests
    pin the script shapes so a future edit cannot quietly return to the unsupported call.
    """

    @staticmethod
    def _call(monkeypatch, stdout, create=True, returncode=0):
        captured = {}

        class _Result:
            def __init__(self) -> None:
                self.stdout = stdout
                self.stderr = ""
                self.returncode = returncode

        result = _Result()

        def _fake_run(args, **kwargs):
            captured["args"] = args
            return result

        monkeypatch.setattr(tpm_seal, "_is_windows", lambda: True)
        monkeypatch.setattr(tpm_seal.subprocess, "run", _fake_run)
        return tpm_seal._seal_cert_thumbprint(create=create), captured["args"]

    def test_create_script_uses_a_certificate_not_cng_key_create(self, monkeypatch):
        thumb, argv = self._call(monkeypatch, f"MATCHES=0\nSTATE=CREATED\nTHUMBPRINT={THUMBPRINT}")
        script = argv[-1]

        assert thumb == THUMBPRINT
        assert "New-SelfSignedCertificate" in script
        assert "Platform Crypto Provider" in script
        assert "-KeyUsage KeyEncipherment, DataEncipherment" in script
        assert "CngKey]::Create" not in script, (
            "CngKey.Create against the Platform Crypto Provider is not supported on "
            "Windows 10/11 (measured on MOLE)"
        )
        assert "CngKeyFlags]::" not in script

    def test_powershell_is_non_interactive(self, monkeypatch):
        """A prompt in session 0 cannot be answered; it would hang the check-in."""
        _, argv = self._call(monkeypatch, f"MATCHES=1\nSTATE=EXISTS\nTHUMBPRINT={THUMBPRINT}")
        assert "-NonInteractive" in argv

    def test_read_script_never_creates_a_key(self, monkeypatch):
        thumb, argv = self._call(monkeypatch, "MATCHES=0\nSTATE=ABSENT", create=False)

        assert thumb is None
        assert "New-SelfSignedCertificate" not in argv[-1]

    def test_thumbprint_is_resolved_once_per_process(self, monkeypatch):
        calls = []

        class _Result:
            returncode = 0
            stdout = f"MATCHES=1\nSTATE=EXISTS\nTHUMBPRINT={THUMBPRINT}"
            stderr = ""

        def _fake_run(args, **kwargs):
            calls.append(args)
            return _Result()

        monkeypatch.setattr(tpm_seal, "_is_windows", lambda: True)
        monkeypatch.setattr(tpm_seal.subprocess, "run", _fake_run)

        assert tpm_seal._seal_cert_thumbprint() == THUMBPRINT
        assert tpm_seal._seal_cert_thumbprint() == THUMBPRINT
        assert len(calls) == 1

    def test_unusable_thumbprint_is_rejected(self, monkeypatch):
        thumb, _ = self._call(monkeypatch, "MATCHES=1\nSTATE=EXISTS\nTHUMBPRINT=not-a-thumbprint")
        assert thumb is None

    def test_multiple_certificates_use_the_newest_and_say_so(self, monkeypatch, caplog):
        with caplog.at_level("WARNING"):
            thumb, _ = self._call(monkeypatch, f"MATCHES=3\nSTATE=EXISTS\nTHUMBPRINT={THUMBPRINT}")

        assert thumb == THUMBPRINT
        message = " ".join(r.getMessage() for r in caplog.records)
        assert "3 certificates" in message

    def test_failure_surfaces_stdout_not_only_stderr(self, monkeypatch, caplog):
        """The reason must reach the log; logging stderr alone printed an empty message."""
        with caplog.at_level("WARNING"):
            thumb, _ = self._call(
                monkeypatch,
                "ERROR: Unable to find type [System.Security.Cryptography.CngKeyFlags].",
                returncode=1,
            )

        assert thumb is None
        message = " ".join(r.getMessage() for r in caplog.records)
        assert "Unable to find type" in message
        assert "rc=1" in message


class TestOaepPadding:
    """OAEP-SHA256, not PKCS#1 v1.5 — both work, so the stronger one is used."""

    @staticmethod
    def _script(monkeypatch, plaintext=b"k" * 32):
        captured = {}

        class _Result:
            returncode = 0
            stdout = "AA=="
            stderr = ""

        def _fake_run(args, **kwargs):
            captured["args"] = args
            return _Result()

        monkeypatch.setattr(tpm_seal, "_is_windows", lambda: True)
        monkeypatch.setattr(tpm_seal.subprocess, "run", _fake_run)
        tpm_seal._tpm_seal_key(THUMBPRINT, plaintext)
        return captured["args"][-1]

    def test_seal_uses_oaep_sha256(self, monkeypatch):
        script = self._script(monkeypatch)
        assert "OaepSHA256" in script
        assert "::Pkcs1" not in script

    def test_seal_addresses_the_key_by_thumbprint(self, monkeypatch):
        script = self._script(monkeypatch)
        assert THUMBPRINT in script
        assert "GetRSAPrivateKey" in script

    def test_oversized_payload_is_refused_before_powershell(self, monkeypatch):
        def _boom(*args, **kwargs):
            raise AssertionError("must not reach the TPM with an oversized payload")

        monkeypatch.setattr(tpm_seal, "_is_windows", lambda: True)
        monkeypatch.setattr(tpm_seal.subprocess, "run", _boom)

        assert tpm_seal._tpm_seal_key(THUMBPRINT, b"x" * 191) is None
        assert tpm_seal._MAX_SEALED_KEY_BYTES == 190
