"""Tests for the agent installer's enrollment token flow.

Covers:
  - enroll_device_with_token() sends the token to /api/enroll/claim
  - --token CLI argument selects the claim flow (no admin token needed)
  - --admin-token still works (backward compatibility)
  - Error handling for expired / invalid / reused tokens
"""

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

# installer.py is in the parent directory. It is loaded by path, not by bare
# import: the repo root also contains an installer/ directory (the NSIS sources),
# so `import installer` is ambiguous to static tooling and every installer.*
# attribute reads as missing. The module is still registered under `installer`
# because the string patches below ("installer.requests.post") resolve it there.
AGENT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(AGENT_DIR))

if "installer" not in sys.modules:
    import importlib.util

    # Typed Any: spec/loader are Optional in the stubs, and this loader is test
    # plumbing whose failure mode is an ImportError at collection time.
    _spec: Any = importlib.util.spec_from_file_location("installer", AGENT_DIR / "installer.py")
    _loaded = importlib.util.module_from_spec(_spec)
    sys.modules["installer"] = _loaded
    _spec.loader.exec_module(_loaded)

installer: Any = sys.modules["installer"]

# ---------------------------------------------------------------------------
# enroll_device_with_token
# ---------------------------------------------------------------------------


def _mock_response(status_code=201, json_data=None):
    """Create a mock requests.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_data or {}
    resp.text = str(json_data or {})
    return resp


@patch("installer.requests.post")
def test_enroll_with_token_posts_to_claim_endpoint(mock_post):
    """enroll_device_with_token calls POST /api/enroll/claim with the token."""
    mock_post.return_value = _mock_response(
        201,
        {
            "device": {"id": "dev-1", "hostname": "HOST", "status": "active"},
            "api_key": "secret-key",
        },
    )

    result = installer.enroll_device_with_token(
        "https://example.com",
        "my-token",
        "HOST",
        "Owner",
    )

    # Verify the URL is the claim endpoint
    call_args = mock_post.call_args
    assert "/api/enroll/claim" in call_args[0][0]
    # Verify the token is in the payload, not in the Authorization header
    payload = call_args[1]["json"]
    assert payload["token"] == "my-token"
    assert payload["hostname"] == "HOST"
    assert payload["owner_name"] == "Owner"
    # No Authorization header (token replaces admin password)
    headers = call_args[1]["headers"]
    assert "Authorization" not in headers

    # Verify return shape
    assert result["device"]["id"] == "dev-1"
    assert result["api_key"] == "secret-key"


@patch("installer.requests.post")
def test_enroll_with_token_expired_raises(mock_post):
    """Expired token produces a clear error message."""
    mock_post.return_value = _mock_response(401, {"error": "Enrollment token has expired"})

    with pytest.raises(Exception, match="expired"):
        installer.enroll_device_with_token(
            "https://example.com",
            "expired-token",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_already_used_tells_the_operator_to_get_a_new_one(mock_post):
    """A spent token is not a typo: tokens are single-use, so say what to do.

    The server distinguishes "invalid" from "already used" (S211); the installer
    used to collapse both into "may be invalid or already used", which leaves the
    operator guessing after a retry.
    """
    mock_post.return_value = _mock_response(
        401, {"error": "Enrollment token already used — generate a new one"}
    )

    with pytest.raises(Exception, match="generate a new token"):
        installer.enroll_device_with_token("https://example.com", "spent", "HOST", "Owner")


@patch("installer.requests.post")
def test_enroll_with_token_accepts_a_re_association(mock_post):
    """HTTP 200 with reassociated=true is success, not failure (S211).

    Re-running the installer on a machine whose hardware identity is already
    enrolled makes the server re-issue credentials and answer 200. The installer
    required exactly 201, so a perfectly good re-enrolment reported
    "Enrollment failed (HTTP 200)".
    """
    mock_post.return_value = _mock_response(
        200,
        {
            "device": {"id": "dev-1", "hostname": "HOST", "status": "active"},
            "api_key": "secret-key",
            "reassociated": True,
        },
    )

    result = installer.enroll_device_with_token(
        "https://example.com", "fresh-token", "HOST", "Owner"
    )

    assert result["api_key"] == "secret-key"
    assert result["reassociated"] is True


@patch("installer.requests.post")
def test_enroll_with_token_invalid_raises(mock_post):
    """Invalid/used token produces a rejection error."""
    mock_post.return_value = _mock_response(
        401, {"error": "Invalid or already-used enrollment token"}
    )

    with pytest.raises(Exception, match="rejected"):
        installer.enroll_device_with_token(
            "https://example.com",
            "bad-token",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_connection_error(mock_post):
    """Connection error is raised as a clear message."""
    import requests

    mock_post.side_effect = requests.exceptions.ConnectionError("boom")

    with pytest.raises(Exception, match="Cannot reach server"):
        installer.enroll_device_with_token(
            "https://example.com",
            "tok",
            "HOST",
            "Owner",
        )


@patch("installer.requests.post")
def test_enroll_with_token_timeout(mock_post):
    """Timeout is raised as a clear message."""
    import requests

    mock_post.side_effect = requests.exceptions.Timeout()

    with pytest.raises(Exception, match="30 seconds"):
        installer.enroll_device_with_token(
            "https://example.com",
            "tok",
            "HOST",
            "Owner",
        )


# ---------------------------------------------------------------------------
# Backward compatibility: --admin-token still uses /api/enroll
# ---------------------------------------------------------------------------


@patch("installer.requests.post")
def test_enroll_with_admin_token_uses_enroll_endpoint(mock_post):
    """The legacy --admin-token flow still calls POST /api/enroll."""
    mock_post.return_value = _mock_response(
        201,
        {
            "device": {"id": "dev-2", "hostname": "HOST2", "status": "active"},
            "api_key": "legacy-key",
        },
    )

    result = installer.enroll_device(
        "https://example.com",
        "admin-pass",
        "HOST2",
        "Owner2",
    )

    call_args = mock_post.call_args
    assert "/api/enroll" in call_args[0][0]
    assert "/api/enroll/claim" not in call_args[0][0]
    # Admin token goes in the Authorization header
    headers = call_args[1]["headers"]
    assert headers["Authorization"] == "Bearer admin-pass"
    # No token field in the payload
    payload = call_args[1]["json"]
    assert "token" not in payload

    assert result["api_key"] == "legacy-key"


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


def test_argparse_accepts_token_argument():
    """The --token argument is recognized by the real parser."""
    args = installer.build_parser().parse_args(["--token", "abc123", "--server-url", "https://x"])
    assert args.token == "abc123"
    assert args.admin_token is None
    assert args.uninstall is False


def test_argparse_accepts_admin_token_argument():
    """The --admin-token argument is still recognized (backward compat)."""
    args = installer.build_parser().parse_args(
        ["--admin-token", "secret", "--server-url", "https://x"]
    )
    assert args.admin_token == "secret"
    assert args.token is None


def test_argparse_accepts_uninstall_arguments():
    """--uninstall and --uninstall-token exist on the real parser.

    The generic NSIS uninstaller calls exactly this pair, so a rename here
    silently breaks removal (the wrapper only sees a non-zero exit code).
    """
    args = installer.build_parser().parse_args(["--uninstall", "--uninstall-token", "tok-123"])
    assert args.uninstall is True
    assert args.uninstall_token == "tok-123"


# ---------------------------------------------------------------------------
# run_uninstall — server-authorized removal
# ---------------------------------------------------------------------------


def _write_config(tmp_path, monkeypatch, **overrides):
    """Point installer.CONFIG_FILE at a temp config.json and write it."""
    import json

    config = {
        "server_url": "https://backend.example",
        "api_key": "device-key",
        "hostname": "TEST-HOST",
        "device_id": "dev-9",
    }
    config.update(overrides)
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(config))
    monkeypatch.setattr(installer, "CONFIG_FILE", cfg_path)
    return cfg_path


def test_run_uninstall_without_config_refuses(tmp_path, monkeypatch, capsys):
    """Nothing installed → exit 1 and say so, before asking for a token."""
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "config.json")

    assert installer.run_uninstall("tok") == 1
    assert "nothing is installed" in capsys.readouterr().out


def test_run_uninstall_without_token_does_not_touch_persistence(tmp_path, monkeypatch, capsys):
    """No token → exit 1, and no call reaches service_installer.uninstall().

    This is the tamper-bypass guard: an unauthenticated removal must not even be
    attempted, because a *failed* attempt still resets nothing but logs a local
    admin's attempt as the thing to retry.
    """
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall(None) == 1
    fake.uninstall.assert_not_called()
    out = capsys.readouterr().out
    assert "uninstall token is required" in out
    assert "/api/agent/uninstall-auth" in out


def test_run_uninstall_passes_config_values_to_service_installer(tmp_path, monkeypatch):
    """The token, backend URL, API key and device id come from config.json."""
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    fake.uninstall.return_value = True
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("tok-abc") == 0
    fake.uninstall.assert_called_once_with(
        uninstall_token="tok-abc",
        server_url="https://backend.example",
        api_key="device-key",
        device_id="dev-9",
    )


def test_run_uninstall_reports_backend_refusal(tmp_path, monkeypatch, capsys):
    """When the backend refuses the token, exit 1 and say nothing was removed."""
    _write_config(tmp_path, monkeypatch)
    fake = MagicMock()
    fake.uninstall.return_value = False
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("stale-token") == 1
    assert "did not authorize" in capsys.readouterr().out


def test_run_uninstall_requires_server_url_and_api_key(tmp_path, monkeypatch, capsys):
    """A config without credentials cannot verify a token → refuse."""
    _write_config(tmp_path, monkeypatch, api_key=None)
    fake = MagicMock()
    monkeypatch.setitem(sys.modules, "service_installer", fake)

    assert installer.run_uninstall("tok") == 1
    fake.uninstall.assert_not_called()
    assert "cannot verify" in capsys.readouterr().out


def test_run_uninstall_reports_corrupt_config(tmp_path, monkeypatch, capsys):
    """A malformed config.json is a refusal, not a traceback."""
    cfg = tmp_path / "config.json"
    cfg.write_text("{not json")
    monkeypatch.setattr(installer, "CONFIG_FILE", cfg)

    assert installer.run_uninstall("tok") == 1
    assert "Cannot read" in capsys.readouterr().out


def test_run_uninstall_without_service_installer_module(tmp_path, monkeypatch, capsys):
    """A build without service_installer refuses instead of half-removing."""
    _write_config(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "service_installer", None)

    assert installer.run_uninstall("tok") == 1
    assert "service_installer" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# --config-file — the per-device install path (no enrolment, no token)
# ---------------------------------------------------------------------------


def _baked(path, **overrides):
    """Write a per-device config.json like the dashboard generates."""
    import json

    data = {
        "server_url": "https://backend.example/",
        "device_hostname": "BAKED-HOST",
        "api_key": "baked-key",
        "poll_interval": 30,
        "boot_lock_enabled": False,
    }
    data.update(overrides)
    path.write_text(json.dumps(data))
    return path


def test_load_baked_config_accepts_the_dashboard_shape(tmp_path):
    """device_hostname + api_key are what the server's generator emits."""
    loaded = installer.load_baked_config(_baked(tmp_path / "c.json"))

    assert loaded["server_url"] == "https://backend.example/"
    assert loaded["hostname"] == "BAKED-HOST"
    assert loaded["api_key"] == "baked-key"
    assert loaded["boot_lock_enabled"] is False


