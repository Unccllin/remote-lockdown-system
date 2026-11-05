"""Tests for the GUI installer's non-GUI logic.

Tests the hardware ID collection, enrollment, and installation
functions that are used by the SetupWizard class. The GUI itself
is not tested (tkinter requires a display).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# Test the hardware ID collection functions
def test_get_hostname():
    import installer_gui

    hostname = installer_gui.get_hostname()
    assert isinstance(hostname, str)
    assert len(hostname) > 0


def test_get_mac_address():
    import installer_gui

    mac = installer_gui.get_mac_address()
    # MAC may be None on some systems, but if present should be formatted
    if mac is not None:
        assert ":" in mac
        parts = mac.split(":")
        assert len(parts) == 6
        for part in parts:
            assert len(part) == 2
            int(part, 16)  # Should be valid hex


def test_get_serial_number_returns_none_on_non_windows(monkeypatch):
    import installer_gui

    monkeypatch.setattr("platform.system", lambda: "Linux")
    # On Linux without /sys/class/dmi/id/product_serial, returns None
    result = installer_gui.get_serial_number()
    # Either None or a string — depends on the test environment
    assert result is None or isinstance(result, str)


def test_get_hardware_uuid_returns_none_on_non_windows(monkeypatch):
    import installer_gui

    monkeypatch.setattr("platform.system", lambda: "Linux")
    result = installer_gui.get_hardware_uuid()
    assert result is None


def test_enroll_device_with_token_sends_hardware_ids():
    """Verify the enrollment payload includes hardware IDs."""
    import installer_gui

    mock_response = MagicMock()
    mock_response.status_code = 201
    mock_response.json.return_value = {
        "device": {"id": "dev-123", "hostname": "TEST-PC"},
        "api_key": "key-abc",
    }

    with patch("installer_gui.requests.post", return_value=mock_response) as mock_post:
        result = installer_gui.enroll_device_with_token(
            "https://example.com",
            "token-xyz",
            "TEST-PC",
            "Test Owner",
            hardware_uuid="uuid-123",
            mac_address="AA:BB:CC:DD:EE:FF",
            serial_number="SN12345",
        )

    # Verify the POST was called with the right URL and payload
    mock_post.assert_called_once()
    call_args = mock_post.call_args
    assert call_args[0][0] == "https://example.com/api/enroll/claim"

    payload = call_args[1]["json"]
    assert payload["token"] == "token-xyz"
    assert payload["hostname"] == "TEST-PC"
    assert payload["owner_name"] == "Test Owner"
    assert payload["hardware_uuid"] == "uuid-123"
    assert payload["mac_address"] == "AA:BB:CC:DD:EE:FF"
    assert payload["serial_number"] == "SN12345"

    assert result["device"]["id"] == "dev-123"
    assert result["api_key"] == "key-abc"


def test_enroll_device_with_token_handles_none_hardware_ids():
    """Verify None hardware IDs are sent as null in the payload."""
    import installer_gui

    mock_response = MagicMock()
    mock_response.status_code = 201
    mock_response.json.return_value = {
        "device": {"id": "dev-456", "hostname": "TEST-PC2"},
        "api_key": "key-def",
    }

    with patch("installer_gui.requests.post", return_value=mock_response) as mock_post:
        installer_gui.enroll_device_with_token(
            "https://example.com",
            "token-xyz",
            "TEST-PC2",
            "Test Owner",
            hardware_uuid=None,
            mac_address=None,
            serial_number=None,
        )

    payload = mock_post.call_args[1]["json"]
    assert payload["hardware_uuid"] is None
    assert payload["mac_address"] is None
    assert payload["serial_number"] is None


def test_enroll_device_with_token_expired():
    """Verify expired token raises a clear error message."""
    import installer_gui

    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.json.return_value = {"error": "Enrollment token has expired"}

    with patch("installer_gui.requests.post", return_value=mock_response):
        with pytest.raises(Exception, match="expired"):
            installer_gui.enroll_device_with_token(
                "https://example.com",
                "old-token",
                "TEST-PC",
                "Owner",
                None,
                None,
                None,
            )


def test_enroll_device_with_token_already_used():
    """Verify already-used token raises a clear error."""
    import installer_gui

    mock_response = MagicMock()
    mock_response.status_code = 401
    mock_response.json.return_value = {"error": "Invalid or already-used enrollment token"}

    with patch("installer_gui.requests.post", return_value=mock_response):
        with pytest.raises(Exception, match="rejected"):
            installer_gui.enroll_device_with_token(
                "https://example.com",
                "used-token",
                "TEST-PC",
                "Owner",
                None,
                None,
                None,
            )


def test_enroll_device_with_token_server_error():
    """Verify server errors are raised."""
    import installer_gui

    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"

    with patch("installer_gui.requests.post", return_value=mock_response):
        with pytest.raises(Exception, match="HTTP 500"):
            installer_gui.enroll_device_with_token(
                "https://example.com",
                "token",
                "TEST-PC",
                "Owner",
                None,
                None,
                None,
            )


def test_write_config_creates_file(tmp_path, monkeypatch):
    """Verify config.json is written with correct fields."""
    import installer_gui

    # Patch INSTALL_DIR and CONFIG_FILE to use tmp_path
    monkeypatch.setattr(installer_gui, "INSTALL_DIR", tmp_path)
    monkeypatch.setattr(installer_gui, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(installer_gui, "LOCKDOWN_FOLDER", tmp_path / "lockdown_folder")

    config_path = installer_gui.write_config(
        "https://example.com",
        "api-key-123",
        "TEST-PC",
        "dev-123",
        boot_lock_enabled=False,
    )

    assert config_path.exists()
    config = json.loads(config_path.read_text())
    assert config["server_url"] == "https://example.com"
    assert config["api_key"] == "api-key-123"
    assert config["hostname"] == "TEST-PC"
    assert config["device_id"] == "dev-123"
    assert config["boot_lock_enabled"] is False
    assert config["verify_tls"] is True


def test_write_config_with_boot_lock(tmp_path, monkeypatch):
    """Verify boot_lock_enabled=True is written correctly."""
    import installer_gui

    monkeypatch.setattr(installer_gui, "INSTALL_DIR", tmp_path)
    monkeypatch.setattr(installer_gui, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(installer_gui, "LOCKDOWN_FOLDER", tmp_path / "lockdown_folder")

    config_path = installer_gui.write_config(
        "https://example.com",
        "api-key-456",
        "TEST-PC",
        "dev-456",
        boot_lock_enabled=True,
    )

    config = json.loads(config_path.read_text())
    assert config["boot_lock_enabled"] is True


def test_find_agent_exe_not_found(tmp_path, monkeypatch):
    """Verify find_agent_exe returns None when no agent exe is present."""
    import installer_gui

    # Patch sys.frozen to False and __file__ to a tmp path
    monkeypatch.setattr(installer_gui.sys, "frozen", False, raising=False)
    monkeypatch.setattr(installer_gui, "__file__", str(tmp_path / "installer_gui.py"))
    monkeypatch.setattr(installer_gui.Path, "cwd", classmethod(lambda cls: tmp_path))

    result = installer_gui.find_agent_exe()
    assert result is None


def test_create_lockdown_folder(tmp_path, monkeypatch):
    """Verify lockdown folder is created with a README file."""
    import installer_gui

    monkeypatch.setattr(installer_gui, "LOCKDOWN_FOLDER", tmp_path / "lockdown_folder")

    installer_gui.create_lockdown_folder()

    assert (tmp_path / "lockdown_folder").exists()
    readme = tmp_path / "lockdown_folder" / "README.txt"
    assert readme.exists()
    assert "Remote Lockdown System" in readme.read_text()


def test_create_lockdown_folder_idempotent(tmp_path, monkeypatch):
    """Verify creating the folder twice doesn't overwrite the README."""
    import installer_gui

    monkeypatch.setattr(installer_gui, "LOCKDOWN_FOLDER", tmp_path / "lockdown_folder")

    installer_gui.create_lockdown_folder()
    # Modify the README
    readme = tmp_path / "lockdown_folder" / "README.txt"
    readme.write_text("CUSTOM CONTENT")
    # Create again — should not overwrite
    installer_gui.create_lockdown_folder()
    assert readme.read_text() == "CUSTOM CONTENT"


