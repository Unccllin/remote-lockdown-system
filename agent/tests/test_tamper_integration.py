"""Integration tests for tamper protection and TPM sealing in the agent.

Tests cover:
- check_tamper() is called in the main loop (mock the function, verify it's called)
- TPM sealing is preferred when available (mock is_tpm_available, verify seal_state is called)
- DPAPI fallback works when TPM is not available
- Tamper detection triggers re-lock when device is stolen

All platform-specific calls are mocked — no real TPM or Windows API access.
"""

import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

# Add agent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import agent

# Shared fixtures (tmp_folder, tmp_sentinel, cfg, cleanup_guardian)
# are now provided by tests/conftest.py — no need to redefine here.
# This file keeps a more thorough cleanup_state_files fixture below
# that also cleans DEADMAN_FILE and DEADMAN_KEY_FILE.

@pytest.fixture(autouse=True)
def cleanup_state_files():
    """Clean up any state files created during tests (including deadman files)."""
    yield
    agent.stop_lock_guardian()
    for f in [
        agent.DEADMAN_FILE,
        agent.DEADMAN_KEY_FILE,
        agent.PENDING_ACK_FILE,
        agent.RECOVERY_KEY_FILE,
    ]:
        if f.exists():
            f.unlink()


# ---------------------------------------------------------------------------
# Tests: check_tamper is called in the main loop
# ---------------------------------------------------------------------------


class TestTamperCheckInMainLoop:
    """Verify that check_tamper() is wired into the agent main loop."""

    def test_run_tamper_check_calls_check_tamper(self, cfg):
        """_run_tamper_check should call check_tamper with the state dir."""
        with patch.object(agent, "check_tamper", return_value={"tampered": False}) as mock_ct:
            agent._run_tamper_check(cfg, "active")
            mock_ct.assert_called_once_with(agent._STATE_DIR)

    def test_run_tamper_check_no_relock_when_not_tampered(self, cfg):
        """When no tamper is detected, re-lock functions should NOT be called."""
        with (
            patch.object(agent, "check_tamper", return_value={"tampered": False}),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "encrypt_folder") as mock_encrypt,
        ):
            agent._run_tamper_check(cfg, "stolen")
            mock_lock.assert_not_called()
            mock_encrypt.assert_not_called()

    def test_run_tamper_check_handles_exception_gracefully(self, cfg):
        """If check_tamper raises, _run_tamper_check should not propagate."""
        with patch.object(agent, "check_tamper", side_effect=RuntimeError("boom")):
            # Should not raise
            agent._run_tamper_check(cfg, "stolen")

    def test_tamper_check_interval_constant_exists(self):
        """TAMPER_CHECK_INTERVAL should be defined and equal 300 (5 minutes)."""
        assert hasattr(agent, "TAMPER_CHECK_INTERVAL")
        assert agent.TAMPER_CHECK_INTERVAL == 300

    def test_main_loop_has_last_tamper_check_variable(self):
        """The main() function source should reference last_tamper_check."""
        import inspect

        source = inspect.getsource(agent.main)
        assert "last_tamper_check" in source
        assert "_run_tamper_check" in source


# ---------------------------------------------------------------------------
# Tests: Tamper detection triggers re-lock when device is stolen
# ---------------------------------------------------------------------------