def test_load_baked_config_accepts_the_enrolled_keys(tmp_path):
    """A config from the enrolment flow (hostname/agent_key) works too."""
    path = _baked(tmp_path / "c.json")
    path.write_text(
        '{"server_url": "https://x", "hostname": "H", "agent_key": "k", "device_id": "dev-1"}'
    )

    loaded = installer.load_baked_config(path)
    assert (loaded["hostname"], loaded["api_key"], loaded["device_id"]) == ("H", "k", "dev-1")


def test_load_baked_config_rejects_a_config_without_the_api_key(tmp_path):
    path = _baked(tmp_path / "c.json")
    path.write_text('{"server_url": "https://x", "hostname": "H"}')

    with pytest.raises(ValueError, match="server_url and api_key"):
        installer.load_baked_config(path)


def test_load_baked_config_reports_a_missing_file(tmp_path):
    with pytest.raises(ValueError, match="not found"):
        installer.load_baked_config(tmp_path / "nope.json")


def test_run_baked_install_writes_the_full_normalised_config(tmp_path, monkeypatch):
    """The baked path must produce the same 12 keys as the enrolment path.

    The generated per-device config carries 8 keys; the agent then falls back to
    its own defaults, which put the lockdown folder somewhere else than an
    enrolled install does. Normalising here is what keeps the two identical.
    """
    import json

    cfg = _baked(tmp_path / "baked.json")
    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "installed")
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "installed" / "config.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: tmp_path / "lockdown-agent.exe")
    monkeypatch.setattr(installer, "install_files", lambda p: p)
    monkeypatch.setattr(installer, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: True)
    monkeypatch.setattr(installer, "verify_checkin", lambda url, key: True)
    monkeypatch.setattr(installer, "print_summary", lambda *a, **k: None)

    assert installer.run_baked_install(cfg) == 0

    written = json.loads((tmp_path / "installed" / "config.json").read_text())
    assert set(written) == set(installer.build_config("https://x", "k", "h", "d"))
    assert written["api_key"] == "baked-key"
    # The trailing slash in the generated server_url is normalised away, exactly
    # as the enrolment path does.
    assert written["server_url"] == "https://backend.example"
    # boot_lock_enabled came from the baked config, not the default.
    assert written["boot_lock_enabled"] is False


