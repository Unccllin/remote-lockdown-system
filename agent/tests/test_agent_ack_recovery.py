"""
Tests for the Remote Lockdown Agent.
Covers: encryption/decryption, lock guardian, deadman key recovery,
double-lock guard, config loading, hardware identity.
"""

import json

# We need to import agent.py which is in the parent directory
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

from cryptography.fernet import Fernet

import agent

# Shared fixtures (tmp_folder, tmp_sentinel, cfg, cleanup_guardian)
# are now provided by tests/conftest.py — no need to redefine here.

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
            mock_requests.ConnectionError = real_requests.ConnectionError
            mock_requests.Timeout = real_requests.Timeout

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
