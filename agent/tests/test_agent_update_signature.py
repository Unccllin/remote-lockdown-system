"""S0.6 (B-006): detached-signature update verification tests.

The update path must verify a detached Ed25519 signature over
"v1:{version}:{sha256}" against a pinned update-domain public key —
a channel-delivered SHA-256 alone is self-certifying.
"""

import base64
import hashlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import agent


@pytest.fixture
def update_keypair(tmp_path):
    """Generate an Ed25519 keypair; return (private_key, pub_pem_path)."""
    priv = Ed25519PrivateKey.generate()
    pub_pem = priv.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    pem_path = tmp_path / "update_pub.pem"
    pem_path.write_bytes(pub_pem)
    return priv, pem_path


@pytest.fixture
def other_keypair():
    """A second keypair — stands in for a different key domain."""
    return Ed25519PrivateKey.generate()


def _sign(priv, version, sha256):
    sig = priv.sign(f"v1:{version}:{sha256}".encode())
    return base64.b64encode(sig).decode()


def _cfg_with_key(cfg, pem_path):
    cfg["update_public_key"] = str(pem_path)
    return cfg


class TestVerifyUpdateSignature:
    def test_valid_signature(self, cfg, update_keypair):
        priv, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        sig = _sign(priv, "1.0.0", "ab" * 32)
        assert agent.verify_update_signature(cfg, sig, "1.0.0", "ab" * 32)

    def test_wrong_version_rejected(self, cfg, update_keypair):
        priv, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        sig = _sign(priv, "1.0.0", "ab" * 32)
        assert not agent.verify_update_signature(cfg, sig, "9.9.9", "ab" * 32)

    def test_wrong_hash_rejected(self, cfg, update_keypair):
        priv, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        sig = _sign(priv, "1.0.0", "ab" * 32)
        assert not agent.verify_update_signature(cfg, sig, "1.0.0", "cd" * 32)

    def test_wrong_domain_key_rejected(self, cfg, update_keypair, other_keypair):
        """A signature by a different-domain key must not verify (S0.6)."""
        _, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        sig = _sign(other_keypair, "1.0.0", "ab" * 32)
        assert not agent.verify_update_signature(cfg, sig, "1.0.0", "ab" * 32)

    def test_missing_signature_rejected(self, cfg, update_keypair):
        _, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        assert not agent.verify_update_signature(cfg, "", "1.0.0", "ab" * 32)

    def test_garbage_signature_rejected(self, cfg, update_keypair):
        _, pem = update_keypair
        cfg = _cfg_with_key(cfg, pem)
        assert not agent.verify_update_signature(cfg, "!!!notbase64!!!", "1.0.0", "ab" * 32)

    def test_no_key_configured_rejected(self, cfg):
        cfg["update_public_key"] = ""
        sig = _sign(Ed25519PrivateKey.generate(), "1.0.0", "ab" * 32)
        assert not agent.verify_update_signature(cfg, sig, "1.0.0", "ab" * 32)

    def test_missing_key_file_rejected(self, cfg, update_keypair, tmp_path):
        priv, _ = update_keypair
        cfg["update_public_key"] = str(tmp_path / "nonexistent.pem")
        sig = _sign(priv, "1.0.0", "ab" * 32)
        assert not agent.verify_update_signature(cfg, sig, "1.0.0", "ab" * 32)


def _mock_download(content: bytes):
    resp = MagicMock()
    resp.iter_content.return_value = [content]
    resp.raise_for_status.return_value = None
    return resp