def test_run_baked_install_honours_a_boot_lock_override(tmp_path, monkeypatch):
    """--no-boot-lock wins over the baked value."""
    import json

    cfg = _baked(tmp_path / "baked.json", boot_lock_enabled=True)
    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "installed")
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "installed" / "config.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: tmp_path / "lockdown-agent.exe")
    monkeypatch.setattr(installer, "install_files", lambda p: p)
    monkeypatch.setattr(installer, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: True)
    monkeypatch.setattr(installer, "verify_checkin", lambda url, key: True)
    monkeypatch.setattr(installer, "print_summary", lambda *a, **k: None)

    assert installer.run_baked_install(cfg, boot_lock_enabled=False) == 0
    written = json.loads((tmp_path / "installed" / "config.json").read_text())
    assert written["boot_lock_enabled"] is False


def test_run_baked_install_refuses_without_the_agent_binary(tmp_path, monkeypatch, capsys):
    cfg = _baked(tmp_path / "baked.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: pytest.fail("must not install"))

    assert installer.run_baked_install(cfg) == 1
    assert "Cannot find" in capsys.readouterr().out


def test_argparse_accepts_config_file():
    args = installer.build_parser().parse_args(["--config-file", "c.json", "--silent"])
    assert args.config_file == "c.json"
    assert args.silent is True


# ---------------------------------------------------------------------------
# Update-key pinning — only ever named when the file exists (S193)
# ---------------------------------------------------------------------------


def test_build_config_omits_the_pin_by_default():
    """No key staged → no update_public_key key at all.

    A configured path that does not exist makes the agent refuse *every* update
    (it fails closed on a pinned key), so "unpinned" must be an absent key, never
    a path to nothing.
    """
    cfg = installer.build_config("https://x", "k", "h", "d")
    assert "update_public_key" not in cfg


def test_build_config_records_the_pin_when_one_is_given():
    cfg = installer.build_config("https://x", "k", "h", "d", update_public_key="/k.pub")
    assert cfg["update_public_key"] == "/k.pub"


def test_staged_update_key_is_empty_without_a_file(tmp_path):
    assert installer.staged_update_public_key(tmp_path) == ""


def test_staged_update_key_returns_the_path_when_staged(tmp_path):
    key = tmp_path / installer.UPDATE_KEY_FILENAME
    key.write_text("-----BEGIN PUBLIC KEY-----\n")

    assert installer.staged_update_public_key(tmp_path) == str(key)


def test_run_baked_install_pins_a_staged_key(tmp_path, monkeypatch):
    import json

    cfg = _baked(tmp_path / "baked.json")
    key = tmp_path / "inst" / installer.UPDATE_KEY_FILENAME
    key.parent.mkdir(parents=True)
    key.write_text("-----BEGIN PUBLIC KEY-----\n")

    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "inst")
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "inst" / "config.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: tmp_path / "lockdown-agent.exe")
    monkeypatch.setattr(installer, "install_files", lambda p: p)
    monkeypatch.setattr(installer, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: True)
    monkeypatch.setattr(installer, "verify_checkin", lambda url, key: True)
    monkeypatch.setattr(installer, "print_summary", lambda *a, **k: None)
    monkeypatch.setattr(installer, "staged_update_public_key", lambda *a: str(key))

    assert installer.run_baked_install(cfg) == 0
    written = json.loads((tmp_path / "inst" / "config.json").read_text())
    assert written["update_public_key"] == str(key)