def test_install_files_copies_agent(tmp_path, monkeypatch):
    """Verify install_files copies the agent exe to the install dir."""
    import installer_gui

    # Create a fake agent exe
    src_agent = tmp_path / "agent_src" / "lockdown-agent.exe"
    src_agent.parent.mkdir()
    src_agent.write_text("FAKE AGENT BINARY")

    monkeypatch.setattr(installer_gui, "INSTALL_DIR", tmp_path / "install")
    monkeypatch.setattr(installer_gui, "AGENT_EXE_NAME", "lockdown-agent.exe")

    dest = installer_gui.install_files(src_agent)
    assert dest.exists()
    assert dest.read_text() == "FAKE AGENT BINARY"


def test_install_files_same_location(tmp_path, monkeypatch):
    """Verify install_files doesn't copy if already in the right place."""
    import installer_gui

    install_dir = tmp_path / "install"
    install_dir.mkdir()
    agent = install_dir / "lockdown-agent.exe"
    agent.write_text("EXISTING AGENT")

    monkeypatch.setattr(installer_gui, "INSTALL_DIR", install_dir)
    monkeypatch.setattr(installer_gui, "AGENT_EXE_NAME", "lockdown-agent.exe")

    dest = installer_gui.install_files(agent)
    assert dest == agent
    assert dest.read_text() == "EXISTING AGENT"


