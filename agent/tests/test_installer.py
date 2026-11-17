"""Tests for the agent installer's enrollment token flow.

Covers:
  - enroll_device_with_token() sends the token to /api/enroll/claim
  - --token CLI argument selects the claim flow (no admin token needed)
  - --admin-token still works (backward compatibility)
  - Error handling for expired / invalid / reused tokens
"""

import io
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


# ---------------------------------------------------------------------------
# Defender exclusions (S265)
#
# The CLI/service installer — the path the FRANKENSTEIN service install used —
# added no Defender exclusion at all, while the hardware harness only read
# Defender's *process* list. Two hardware windows therefore reported
# `defender_exclusion: null` for an install that had a path exclusion. These
# tests pin both halves: the installer must add path AND process exclusions, and
# the harness must read both lists.
# ---------------------------------------------------------------------------


def _fake_run_factory(returncode=0):
    calls = []

    def _fake_run(cmd, **kwargs):
        calls.append(cmd)
        result = MagicMock()
        result.returncode = returncode
        result.stdout = ""
        result.stderr = ""
        return result

    return _fake_run, calls


def test_defender_exclusions_add_path_and_process_entries(monkeypatch):
    """Both exclusion kinds are added — they are not interchangeable."""
    fake_run, calls = _fake_run_factory()
    monkeypatch.setattr(installer.platform, "system", lambda: "Windows")
    monkeypatch.setattr(installer.subprocess, "run", fake_run)

    assert installer.add_defender_exclusions() is True

    scripts = [c[-1] for c in calls]
    path_entries = [s for s in scripts if "-ExclusionPath" in s]
    process_entries = [s for s in scripts if "-ExclusionProcess" in s]

    assert len(path_entries) == 2, scripts
    assert len(process_entries) == 2, scripts
    # The install directory is what the one-file executable unpacks into.
    assert any(str(installer.INSTALL_DIR) in s for s in path_entries)
    assert any(installer.AGENT_EXE_NAME in s for s in path_entries)
    assert any(installer.AGENT_EXE_NAME in s for s in process_entries)
    assert any(installer.LOCKSCREEN_EXE_NAME in s for s in process_entries)


def test_defender_exclusions_are_skipped_off_windows(monkeypatch):
    fake_run, calls = _fake_run_factory()
    monkeypatch.setattr(installer.platform, "system", lambda: "Linux")
    monkeypatch.setattr(installer.subprocess, "run", fake_run)

    assert installer.add_defender_exclusions() is False
    assert calls == []


def test_defender_exclusion_failure_is_a_warning_not_an_abort(monkeypatch, capsys):
    """A refused Add-MpPreference must not abandon an otherwise good install."""
    fake_run, calls = _fake_run_factory(returncode=1)
    monkeypatch.setattr(installer.platform, "system", lambda: "Windows")
    monkeypatch.setattr(installer.subprocess, "run", fake_run)

    assert installer.add_defender_exclusions() is False
    # Every entry was still attempted — one failure does not short-circuit.
    assert len(calls) == 4
    assert "0/4 added" in capsys.readouterr().out


def test_defender_exclusion_missing_powershell_does_not_raise(monkeypatch):
    def _raise(cmd, **kwargs):
        raise FileNotFoundError("powershell")

    monkeypatch.setattr(installer.platform, "system", lambda: "Windows")
    monkeypatch.setattr(installer.subprocess, "run", _raise)

    assert installer.add_defender_exclusions() is False