def test_run_baked_install_leaves_updates_unpinned_without_a_key(tmp_path, monkeypatch):
    """No key staged → the config must not name one, or updates stop entirely."""
    import json

    cfg = _baked(tmp_path / "baked.json")
    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "inst")
    monkeypatch.setattr(installer, "CONFIG_FILE", tmp_path / "inst" / "config.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: tmp_path / "lockdown-agent.exe")
    monkeypatch.setattr(installer, "install_files", lambda p: p)
    monkeypatch.setattr(installer, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: True)
    monkeypatch.setattr(installer, "verify_checkin", lambda url, key: True)
    monkeypatch.setattr(installer, "print_summary", lambda *a, **k: None)
    monkeypatch.setattr(installer, "staged_update_public_key", lambda *a: "")

    assert installer.run_baked_install(cfg) == 0
    written = json.loads((tmp_path / "inst" / "config.json").read_text())
    assert "update_public_key" not in written


def test_install_update_public_key_copies_the_key_into_the_install_dir(tmp_path, monkeypatch):
    """The pin must name a path that outlives the install run.

    The staged key normally sits in the download folder. Naming that path works
    until the folder is cleaned — and then the agent fails closed on a configured
    key it cannot read and stops patching entirely.
    """
    install_dir = tmp_path / "ProgramData" / "LockdownAgent"
    downloads = tmp_path / "Downloads"
    downloads.mkdir()
    staged = downloads / installer.UPDATE_KEY_FILENAME
    staged.write_text("-----BEGIN PUBLIC KEY-----\n")

    monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)

    pinned = installer.install_update_public_key(staged)

    assert pinned == str(install_dir / installer.UPDATE_KEY_FILENAME)
    assert (install_dir / installer.UPDATE_KEY_FILENAME).read_text() == (
        "-----BEGIN PUBLIC KEY-----\n"
    )
    # The named path is the installed copy, not the download folder.
    assert downloads not in Path(pinned).parents