def test_run_hardware_tests_returns_dict():
    """Verify run_hardware_tests returns a dict (even on error)."""
    import installer_gui

    # The harness likely doesn't exist in the test environment
    result = installer_gui.run_hardware_tests()
    assert isinstance(result, dict)
    # Either has test results or an error key
    assert "error" in result or "encrypt" in result


# ---------------------------------------------------------------------------
# Verified binary downloads (x-content-sha256)
# ---------------------------------------------------------------------------
#
# The wizard downloads the agent and the lock-screen binary from the Worker and
# executes them. The Worker sends the digest of exactly the bytes it serves, so a
# truncated, corrupted or altered body has to be refused — the previous check was
# `size > 1000000`, which any wrong binary of the right size passes.


class _FakeResponse:
    """Minimal stand-in for requests' streaming response."""

    def __init__(self, status_code=200, body=b"", headers=None):
        self.status_code = status_code
        self._body = body
        self.headers = headers or {}

    def iter_content(self, chunk_size=65536):  # noqa: ARG002
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _digest(body: bytes) -> str:
    import hashlib

    return hashlib.sha256(body).hexdigest()


def _big_body(seed: bytes = b"A") -> bytes:
    """A body above MIN_BINARY_BYTES so the size floor is not what rejects it."""
    import installer_gui

    return seed * (installer_gui.MIN_BINARY_BYTES + 1)


def test_verified_download_writes_the_file_when_the_digest_matches(tmp_path):
    import installer_gui

    body = _big_body()
    resp = _FakeResponse(headers={"x-content-sha256": _digest(body)}, body=body)
    dest = tmp_path / "lockdown-agent.exe"

    with patch("installer_gui.requests.get", return_value=resp):
        result = installer_gui._download_verified("https://x/api/download/agent", dest)

    assert result == dest
    assert dest.read_bytes() == body
    # No partial file left behind.
    assert list(tmp_path.glob("*.part")) == []


def test_verified_download_rejects_a_body_that_does_not_match_the_digest(tmp_path):
    import installer_gui

    body = _big_body()
    wrong = _digest(b"something else entirely")
    resp = _FakeResponse(headers={"x-content-sha256": wrong}, body=body)
    dest = tmp_path / "lockdown-agent.exe"

    with patch("installer_gui.requests.get", return_value=resp):
        result = installer_gui._download_verified("https://x/api/download/agent", dest)

    assert result is None
    # A rejected binary must not be left where the installer would copy it from.
    assert not dest.exists()
    assert list(tmp_path.glob("*.part")) == []


def test_verified_download_rejects_a_response_without_a_digest(tmp_path):
    import installer_gui

    resp = _FakeResponse(headers={}, body=_big_body())
    dest = tmp_path / "lockdown-agent.exe"

    with patch("installer_gui.requests.get", return_value=resp):
        result = installer_gui._download_verified("https://x/api/download/agent", dest)

    assert result is None
    assert not dest.exists()


def test_verified_download_rejects_a_non_200(tmp_path):
    import installer_gui

    resp = _FakeResponse(status_code=404, headers={"x-content-sha256": "a" * 64})
    dest = tmp_path / "lockdown-agent.exe"

    with patch("installer_gui.requests.get", return_value=resp):
        result = installer_gui._download_verified("https://x/api/download/agent", dest)

    assert result is None
    assert not dest.exists()