class TestTamperTriggersRelock:
    """Verify that tamper detection triggers re-lock when device is stolen/locked."""

    def test_relock_triggered_when_stolen_and_tampered(self, cfg, tmp_sentinel):
        """When tamper is detected and status is 'stolen', re-lock should fire."""
        tamper_result = {
            "files_missing": [".deadman"],
            "service_missing": False,
            "task_missing": False,
            "tampered": True,
        }
        with (
            patch.object(agent, "check_tamper", return_value=tamper_result),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "start_lock_guardian") as mock_guardian,
            patch.object(agent, "encrypt_folder", return_value=[]) as mock_encrypt,
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "generate_key", return_value=b"fake-key-base64=="),
        ):
            assert not tmp_sentinel.exists()
            agent._run_tamper_check(cfg, "stolen")
            # Sentinel should be created (re-lock happened)
            assert tmp_sentinel.exists()
            mock_lock.assert_called_once()
            mock_guardian.assert_called_once()
            mock_encrypt.assert_called_once()

    def test_relock_triggered_when_locked_and_tampered(self, cfg, tmp_sentinel):
        """When tamper is detected and status is 'locked', re-lock should fire."""
        tamper_result = {
            "files_missing": [],
            "service_missing": True,
            "task_missing": False,
            "tampered": True,
        }
        with (
            patch.object(agent, "check_tamper", return_value=tamper_result),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder", return_value=[]) as mock_encrypt,
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "generate_key", return_value=b"fake-key-base64=="),
        ):
            agent._run_tamper_check(cfg, "locked")
            assert tmp_sentinel.exists()
            mock_lock.assert_called_once()
            mock_encrypt.assert_called_once()

    def test_no_relock_when_active_and_tampered(self, cfg, tmp_sentinel):
        """When tamper is detected but status is 'active', no re-lock should fire."""
        tamper_result = {
            "files_missing": [".deadman"],
            "service_missing": False,
            "task_missing": False,
            "tampered": True,
        }
        with (
            patch.object(agent, "check_tamper", return_value=tamper_result),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "encrypt_folder") as mock_encrypt,
        ):
            agent._run_tamper_check(cfg, "active")
            mock_lock.assert_not_called()
            mock_encrypt.assert_not_called()
            assert not tmp_sentinel.exists()

    def test_relock_skips_encryption_when_sentinel_exists(self, cfg, tmp_sentinel):
        """When sentinel already exists, re-lock should re-apply lock screen but not encrypt."""
        tamper_result = {
            "files_missing": [],
            "service_missing": True,
            "task_missing": False,
            "tampered": True,
        }
        # Create sentinel so the "already locked" path is taken
        tmp_sentinel.write_text(json.dumps({"locked": True}))
        try:
            with (
                patch.object(agent, "check_tamper", return_value=tamper_result),
                patch.object(agent, "apply_lock_screen") as mock_lock,
                patch.object(agent, "start_lock_guardian") as mock_guardian,
                patch.object(agent, "encrypt_folder") as mock_encrypt,
            ):
                agent._run_tamper_check(cfg, "stolen")
                mock_lock.assert_called_once()
                mock_guardian.assert_called_once()
                mock_encrypt.assert_not_called()
        finally:
            if tmp_sentinel.exists():
                tmp_sentinel.unlink()

    def test_relock_triggered_when_tracking_and_tampered(self, cfg, tmp_sentinel):
        """When tamper is detected and status is 'tracking', re-lock should fire."""
        tamper_result = {
            "files_missing": [],
            "service_missing": False,
            "task_missing": True,
            "tampered": True,
        }
        with (
            patch.object(agent, "check_tamper", return_value=tamper_result),
            patch.object(agent, "apply_lock_screen") as mock_lock,
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "encrypt_folder", return_value=[]) as mock_encrypt,
            patch.object(agent, "write_pending_ack"),
            patch.object(agent, "write_recovery_key"),
            patch.object(agent, "generate_key", return_value=b"fake-key-base64=="),
        ):
            agent._run_tamper_check(cfg, "tracking")
            assert tmp_sentinel.exists()
            mock_lock.assert_called_once()
            mock_encrypt.assert_called_once()


# ---------------------------------------------------------------------------
# Tests: TPM sealing is preferred when available
# ---------------------------------------------------------------------------