def test_install_update_public_key_is_empty_when_nothing_is_staged(tmp_path, monkeypatch):
    monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "inst")

    assert installer.install_update_public_key(tmp_path / "absent.pub") == ""


def test_baked_install_pins_the_installed_copy_not_the_download_folder(tmp_path, monkeypatch):
    """End to end: a key next to the baked config is installed and then named."""
    import json

    install_dir = tmp_path / "ProgramData" / "LockdownAgent"
    downloads = tmp_path / "Downloads"
    downloads.mkdir()
    cfg = _baked(downloads / "config.json")
    (downloads / installer.UPDATE_KEY_FILENAME).write_text("-----BEGIN PUBLIC KEY-----\n")

    monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)
    monkeypatch.setattr(installer, "CONFIG_FILE", install_dir / "config.json")
    monkeypatch.setattr(installer, "find_agent_exe", lambda: tmp_path / "lockdown-agent.exe")
    monkeypatch.setattr(installer, "install_files", lambda p: p)
    monkeypatch.setattr(installer, "create_lockdown_folder", lambda: None)
    monkeypatch.setattr(installer, "install_service", lambda: True)
    monkeypatch.setattr(installer, "verify_checkin", lambda url, key: True)
    monkeypatch.setattr(installer, "print_summary", lambda *a, **k: None)
    monkeypatch.setattr(installer, "staged_update_public_key", lambda *a: "")

    assert installer.run_baked_install(cfg) == 0

    written = json.loads((install_dir / "config.json").read_text())
    assert written["update_public_key"] == str(install_dir / installer.UPDATE_KEY_FILENAME)
    assert (install_dir / installer.UPDATE_KEY_FILENAME).is_file()
    # The download copy is irrelevant once installed — a cleaned folder changes nothing.
    (downloads / installer.UPDATE_KEY_FILENAME).unlink()
    assert Path(written["update_public_key"]).is_file()


# ---------------------------------------------------------------------------
# No backend is baked in (S213)
# ---------------------------------------------------------------------------


def test_no_default_server_url_is_compiled_in():
    """The installers must not default to any backend.

    Both used to default to the deployed Worker. A self-hosted operator pasted a
    token minted by *their* server, the claim went to the Worker, and the reply was
    401 "token rejected" — while their own server saw no request at all. A wrong
    default that looks filled in is worse than an empty field.
    """
    import installer_gui

    assert installer.DEFAULT_SERVER_URL == ""
    assert installer_gui.DEFAULT_SERVER_URL == ""


def test_silent_mode_without_a_server_url_fails_with_guidance(monkeypatch):
    """--silent + --token alone must say what is missing instead of guessing."""
    monkeypatch.setattr(sys, "argv", ["installer", "--silent", "--token", "TOK"])

    with pytest.raises(SystemExit) as exc:
        installer.main()

    # Exit code 1 (usage failure), not a network error deeper in.
    assert exc.value.code == 1