class TestDownloadUpdate:
    """End-to-end: download_update must fail closed when a pinned key is
    configured and the signature is missing/invalid."""

    @pytest.fixture
    def update_files(self, tmp_path):
        dl = tmp_path / ".update_downloaded"
        pend = tmp_path / ".update_pending"
        with (
            patch.object(agent, "UPDATE_DOWNLOAD_FILE", dl),
            patch.object(agent, "UPDATE_PENDING_FILE", pend),
        ):
            yield dl, pend

    def test_signed_update_accepted(self, cfg, update_keypair, update_files):
        priv, pem = update_keypair
        dl, pend = update_files
        cfg = _cfg_with_key(cfg, pem)
        content = b"fake-agent-binary-v2"
        sha = hashlib.sha256(content).hexdigest()
        sig = _sign(priv, "2.0.0", sha)
        with patch("agent.requests.get", return_value=_mock_download(content)):
            agent.download_update(cfg, "https://srv/dl", sha, "2.0.0", signature=sig)
        assert pend.exists()
        assert dl.read_bytes() == content

    def test_missing_signature_refused(self, cfg, update_keypair, update_files):
        _, pem = update_keypair
        dl, pend = update_files
        cfg = _cfg_with_key(cfg, pem)
        content = b"fake-agent-binary-v2"
        sha = hashlib.sha256(content).hexdigest()
        with patch("agent.requests.get", return_value=_mock_download(content)):
            agent.download_update(cfg, "https://srv/dl", sha, "2.0.0", signature="")
        assert not pend.exists()
        assert not dl.exists()

    def test_invalid_signature_refused(self, cfg, update_keypair, other_keypair, update_files):
        _, pem = update_keypair
        dl, pend = update_files
        cfg = _cfg_with_key(cfg, pem)
        content = b"fake-agent-binary-v2"
        sha = hashlib.sha256(content).hexdigest()
        # Signed by a different key — wrong domain
        sig = _sign(other_keypair, "2.0.0", sha)
        with patch("agent.requests.get", return_value=_mock_download(content)):
            agent.download_update(cfg, "https://srv/dl", sha, "2.0.0", signature=sig)
        assert not pend.exists()
        assert not dl.exists()

    def test_signature_for_different_binary_refused(self, cfg, update_keypair, update_files):
        """Attacker swaps binary but replays the real signature+hash fields
        — sig covers actual hash, so verification fails."""
        priv, pem = update_keypair
        dl, pend = update_files
        cfg = _cfg_with_key(cfg, pem)
        evil = b"evil-agent-binary"
        evil_sha = hashlib.sha256(evil).hexdigest()
        # Server's legit sig was over a different hash — replaying it must fail
        sig = _sign(priv, "2.0.0", "ab" * 32)
        with patch("agent.requests.get", return_value=_mock_download(evil)):
            agent.download_update(cfg, "https://srv/dl", evil_sha, "2.0.0", signature=sig)
        assert not pend.exists()

    def test_no_key_sha256_only_degraded(self, cfg, update_files):
        """No pinned key → legacy SHA-256 path still works (documented
        degraded mode) — no silent breakage for unprovisioned agents."""
        dl, pend = update_files
        cfg["update_public_key"] = ""
        content = b"fake-agent-binary-v2"
        sha = hashlib.sha256(content).hexdigest()
        with patch("agent.requests.get", return_value=_mock_download(content)):
            agent.download_update(cfg, "https://srv/dl", sha, "2.0.0", signature="")
        assert pend.exists()

    def test_same_key_both_domains_warns(self, cfg, update_keypair, update_files, caplog):
        """update_public_key == recovery_public_key logs a domain-separation
        warning (still verifies — warning, not a block)."""
        priv, pem = update_keypair
        dl, pend = update_files
        cfg = _cfg_with_key(cfg, pem)
        cfg["recovery_public_key"] = str(pem)
        content = b"fake-agent-binary-v2"
        sha = hashlib.sha256(content).hexdigest()
        sig = _sign(priv, "2.0.0", sha)
        import logging

        with (
            patch("agent.requests.get", return_value=_mock_download(content)),
            caplog.at_level(logging.WARNING),
        ):
            agent.download_update(cfg, "https://srv/dl", sha, "2.0.0", signature=sig)
        assert pend.exists()
        assert any("key domains" in r.message for r in caplog.records)

    def test_http_error_before_the_temp_file_exists_is_logged_not_raised(
        self, cfg, update_files, caplog
    ):
        """A 404 on the download URL must be logged, not raised.

        The temp file is only created after `requests.get()` returns, so a failure
        there used to reach the cleanup handler with the name unbound and raise
        UnboundLocalError — which is not in the except tuple, so it escaped
        download_update and aborted the agent's whole check cycle. Found by the
        Worker E2E, which is the first place that ever 404'd this URL.
        """
        import logging

        import requests

        _dl, pend = update_files
        cfg["update_public_key"] = ""

        with (
            patch("agent.requests.get", side_effect=requests.HTTPError("404 Client Error")),
            caplog.at_level(logging.ERROR),
        ):
            agent.download_update(cfg, "https://srv/dl", "a" * 64, "2.0.0")

        assert not pend.exists()
        assert any("Update download failed" in r.message for r in caplog.records)

    def test_connection_error_before_the_temp_file_exists_is_logged_not_raised(
        self, cfg, update_files, caplog
    ):
        """Same guard for a connect failure (no temp file was ever started)."""
        import logging

        import requests

        _dl, pend = update_files
        cfg["update_public_key"] = ""

        with (
            patch("agent.requests.get", side_effect=requests.ConnectionError("refused")),
            caplog.at_level(logging.ERROR),
        ):
            agent.download_update(cfg, "https://srv/dl", "a" * 64, "2.0.0")

        assert not pend.exists()
        assert any("Update download failed" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# update_verification_mode — the mode reported at check-in (S193)
# ---------------------------------------------------------------------------


def test_mode_is_sha256_only_when_no_key_is_pinned():
    """Unpinned: the hash served beside the binary is the only check."""
    assert agent.update_verification_mode({}) == "sha256-only"


def test_mode_is_signature_when_the_pinned_key_loads(update_keypair):
    """Pinned and readable: unsigned updates are refused."""
    _private, pub_path = update_keypair
    cfg = {"update_public_key": str(pub_path)}
    assert agent.update_verification_mode(cfg) == "signature"


def test_mode_reports_an_unreadable_pin_rather_than_sha256_only(tmp_path):
    """A configured-but-missing key refuses every update — say so.

    Reporting this state as "sha256-only" would tell the operator that updates
    are still being applied unauthenticated, when in fact none are applied at all.
    """
    cfg = {"update_public_key": str(tmp_path / "nope.pub")}
    assert agent.update_verification_mode(cfg) == "key-unreadable"


def test_checkin_reports_the_verification_mode(tmp_path, update_keypair):
    """Every check-in carries the mode, so the dashboard can show it per device."""
    _private, pub_path = update_keypair

    captured = {}

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"command": None}

    def _capture(endpoint, cfg, body, **_kwargs):
        captured["endpoint"] = endpoint
        captured["body"] = body
        return _Resp()

    cfg = {
        "hostname": "HOST-1",
        "server_url": "https://x",
        "verify_tls": True,
        "update_public_key": str(pub_path),
    }
    with patch.object(agent, "_post_with_fallback", _capture):
        agent.checkin(cfg)

    assert captured["endpoint"] == "/api/agent/checkin"
    assert captured["body"]["update_verification"] == "signature"