class TestTPMSealingPreferred:
    """Verify that TPM sealing is preferred over DPAPI when TPM is available."""

    def test_update_deadman_timer_uses_tpm_when_available(self):
        """update_deadman_timer should call seal_state when TPM is available."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            with (
                patch.object(agent, "is_tpm_available", return_value=True),
                patch.object(agent, "seal_state", return_value=b"TPM1\x00\x00") as mock_seal,
                patch.object(agent, "save_encrypted_state") as mock_dpapi,
            ):
                agent.update_deadman_timer("stolen")
                mock_seal.assert_called_once()
                mock_dpapi.assert_not_called()
                # File should be written with the TPM-sealed blob
                assert agent.DEADMAN_FILE.read_bytes() == b"TPM1\x00\x00"
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_reads_tpm_sealed(self):
        """_read_deadman_state should try TPM format first (magic 'TPM1')."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            # Write a fake TPM-sealed blob
            agent.DEADMAN_FILE.write_bytes(b"TPM1\x00\x00")
            fake_plaintext = json.dumps({"status": "stolen", "last_seen": 1234567890}).encode(
                "utf-8"
            )

            with (
                patch.object(agent, "is_tpm_sealed_blob", return_value=True),
                patch.object(agent, "unseal_state", return_value=fake_plaintext),
                patch.object(agent, "load_encrypted_state") as mock_dpapi_load,
            ):
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "stolen"
                assert state["last_seen"] == 1234567890
                # DPAPI should NOT be tried when TPM succeeds
                mock_dpapi_load.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_tpm_fail_secure(self):
        """If TPM unseal fails, _read_deadman_state should return fail-secure (stolen)."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            agent.DEADMAN_FILE.write_bytes(b"TPM1\x00\x00")
            with (
                patch.object(agent, "is_tpm_sealed_blob", return_value=True),
                patch.object(agent, "unseal_state", return_value=None),
            ):
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "stolen"
                assert state.get("corrupt") is True
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()


# ---------------------------------------------------------------------------
# Tests: DPAPI fallback when TPM is not available
# ---------------------------------------------------------------------------


class TestDPAPIFallback:
    """Verify that DPAPI is used when TPM is not available."""

    def test_update_deadman_timer_falls_back_to_dpapi(self):
        """When TPM is not available, update_deadman_timer should use DPAPI."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            with (
                patch.object(agent, "is_tpm_available", return_value=False),
                patch.object(agent, "seal_state") as mock_seal,
                patch.object(agent, "save_encrypted_state", return_value=True) as mock_dpapi,
            ):
                agent.update_deadman_timer("active")
                mock_seal.assert_not_called()
                if agent._STATE_CRYPTO_AVAILABLE:
                    mock_dpapi.assert_called_once()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_update_deadman_timer_falls_back_when_seal_fails(self):
        """When seal_state returns None, update_deadman_timer should fall back to DPAPI."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            with (
                patch.object(agent, "is_tpm_available", return_value=True),
                patch.object(agent, "seal_state", return_value=None) as mock_seal,
                patch.object(agent, "save_encrypted_state", return_value=True) as mock_dpapi,
            ):
                agent.update_deadman_timer("stolen")
                mock_seal.assert_called_once()
                if agent._STATE_CRYPTO_AVAILABLE:
                    mock_dpapi.assert_called_once()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_falls_back_to_dpapi(self):
        """When blob is not TPM-sealed, _read_deadman_state should try DPAPI."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            if agent._STATE_CRYPTO_AVAILABLE:
                from state_crypto import save_encrypted_state

                save_encrypted_state(
                    agent.DEADMAN_FILE,
                    {"last_seen": time.time(), "status": "stolen"},
                )
            else:
                agent.DEADMAN_FILE.write_text(
                    json.dumps({"last_seen": time.time(), "status": "stolen"})
                )

            with (
                patch.object(agent, "is_tpm_sealed_blob", return_value=False),
                patch.object(agent, "unseal_state") as mock_unseal,
            ):
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "stolen"
                # TPM unseal should NOT be called when blob is not TPM-sealed
                mock_unseal.assert_not_called()
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()

    def test_read_deadman_state_falls_back_to_plaintext(self):
        """When no crypto is available, _read_deadman_state should read plaintext."""
        if agent.DEADMAN_FILE.exists():
            agent.DEADMAN_FILE.unlink()
        try:
            agent.DEADMAN_FILE.write_text(json.dumps({"last_seen": 1234567890, "status": "active"}))
            with (
                patch.object(agent, "is_tpm_sealed_blob", return_value=False),
                patch.object(agent, "is_encrypted_state_file", return_value=False),
            ):
                state = agent._read_deadman_state()
                assert state is not None
                assert state["status"] == "active"
                assert state["last_seen"] == 1234567890
        finally:
            if agent.DEADMAN_FILE.exists():
                agent.DEADMAN_FILE.unlink()


# ---------------------------------------------------------------------------
# Tests: Import guards and platform compatibility
# ---------------------------------------------------------------------------


class TestImportGuards:
    """Verify that import guards work for platform-specific modules."""

    def test_tpm_seal_available_flag_is_bool(self):
        """_TPM_SEAL_AVAILABLE should be a boolean."""
        assert isinstance(agent._TPM_SEAL_AVAILABLE, bool)

    def test_tamper_protection_available_flag_is_bool(self):
        """_TAMPER_PROTECTION_AVAILABLE should be a boolean."""
        assert isinstance(agent._TAMPER_PROTECTION_AVAILABLE, bool)

    def test_check_tamper_stub_returns_no_tamper_when_unavailable(self):
        """When tamper_protection is not available, the stub should return no tamper."""
        if not agent._TAMPER_PROTECTION_AVAILABLE:
            result = agent.check_tamper(agent._STATE_DIR)
            assert result["tampered"] is False

    def test_is_tpm_available_stub_returns_false_when_unavailable(self):
        """When tpm_seal is not available, is_tpm_available stub should return False."""
        if not agent._TPM_SEAL_AVAILABLE:
            assert agent.is_tpm_available() is False