def test_verified_download_rejects_a_truncated_body_even_with_a_matching_length(tmp_path):
    """A short body whose digest was computed over the short body still fails.

    This is the case a size check cannot see: the attacker truncates the payload
    and recomputes the digest. It must fail because the digest is not the one the
    server published for the real artefact — modelled here by sending the digest
    of the *intended* body while delivering a truncated one.
    """
    import installer_gui

    intended = _big_body()
    truncated = intended[:1000]
    resp = _FakeResponse(headers={"x-content-sha256": _digest(intended)}, body=truncated)
    dest = tmp_path / "lockdown-agent.exe"

    with patch("installer_gui.requests.get", return_value=resp):
        result = installer_gui._download_verified("https://x/api/download/agent", dest)

    assert result is None
    assert not dest.exists()


def test_download_agent_exe_uses_the_verified_path(tmp_path):
    import installer_gui

    body = _big_body()
    resp = _FakeResponse(headers={"x-content-sha256": _digest(body)}, body=body)

    with patch("installer_gui.requests.get", return_value=resp) as get:
        result = installer_gui.download_agent_exe("https://x", tmp_path)

    assert result == tmp_path / installer_gui.AGENT_EXE_NAME
    assert get.call_args[0][0] == "https://x/api/download/agent?platform=win"


def test_download_lockscreen_exe_uses_the_verified_path(tmp_path):
    import installer_gui

    body = _big_body()
    resp = _FakeResponse(headers={"x-content-sha256": _digest(body)}, body=body)

    with patch("installer_gui.requests.get", return_value=resp) as get:
        result = installer_gui.download_lockscreen_exe("https://x", tmp_path)

    assert result == tmp_path / "lockdown-lockscreen.exe"
    assert get.call_args[0][0] == "https://x/api/download/lockscreen"


# ---------------------------------------------------------------------------
# Headless install (--silent) — the path a PowerShell one-liner drives (S214)
# ---------------------------------------------------------------------------


def test_parser_accepts_the_silent_install_flags():
    import installer_gui

    args = installer_gui.build_parser().parse_args(
        [
            "--server-url",
            "https://lockdown.example.com",
            "--token",
            "TOKEN123",
            "--silent",
        ]
    )

    assert args.server_url == "https://lockdown.example.com"
    assert args.token == "TOKEN123"
    assert args.silent is True
    assert args.no_boot_lock is False


def test_silent_without_credentials_is_a_usage_error(monkeypatch):
    """--silent must not guess a server or a token: exit 2 with a message."""
    import installer_gui

    monkeypatch.setattr(installer_gui.platform, "system", lambda: "Windows")

    with pytest.raises(SystemExit) as exc:
        installer_gui.main(["--silent"])

    assert exc.value.code == 2


def test_run_headless_uses_the_same_primitives_the_wizard_uses(monkeypatch):
    """One implementation per step: the sequence the GUI performs, without tkinter."""
    import installer_gui

    calls = []
    monkeypatch.setattr(
        installer_gui,
        "enroll_device_with_token",
        lambda *a, **k: (
            calls.append(("enroll", a[1], a[4:7]))
            or {
                "device": {"id": "dev-1"},
                "api_key": "KEY",
            }
        ),
    )
    monkeypatch.setattr(
        installer_gui, "write_config", lambda *a, **k: calls.append(("write_config", a[1]))
    )
    # The identity the GUI reports. Omitting it made every run look like a brand-new
    # machine, so the same box enrolled twice (S216).
    monkeypatch.setattr(installer_gui, "get_hardware_uuid", lambda: "HW-UUID-1")
    monkeypatch.setattr(installer_gui, "get_mac_address", lambda: "AA-BB-CC-DD-EE-FF")
    monkeypatch.setattr(installer_gui, "get_serial_number", lambda: "SN-1")
    monkeypatch.setattr(
        installer_gui, "add_defender_exclusions", lambda: calls.append(("defender",))
    )
    monkeypatch.setattr(installer_gui, "find_agent_exe", lambda: "/agent.exe")
    monkeypatch.setattr(
        installer_gui, "install_files", lambda p: calls.append(("install_files", p)) or p
    )
    monkeypatch.setattr(installer_gui, "create_lockdown_folder", lambda: calls.append(("folder",)))
    monkeypatch.setattr(installer_gui, "install_service", lambda: (True, "ok"))
    monkeypatch.setattr(installer_gui, "launch_agent", lambda p: calls.append(("launch", p)))

    rc = installer_gui.run_headless("https://lockdown.example.com", "TOKEN123", "HOST-1")

    assert rc == 0
    # The token reached the claim, and the api_key the server issued reached the config.
    enroll = next(c for c in calls if c[0] == "enroll")
    assert enroll[1] == "TOKEN123"
    # hardware_uuid, mac, serial — all three, or the server cannot recognise the box.
    assert enroll[2] == ("HW-UUID-1", "AA-BB-CC-DD-EE-FF", "SN-1")
    assert ("write_config", "KEY") in calls
    # The service is installed before the agent is launched.
    assert calls.index(("install_files", "/agent.exe")) < calls.index(("launch", "/agent.exe"))