class TestConsoleEncoding:
    """The installer must not die on its own decoration.

    First live hardware test: lockdown-installer.exe crashed with

        UnicodeEncodeError: 'charmap' codec can't encode character '\u2713'

    because print_ok() prints a checkmark and the Windows console was cp1252. Because
    print_ok() is called from main() before any real work, the one-click installer was
    unrunnable on a stock Windows image -- the failure looked like a broken installer rather
    than a cosmetic encoding glitch. _make_console_safe() degrades the glyph instead.
    """

    @staticmethod
    def _cp1252_stdout():
        # errors="strict" reproduces the stock console: it raises rather than substituting.
        return io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict", newline="")

    def test_print_ok_survives_a_cp1252_console(self, monkeypatch):
        stream = self._cp1252_stdout()
        monkeypatch.setattr(installer.sys, "stdout", stream)

        installer._make_console_safe()
        installer.print_ok("Running as Administrator")  # must not raise
        stream.flush()

        written = stream.buffer.getvalue().decode("cp1252")
        assert "Running as Administrator" in written

    def test_all_decorated_helpers_survive(self, monkeypatch):
        stream = self._cp1252_stdout()
        monkeypatch.setattr(installer.sys, "stdout", stream)

        installer._make_console_safe()
        installer.print_ok("ok")
        installer.print_fail("fail")
        installer.print_warn("warn")
        installer.print_step(1, "step")
        stream.flush()
        assert "step" in stream.buffer.getvalue().decode("cp1252")

    def test_without_the_fix_the_glyph_would_raise(self, monkeypatch):
        """Pins the original defect: on a strict cp1252 stream print_ok() raises."""
        stream = self._cp1252_stdout()
        monkeypatch.setattr(installer.sys, "stdout", stream)

        with pytest.raises(UnicodeEncodeError):
            installer.print_ok("boom")

    def test_no_stdout_is_tolerated(self, monkeypatch):
        """A windowed build has stdout=None; the helper must not crash on it."""
        monkeypatch.setattr(installer.sys, "stdout", None)
        installer._make_console_safe()  # must not raise


class TestReinstallOverTamperProtection:
    """Re-installing must claim a hardened binary back before copying over it.

    S269: the agent sets `DELETE denied for Everyone` on its own exe, so a second
    install died with `PermissionError: ... lockdown-agent.exe` even as Administrator
    — there was no upgrade path at all.
    """

    def test_install_files_makes_an_existing_destination_writable(self, tmp_path, monkeypatch):
        dest_dir = tmp_path / "LockdownAgent"
        dest_dir.mkdir()
        dest = dest_dir / installer.AGENT_EXE_NAME
        dest.write_text("old", encoding="utf-8")

        source = tmp_path / "lockdown-agent.exe"
        source.write_text("new", encoding="utf-8")

        calls = []
        monkeypatch.setattr(installer, "INSTALL_DIR", dest_dir)
        monkeypatch.setattr(installer, "make_writable", lambda p: calls.append(p) or True)
        installer.install_files(source)

        assert calls == [dest], "the existing binary must be unlocked before the copy"
        assert dest.read_text(encoding="utf-8") == "new"


