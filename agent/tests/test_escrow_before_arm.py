"""Tests for S4 escrow-before-arm in handle_lockdown.

The agent must confirm the recovery key reached the server BEFORE it
encrypts any file. If escrow fails, handle_lockdown must:
  - NOT call encrypt_folder
  - remove the sentinel (so a retry can re-attempt)
  - mark the command 'failed' (pending_ack + ACK)
  - leave the device unlocked (recoverable, not locked-out)
"""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import agent

# Capture the REAL escrow_key before conftest's autouse stub replaces it.
# The endpoint-level tests below must exercise the actual function.
REAL_ESCROW_KEY = agent.escrow_key


@pytest.fixture
def cmd():
    return {"id": "cmd-escrow-1", "type": "lockdown"}


def _call_real_escrow(cfg, command_id, key_material):
    """Invoke the real escrow_key (bypassing the conftest default stub)."""
    return REAL_ESCROW_KEY(cfg, command_id, key_material)


class TestEscrowBeforeArm:
    def test_encrypt_not_called_when_escrow_fails(self, cfg, cmd):
        """Escrow failure must skip encrypt_folder entirely."""
        with (
            patch.object(agent, "report_location"),
            patch.object(agent, "escrow_key", return_value=False) as m_esc,
            patch.object(agent, "encrypt_folder") as m_enc,
            patch.object(agent, "ack_command") as m_ack,
        ):
            agent.handle_lockdown(cfg, cmd)
            m_esc.assert_called_once()
            m_enc.assert_not_called()
            # command marked failed, not executed
            assert m_ack.call_args[0][2] == "failed"

    def test_sentinel_removed_when_escrow_fails(self, cfg, cmd):
        """Sentinel is removed on escrow failure so a retry can lock."""
        with (
            patch.object(agent, "report_location"),
            patch.object(agent, "escrow_key", return_value=False),
            patch.object(agent, "ack_command"),
        ):
            agent.handle_lockdown(cfg, cmd)
            assert not cfg["lock_sentinel"].exists()

    def test_pending_ack_marked_failed_when_escrow_fails(self, cfg, cmd):
        """pending_ack records 'failed' so the server knows."""
        import json

        with (
            patch.object(agent, "report_location"),
            patch.object(agent, "escrow_key", return_value=False),
            patch.object(agent, "ack_command"),
        ):
            agent.handle_lockdown(cfg, cmd)
            state = json.loads(cfg["pending_ack_file"].read_text())
            assert state["result_status"] == "failed"

    def test_encrypt_called_after_successful_escrow(self, cfg, cmd):
        """On escrow success, encrypt_folder runs (ordering preserved)."""
        calls = []

        def fake_escrow(c, cid, km):
            calls.append("escrow")
            return True

        def fake_enc(folder, key):
            calls.append("encrypt")
            return []

        with (
            patch.object(agent, "report_location"),
            patch.object(agent, "escrow_key", side_effect=fake_escrow),
            patch.object(agent, "encrypt_folder", side_effect=fake_enc),
            patch.object(agent, "apply_lock_screen"),
            patch.object(agent, "start_lock_guardian"),
            patch.object(agent, "ack_command", return_value=True),
        ):
            agent.handle_lockdown(cfg, cmd)
            assert calls == ["escrow", "encrypt"], calls

    def test_escrow_key_posts_to_endpoint(self, cfg):
        """escrow_key hits /api/agent/escrow-key and returns True on 2xx."""
        from unittest.mock import MagicMock

        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"escrowed": True}
        with patch.object(agent, "_post_with_fallback", return_value=resp) as m_post:
            ok = _call_real_escrow(cfg, "cmd-1", "a2V5")
            assert ok is True
            # verify the right endpoint + payload was used
            assert m_post.call_args[0][0] == "/api/agent/escrow-key"
            assert m_post.call_args[0][2]["key_material"] == "a2V5"
            assert m_post.call_args[0][2]["command_id"] == "cmd-1"

    def test_escrow_key_false_on_network_error(self, cfg):
        """escrow_key returns False (not raises) on network failure."""
        import requests as real_requests

        with patch.object(
            agent, "_post_with_fallback", side_effect=real_requests.RequestException("down")
        ):
            assert _call_real_escrow(cfg, "cmd-1", "a2V5") is False

    def test_escrow_key_false_on_rejected_body(self, cfg):
        """escrow_key returns False when server body lacks escrowed:true."""
        from unittest.mock import MagicMock

        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"escrowed": False, "error": "no"}
        with patch.object(agent, "_post_with_fallback", return_value=resp):
            assert _call_real_escrow(cfg, "cmd-1", "a2V5") is False