def test_run_headless_reports_failure_without_a_traceback(monkeypatch):
    import installer_gui

    def boom(*_a, **_k):
        raise Exception("Enrollment token already used — generate a new one")

    monkeypatch.setattr(installer_gui, "enroll_device_with_token", boom)

    rc = installer_gui.run_headless("https://x", "T", "HOST-1")

    assert rc == 1  # the operator gets one line, not a stack trace


# ---------------------------------------------------------------------------
# Plain-HTTP lab servers (S216)
# ---------------------------------------------------------------------------


def test_headless_refuses_http_without_the_override(monkeypatch, capsys):
    """The agent requires TLS; say so instead of installing an agent that dies."""
    import installer_gui

    called = []
    monkeypatch.setattr(
        installer_gui, "enroll_device_with_token", lambda *a, **k: called.append(1) or {}
    )

    rc = installer_gui.run_headless("http://192.168.1.43:3001", "TOK", "HOST-1")

    assert rc == 1
    assert called == []  # nothing was claimed
    out = capsys.readouterr().out
    assert "requires https://" in out
    assert "--allow-insecure-http" in out


def test_headless_accepts_http_with_the_override(monkeypatch):
    """With the explicit flag, verify_tls is written False so the agent will run."""
    import installer_gui

    seen = {}
    monkeypatch.setattr(
        installer_gui,
        "enroll_device_with_token",
        lambda *a, **k: {"device": {"id": "dev-1"}, "api_key": "KEY"},
    )
    monkeypatch.setattr(installer_gui, "get_hardware_uuid", lambda: "HW")
    monkeypatch.setattr(installer_gui, "get_mac_address", lambda: "MAC")
    monkeypatch.setattr(installer_gui, "get_serial_number", lambda: "SN")
    monkeypatch.setattr(installer_gui, "write_config", lambda *a, **k: seen.update(k) or True)
    monkeypatch.setattr(installer_gui, "add_defender_exclusions", lambda: None)
    monkeypatch.setattr(installer_gui, "find_agent_exe", lambda: "/agent.exe")
    monkeypatch.setattr(installer_gui, "install_files", lambda p: p)
    monkeypatch.setattr(installer_gui, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer_gui, "install_service", lambda: (True, "ok"))
    monkeypatch.setattr(installer_gui, "launch_agent", lambda p: None)

    rc = installer_gui.run_headless(
        "http://192.168.1.43:3001", "TOK", "HOST-1", allow_insecure_http=True
    )

    assert rc == 0
    assert seen["verify_tls"] is False


def test_write_config_keeps_tls_on_by_default(monkeypatch, tmp_path):
    import installer_gui

    monkeypatch.setattr(installer_gui, "CONFIG_FILE", tmp_path / "config.json")
    installer_gui.write_config("https://example.com", "KEY", "HOST", "dev-1")

    import json

    written = json.loads((tmp_path / "config.json").read_text())
    assert written["verify_tls"] is True


def test_launch_agent_does_not_start_a_second_instance(monkeypatch):
    """A task-started agent must not be duplicated by the installer (S216)."""
    import installer_gui

    monkeypatch.setattr(
        installer_gui.subprocess,
        "run",
        lambda *a, **k: type("R", (), {"stdout": "lockdown-agent.exe  7540 Console 1 1,234 K"})(),
    )
    spawned = []
    monkeypatch.setattr(installer_gui.subprocess, "Popen", lambda *a, **k: spawned.append(a))

    installer_gui.launch_agent(Path("/agent.exe"))

    assert spawned == []


def test_launch_agent_starts_when_nothing_is_running(monkeypatch):
    import installer_gui

    monkeypatch.setattr(
        installer_gui.subprocess,
        "run",
        lambda *a, **k: type("R", (), {"stdout": "INFO: No tasks are running"})(),
    )
    spawned = []
    monkeypatch.setattr(installer_gui.subprocess, "Popen", lambda *a, **k: spawned.append(a[0]))

    installer_gui.launch_agent(Path("/agent.exe"))

    assert spawned and spawned[0][0] == "/agent.exe"