class TestServiceBinaryIsInstalledWithTheAgent:
    """The SCM runs `lockdown-service.exe` from the install directory, so an upgrade
    that copies only the agent leaves the service binary stale — and a *frozen* build
    has no service_host.py to fall back to.

    The replace also has to survive its own image being held open: the running service
    locks its exe, so the copy fails with ERROR_SHARING_VIOLATION. The served PowerShell
    one-liner used to do this copy itself and `$ErrorActionPreference = 'Stop'` aborted
    the whole run there — exit 1, installer never started, previous run's log printed as
    if it were this run's (S270 on MOLE). One owner, and it stops the service first.
    """

    def _stage(self, tmp_path: Path) -> tuple[Path, Path]:
        stage = tmp_path / "staging"
        stage.mkdir()
        agent = stage / installer.AGENT_EXE_NAME
        agent.write_text("agent", encoding="utf-8")
        service = stage / installer.SERVICE_EXE_NAME
        service.write_text("service", encoding="utf-8")
        return agent, service

    def test_staged_service_binary_is_copied_beside_the_agent(self, tmp_path, monkeypatch):
        agent, service = self._stage(tmp_path)
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)

        result = installer.install_service_binary(agent)

        assert result == install_dir / installer.SERVICE_EXE_NAME
        assert result.read_text(encoding="utf-8") == "service"

    def test_a_build_without_a_service_binary_is_not_an_error(self, tmp_path, monkeypatch):
        stage = tmp_path / "staging"
        stage.mkdir()
        agent = stage / installer.AGENT_EXE_NAME
        agent.write_text("agent", encoding="utf-8")
        monkeypatch.setattr(installer, "INSTALL_DIR", tmp_path / "LockdownAgent")

        assert installer.install_service_binary(agent) is None

    def test_a_locked_binary_stops_the_service_and_retries(self, tmp_path, monkeypatch):
        agent, _ = self._stage(tmp_path)
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        dest = install_dir / installer.SERVICE_EXE_NAME
        dest.write_text("stale", encoding="utf-8")
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)

        real_copy = installer.shutil.copy2
        attempts: list[int] = []
        stops: list[int] = []

        def flaky_copy(src: Any, dst: Any) -> Any:
            attempts.append(1)
            if len(attempts) == 1:
                # Real Windows text for ERROR_SHARING_VIOLATION (WinError 32).
                raise OSError(32, "The process cannot access the file")
            return real_copy(src, dst)

        monkeypatch.setattr(installer.shutil, "copy2", flaky_copy)
        monkeypatch.setattr(installer, "_stop_service_for_replace", lambda: stops.append(1) or True)

        installer.install_service_binary(agent)

        assert len(attempts) == 2, "the copy must be retried after the service stops"
        assert stops == [1], "the service must be stopped exactly once, before the retry"
        assert dest.read_text(encoding="utf-8") == "service"

    def test_an_unstoppable_service_fails_loudly(self, tmp_path, monkeypatch):
        agent, _ = self._stage(tmp_path)
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        (install_dir / installer.SERVICE_EXE_NAME).write_text("stale", encoding="utf-8")
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)
        monkeypatch.setattr(
            installer.shutil,
            "copy2",
            MagicMock(side_effect=OSError(32, "being used by another process")),
        )
        monkeypatch.setattr(installer, "_stop_service_for_replace", lambda: False)

        with pytest.raises(OSError):
            installer.install_service_binary(agent)

    def test_a_different_error_is_not_treated_as_a_lock(self, tmp_path, monkeypatch):
        agent, _ = self._stage(tmp_path)
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)
        monkeypatch.setattr(
            installer.shutil, "copy2", MagicMock(side_effect=OSError(28, "No space left"))
        )
        stops: list[int] = []
        monkeypatch.setattr(installer, "_stop_service_for_replace", lambda: stops.append(1) or True)

        with pytest.raises(OSError):
            installer.install_service_binary(agent)
        assert stops == [], "a disk-full copy must not stop the service"

    def test_install_files_stages_the_service_even_when_the_agent_is_in_place(
        self, tmp_path, monkeypatch
    ):
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        agent = install_dir / installer.AGENT_EXE_NAME
        agent.write_text("agent", encoding="utf-8")
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)

        calls: list[Path] = []
        monkeypatch.setattr(
            installer, "install_service_binary", lambda exe: calls.append(exe) or None
        )

        installer.install_files(agent)

        assert calls == [agent], "an up-to-date agent must not skip the service binary"

    def test_a_locked_agent_binary_stops_the_service_and_retries(self, tmp_path, monkeypatch):
        """The measured crash: re-installing over a *running* agent.

        `PermissionError: [WinError 32] ... being used by another process` at
        installer.py's shutil.copy2 (S270, MOLE). Upgrading an installed machine is
        impossible until this path stops the service and retries — which is the whole
        point of an installer that can run twice.
        """
        stage = tmp_path / "staging"
        stage.mkdir()
        agent = stage / installer.AGENT_EXE_NAME
        agent.write_text("new-agent", encoding="utf-8")
        install_dir = tmp_path / "LockdownAgent"
        install_dir.mkdir()
        dest = install_dir / installer.AGENT_EXE_NAME
        dest.write_text("old-agent", encoding="utf-8")
        monkeypatch.setattr(installer, "INSTALL_DIR", install_dir)

        real_copy = installer.shutil.copy2
        attempts: list[int] = []
        stops: list[int] = []

        def flaky_copy(src: Any, dst: Any) -> Any:
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError(32, "The process cannot access the file")
            return real_copy(src, dst)

        monkeypatch.setattr(installer.shutil, "copy2", flaky_copy)
        monkeypatch.setattr(installer, "_stop_service_for_replace", lambda: stops.append(1) or True)

        installer.install_files(agent)

        assert attempts == [1, 1], "the agent copy must be retried after the service stops"
        assert stops == [1]
        assert dest.read_text(encoding="utf-8") == "new-agent"


# ---------------------------------------------------------------------------
# The firmware password the machine already has (S271)
# ---------------------------------------------------------------------------


def test_build_config_omits_uefi_password_by_default():
    """Absent, not empty: the agent generates a password only when none is configured."""
    cfg = installer.build_config("https://x", "k", "h", "d")
    assert "uefi_password" not in cfg


def test_build_config_carries_the_uefi_password_when_supplied():
    """Without it the HP boot-lock layer cannot authenticate and the whole lock rolls back.

    Measured on MOLE: the firmware has a Setup password, the config had none, so the layer
    aborted, BCD rolled back, and `lockdown_effective` was false with no way to supply the
    value — the installers had no flag for it (S271).
    """
    cfg = installer.build_config("https://x", "k", "h", "d", uefi_password="firmware-pw")
    assert cfg["uefi_password"] == "firmware-pw"
