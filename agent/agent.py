"""
Remote Device Tracking & Lockdown Agent
---------------------------------------
Runs on the managed device. Polls the server for pending commands and executes them.

OPERATING MODES:
  - active:  Normal operation. Agent checks in, no visible action.
  - track:   Covert tracking. Agent reports geolocation silently. User is unaware.
             Device remains fully usable. No lock screen, no encryption.
  - lockdown: Full lockdown. Encrypts folder, locks screen, blocks usage.
  - recover: Unlock device, restore files.

SAFETY RULES (enforced in code):
  - Only encrypts LOCKDOWN_FOLDER, never touches system files or full disk.
  - Decryption key is NEVER stored locally after locking — it lives only on the server.
  - All communication over TLS (verify=True in requests).
  - Lock state persists across reboots via a sentinel file.
  - In track mode, NO visible action is taken. Agent is silent.

REQUIREMENTS:
  pip install cryptography requests

USAGE:
  Set the environment variables (or edit config.ini), then run:
    python agent.py

  To run as a background service on Windows, use NSSM or Task Scheduler.
  On Linux, use a systemd unit file.

  For silent operation (no console window), run with:
    pythonw agent.py --silent
"""

# --- stdout/stderr guard ---
# When built with PyInstaller console=False (windowed mode), sys.stdout
# and sys.stderr are None. This causes print() and argparse to crash with
# AttributeError. Redirect to os.devnull so the agent doesn't crash.
import os
import sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")

import argparse
import base64
import configparser
import ctypes
import hashlib
import hmac
import json
import logging
import os
import platform
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import requests
from cryptography.fernet import Fernet

# Boot lockdown modules (imported lazily on Windows to avoid import errors on Linux)
try:
    import bcd_lockdown
    import bitlocker_pba
    import hp_uefi_lockdown

    _boot_lock_modules_available = True
except ImportError:
    _boot_lock_modules_available = False

# Lock screen overlay (fullscreen topmost window that blocks interaction)
try:
    import lock_screen as lock_screen_module

    _lock_screen_available = True
except (ImportError, AttributeError, OSError):
    _lock_screen_available = False

# Master dry-run switch: when True, ALL lock modules log what they would do
# instead of executing. Set via LOCKDOWN_DRY_RUN=1 env var.
# This propagates to bcd_lockdown and hp_uefi_lockdown at startup.
_DRY_RUN = os.environ.get("LOCKDOWN_DRY_RUN", "").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
# The agent runs as a background process (console=False in PyInstaller).
# Log to a file so logs are preserved even without a console window.
# Also log to stdout when running in a terminal (e.g., during development
# or when launched with --debug).
_log_handlers = [logging.StreamHandler(sys.stdout)]
try:
    # Log to agent.log in the install directory (or cwd if not installed)
    _log_dir = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _log_handlers.append(logging.FileHandler(_log_dir / "agent.log", encoding="utf-8"))
except Exception:  # noqa: S110 — logging setup failure is non-fatal
    pass  # If we can't create the log dir, just use stdout

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=_log_handlers,
)
log = logging.getLogger("lockdown-agent")

# State crypto: encrypts deadman/sentinel files with DPAPI + HMAC (Layer 3)
# and optionally seals to TPM (Layer 2). Falls back to plaintext if the
# state_crypto module is not available (e.g., during early development).
try:
    from state_crypto import (
        is_encrypted_state_file,
        load_encrypted_state,
        save_encrypted_state,
    )

    _STATE_CRYPTO_AVAILABLE = True
except ImportError:
    _STATE_CRYPTO_AVAILABLE = False
    log.warning("state_crypto module not available — state files will be plaintext")

# Duress code + hidden file trigger (covert lockdown mechanisms).
# Import-guarded so the agent still runs if the module is unavailable.
try:
    import duress as _duress

    _DURESS_AVAILABLE = True
except ImportError:
    _DURESS_AVAILABLE = False
    log.warning("duress module not available — covert trigger disabled")

# Tamper protection: checks for missing state files / service / scheduled task.
# Windows-only — no-op on other platforms.
try:
    from tamper_protection import check_tamper

    _TAMPER_PROTECTION_AVAILABLE = True
except ImportError:
    _TAMPER_PROTECTION_AVAILABLE = False

    def check_tamper(state_dir: Path) -> dict:  # type: ignore[misc]
        """No-op stub when tamper_protection is not available."""
        return {
            "files_missing": [],
            "service_missing": False,
            "task_missing": False,
            "tampered": False,
        }


# TPM seal: seals state encryption key to TPM 2.0 (Windows-only).
# Falls back to DPAPI (state_crypto) when TPM is not available.
try:
    from tpm_seal import is_tpm_available, is_tpm_sealed_blob, seal_state, unseal_state

    _TPM_SEAL_AVAILABLE = True
except ImportError:
    _TPM_SEAL_AVAILABLE = False

    def is_tpm_available() -> bool:  # type: ignore[misc]
        """No-op stub when tpm_seal is not available."""
        return False

    def is_tpm_sealed_blob(blob: bytes) -> bool:  # type: ignore[misc]
        """No-op stub when tpm_seal is not available."""
        return False

    def seal_state(plaintext: bytes) -> bytes | None:  # type: ignore[misc]
        """No-op stub when tpm_seal is not available."""
        return None

    def unseal_state(blob: bytes) -> bytes | None:  # type: ignore[misc]
        """No-op stub when tpm_seal is not available."""
        return None

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------

AGENT_VERSION = "1.0.0"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


# Determine if running as a PyInstaller-bundled executable
def _is_frozen():
    """Check if the agent is running as a PyInstaller bundle."""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


# Base directory: PyInstaller bundle dir, or script dir
_BASE_DIR = Path(sys._MEIPASS) if _is_frozen() else Path(__file__).parent

# Executable directory (where the .exe or binary lives — for config file search)
_EXE_DIR = Path(sys.executable).parent if _is_frozen() else Path(__file__).parent

# System config directory (for bundled agent)
if sys.platform == "win32":
    _SYSTEM_CONFIG_DIR = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
else:
    _SYSTEM_CONFIG_DIR = Path("/etc/lockdown-agent")

# State directory: persistent writable location for runtime state files.
# When frozen (PyInstaller bundle): use platform-specific system directory
# (writable without elevated privileges, survives reboots).
# When running from source (dev/test): use the script directory so existing
# tests and dev workflows keep working without root/admin privileges.
if _is_frozen():
    if sys.platform == "win32":
        _STATE_DIR = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
    else:
        _STATE_DIR = Path("/var/lib/lockdown-agent")
else:
    _STATE_DIR = Path(__file__).parent

# Default config file locations (searched in order)
_CONFIG_SEARCH_PATHS = [
    _EXE_DIR / "config.json",
    _EXE_DIR / "config.ini",
    _SYSTEM_CONFIG_DIR / "agent-config.json",
    _SYSTEM_CONFIG_DIR / "config.ini",
    _BASE_DIR / "config.ini",  # legacy fallback (script directory)
]

# Runtime state files (all live in _STATE_DIR so they persist across reboots
# when bundled, and stay in the script directory during dev/test).
PENDING_ACK_FILE = _STATE_DIR / ".pending_ack"
RECOVERY_KEY_FILE = _STATE_DIR / ".recovery_key"
DEADMAN_FILE = _STATE_DIR / ".deadman"
HEARTBEAT_FILE = _STATE_DIR / ".heartbeat"
DEADMAN_KEY_FILE = _STATE_DIR / ".deadman_key"


def _find_config_file(cli_config_path=None):
    """Find the config file to use, searching in priority order."""
    # 1. Command-line argument
    if cli_config_path:
        p = Path(cli_config_path)
        if p.exists():
            return p
        log.warning("Config file from --config not found: %s", p)

    # 2. Search default locations
    for p in _CONFIG_SEARCH_PATHS:
        if p.exists():
            return p

    # 3. No config file found — return None (will use all defaults)
    return None


def _load_json_config(config_path):
    """Load config from a JSON file (as generated by the admin enrollment page).

    Only returns keys that are actually present in the JSON file, so that
    load_config() can fall back to its built-in defaults for missing keys.
    JSON keys are mapped to the internal config dict key names.
    """
    with open(config_path) as f:
        data = json.load(f)

    section = {}

    # server_url — direct mapping
    if "server_url" in data:
        section["server_url"] = data["server_url"]

    # serverless_url — optional Cloudflare Worker fallback endpoint
    if "serverless_url" in data and data["serverless_url"]:
        section["serverless_url"] = data["serverless_url"]

    # agent_key — JSON may use any of several key names (api_key, agent_key,
    # device_api_key) depending on when the enrollment page was last updated.
    for json_key in ("api_key", "agent_key", "device_api_key"):
        if json_key in data and data[json_key]:
            section["agent_key"] = data[json_key]
            break

    # hostname — JSON may use device_hostname or hostname
    for json_key in ("device_hostname", "hostname"):
        if json_key in data and data[json_key]:
            section["hostname"] = data[json_key]
            break

    # Numeric/string settings — convert to string for consistency with INI
    for json_key in ("poll_interval", "location_interval"):
        if json_key in data:
            section[json_key] = str(data[json_key])

    # Boolean settings — convert to lowercase string ("true"/"false")
    for json_key in ("verify_tls", "boot_lock_enabled", "server_supports_ack_dedup"):
        if json_key in data:
            section[json_key] = str(data[json_key]).lower()

    # String settings — direct mapping (only if non-empty)
    for json_key in (
        "lockdown_folder",
        "lock_sentinel",
        "google_api_key",
        "uefi_password",
        "pending_ack_file",
        "recovery_key_file",
        "recovery_public_key",
        "update_public_key",
    ):
        if json_key in data and data[json_key]:
            section[json_key] = data[json_key]

    return section


def _load_ini_config(config_path):
    """Load config from an INI file (legacy format)."""
    cfg = configparser.ConfigParser()
    cfg.read(config_path)
    return cfg["agent"] if "agent" in cfg else {}


def load_config(config_path=None) -> dict:
    """Load configuration from file (JSON or INI) and environment variables.

    Priority (highest to lowest):
      1. Environment variables
      2. Config file (JSON or INI, auto-detected by extension)
      3. Built-in defaults

    Args:
        config_path: Optional path to config file (from --config CLI arg).
                     If None, searches default locations.
    """
    # Find and load the config file
    found_path = _find_config_file(config_path)

    if found_path and found_path.suffix == ".json":
        section = _load_json_config(found_path)
        log.info("Loaded JSON config from: %s", found_path)
    elif found_path:
        section = _load_ini_config(found_path)
        log.info("Loaded INI config from: %s", found_path)
    else:
        log.warning("No config file found — using defaults and environment variables")
        section = {}

    return {
        "server_url": os.environ.get(
            "SERVER_URL", section.get("server_url", "https://localhost:3001")
        ),
        # Serverless fallback URL (optional). If set, the agent tries the
        # primary server_url first, then falls back to serverless_url on
        # connection failure. This is a Cloudflare Worker that mirrors the
        # /api/agent/* endpoints with KV-backed storage.
        "serverless_url": os.environ.get("SERVERLESS_URL", section.get("serverless_url", "")),
        # FA3: Per-device API key (preferred) with AGENT_SHARED_KEY legacy fallback.
        # The per-device key is provisioned at enrollment and unique to this device.
        # The legacy shared key is used only for devices that haven't been
        # re-enrolled with a per-device key yet (CC5 per-device fallback).
        "agent_key": os.environ.get(
            "DEVICE_API_KEY",
            os.environ.get(
                "AGENT_SHARED_KEY", section.get("agent_key", section.get("device_api_key", ""))
            ),
        ),
        "hostname": os.environ.get(
            "DEVICE_HOSTNAME", section.get("hostname", socket.gethostname())
        ),
        "poll_interval": int(os.environ.get("POLL_INTERVAL", section.get("poll_interval", "30"))),
        "lockdown_folder": Path(
            os.environ.get(
                "LOCKDOWN_FOLDER", section.get("lockdown_folder", str(Path.home() / "SecureData"))
            )
        ),
        "lock_sentinel": Path(
            os.environ.get("LOCK_SENTINEL", section.get("lock_sentinel", str(_EXE_DIR / ".locked")))
        ),
        "verify_tls": section.get("verify_tls", "true").lower() != "false",
        "google_api_key": os.environ.get("GOOGLE_API_KEY", section.get("google_api_key", "")),
        "location_interval": int(
            os.environ.get("LOCATION_INTERVAL", section.get("location_interval", "300"))
        ),
        # Boot lockdown: when True, the agent locks the UEFI/BIOS and BCD
        # on lockdown commands and reverts them on unlock. Requires Windows
        # + HP WMI BIOS interface (for UEFI lockdown). BCD lockdown works
        # on any Windows machine.
        "boot_lock_enabled": os.environ.get(
            "BOOT_LOCK_ENABLED", section.get("boot_lock_enabled", "true")
        ).lower()
        != "false",
        # Pre-existing BIOS Setup password (if the machine already has one).
        # If empty and no password is set, the agent generates a random one.
        # If empty and a password IS set, UEFI lockdown is skipped (can't
        # authenticate BIOS changes without it).
        "uefi_password": os.environ.get("UEFI_PASSWORD", section.get("uefi_password", "")),
        # A1/A4: Pending ACK state file (transient, deleted on ACK success)
        "pending_ack_file": Path(
            os.environ.get(
                "PENDING_ACK_FILE", section.get("pending_ack_file", str(PENDING_ACK_FILE))
            )
        ),
        # A8: Recovery key file (long-lived, RSA-wrapped, deleted on unlock)
        "recovery_key_file": Path(
            os.environ.get(
                "RECOVERY_KEY_FILE", section.get("recovery_key_file", str(RECOVERY_KEY_FILE))
            )
        ),
        # A8: IT's offline master recovery PUBLIC key (PEM). Private key never on device.
        "recovery_public_key": os.environ.get(
            "RECOVERY_PUBLIC_KEY", section.get("recovery_public_key", "")
        ),
        # S0.6 (B-006): pinned update-domain public key (PEM, Ed25519) for
        # detached-signature update verification — separate key domain from
        # recovery_public_key.
        "update_public_key": os.environ.get(
            "UPDATE_PUBLIC_KEY", section.get("update_public_key", "")
        ),
        # A4: Flip to true once server supports command_id dedup on encryption_keys
        "server_supports_ack_dedup": os.environ.get(
            "SERVER_SUPPORTS_ACK_DEDUP", section.get("server_supports_ack_dedup", "false")
        ).lower()
        != "false",
    }


def validate_config(cfg: dict) -> None:
    """Validate critical config values at startup.

    Raises ValueError (or calls sys.exit) if the config is unsafe:
      - server_url must be a valid https:// URL (TLS required for key transport)
      - lockdown_folder must be an absolute path (relative paths risk
        encrypting unintended directories depending on CWD)

    Called from main() after load_config(). This is a startup guard —
    it does not modify the config, only validates it.
    """
    from urllib.parse import urlparse

    server_url = cfg.get("server_url", "")
    if not server_url:
        raise ValueError("SERVER_URL is not set — cannot start agent without a server URL")
    parsed = urlparse(server_url)
    if parsed.scheme not in ("https",):
        # Allow http:// only when verify_tls is False (explicit dev override)
        if parsed.scheme == "http" and not cfg.get("verify_tls", True):
            pass  # dev mode: http allowed when TLS verification is explicitly disabled
        else:
            raise ValueError(
                f"SERVER_URL must use https:// (got '{server_url}') — "
                f"key material must be transported over TLS"
            )
    if not parsed.netloc:
        raise ValueError(f"SERVER_URL is missing a host (got '{server_url}')")

    # Validate serverless_url if present (optional fallback endpoint)
    serverless_url = cfg.get("serverless_url", "")
    if serverless_url:
        parsed_sl = urlparse(serverless_url)
        if parsed_sl.scheme not in ("https",):
            if parsed_sl.scheme == "http" and not cfg.get("verify_tls", True):
                pass  # dev mode
            else:
                raise ValueError(
                    f"SERVERLESS_URL must use https:// (got '{serverless_url}') — "
                    f"key material must be transported over TLS"
                )
        if not parsed_sl.netloc:
            raise ValueError(f"SERVERLESS_URL is missing a host (got '{serverless_url}')")

    lockdown_folder = cfg.get("lockdown_folder")
    if lockdown_folder is not None:
        lockdown_folder = Path(lockdown_folder)
        if not lockdown_folder.is_absolute():
            raise ValueError(
                f"LOCKDOWN_FOLDER must be an absolute path (got '{lockdown_folder}') — "
                f"relative paths risk encrypting unintended directories"
            )


# ---------------------------------------------------------------------------
# Encryption helpers (Fernet = AES-128-CBC + HMAC-SHA256)
# ---------------------------------------------------------------------------


def generate_key() -> bytes:
    return Fernet.generate_key()


def wipe_key(key: bytearray) -> None:
    """Securely zero a bytearray key in memory.

    Python ``bytes`` and ``str`` are immutable, so the key must be held as a
    ``bytearray`` (mutable) for in-place wiping. Uses ``ctypes.memset`` to
    overwrite the buffer with zeros so the key material does not linger in
    memory after it is no longer needed.
    """
    if not isinstance(key, bytearray):
        return
    import ctypes

    buf = (ctypes.c_char * len(key)).from_buffer(key)
    ctypes.memset(buf, 0, len(key))


def encrypt_folder(folder: Path, key: bytes) -> list[str]:
    """Encrypt all files inside `folder` in-place. Never touches files outside it.

    CC20: Resumable — skips files that already have a .enc counterpart
    (from a previous interrupted run). This allows handle_lockdown to
    resume encryption with the same persisted key after a crash, rather
    than generating a new key and leaving a mix of .enc and plaintext files.

    D-011: Catches PermissionError on open files (e.g., Office docs, Outlook
    PSTs on Windows). Retries up to 3 times with 1-second delay. If still
    locked, skips the file and adds it to the blocked_files list. The caller
    can report blocked files to the server so the operator knows which files
    weren't encrypted.

    Returns:
        List of file paths (relative to folder) that could not be encrypted
        because they were locked/open. Empty list if all files encrypted.
    """
    folder = folder.resolve()
    fernet = Fernet(key)
    blocked_files: list[str] = []
    max_retries = 3
    retry_delay = 1.0  # seconds

    for filepath in folder.rglob("*"):
        if filepath.is_file() and not filepath.name.endswith(".enc"):
            enc_path = filepath.with_suffix(filepath.suffix + ".enc")
            # CC20: Skip if already encrypted (resumable encryption)
            if enc_path.exists():
                log.info("Already encrypted, skipping: %s", filepath.name)
                continue

            # D-011: Retry on PermissionError (file may be open by another process)
            success = False
            for attempt in range(max_retries):
                try:
                    data = filepath.read_bytes()
                    encrypted = fernet.encrypt(data)
                    enc_path.write_bytes(encrypted)
                    filepath.unlink()
                    success = True
                    log.info("Encrypted: %s", filepath.name)
                    break
                except PermissionError:
                    if attempt < max_retries - 1:
                        log.warning(
                            "File locked (attempt %d/%d): %s — retrying in %.1fs",
                            attempt + 1,
                            max_retries,
                            filepath.name,
                            retry_delay,
                        )
                        time.sleep(retry_delay)
                    else:
                        log.error(
                            "File locked after %d attempts, skipping: %s",
                            max_retries,
                            filepath.name,
                        )

            if not success:
                rel_path = str(filepath.relative_to(folder))
                blocked_files.append(rel_path)

    return blocked_files


def decrypt_folder(folder: Path, key: bytes) -> None:
    """Decrypt all .enc files inside `folder`. Never touches files outside it."""
    folder = folder.resolve()
    fernet = Fernet(key)
    for enc_path in folder.rglob("*.enc"):
        if enc_path.is_file():
            data = enc_path.read_bytes()
            decrypted = fernet.decrypt(data)
            original_path = enc_path.with_suffix("")
            original_path.write_bytes(decrypted)
            enc_path.unlink()
            log.info("Decrypted: %s", original_path.name)


# ---------------------------------------------------------------------------
# Lock screen (platform-specific, best-effort)
# ---------------------------------------------------------------------------

_BANNER = (
    "\n\n"
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n"
    "  !                                                       !\n"
    "  !   THIS DEVICE HAS BEEN REPORTED STOLEN               !\n"
    "  !   Contact your administrator immediately.             !\n"
    "  !                                                       !\n"
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n"
)


def _detect_session_context() -> dict:
    """D-007: Detect whether the agent is running in Session 0 (service) or
    an interactive session.

    On Windows, services run in Session 0, which is isolated from user
    sessions (Session 1+). LockWorkStation() called from Session 0 only
    locks Session 0, not the user's desktop.

    Returns a dict with:
      - is_session_zero: bool — True if running in Session 0 (service context)
      - session_id: int | None — the current session ID (Windows only)
      - console_session_id: int | None — the active console session ID (Windows only)
      - platform: str — the OS platform
    """
    system = platform.system()
    result = {
        "is_session_zero": False,
        "session_id": None,
        "console_session_id": None,
        "platform": system,
    }
    if system != "Windows" or _DRY_RUN:
        return result
    try:
        import ctypes

        # WTSGetActiveConsoleSessionId returns the session ID of the active
        # console session (the user's interactive session). If the agent
        # is running in that session, LockWorkStation will work. If not,
        # we're in Session 0 (service) and need an alternate approach.
        kernel32 = ctypes.windll.kernel32
        console_session_id = kernel32.WTSGetActiveConsoleSessionId()
        # GetCurrentProcessId → ProcessIdToSessionId gives our session
        current_pid = kernel32.GetCurrentProcessId()
        our_session_id = ctypes.c_ulong(0)
        kernel32.ProcessIdToSessionId(current_pid, ctypes.byref(our_session_id))
        result["session_id"] = our_session_id.value
        result["console_session_id"] = console_session_id
        result["is_session_zero"] = (
            our_session_id.value == 0 or our_session_id.value != console_session_id
        )
    except (OSError, AttributeError, ImportError) as e:
        log.debug("D-007: Session detection failed: %s", e)
    return result


def _lock_workstation() -> None:
    """Platform-specific workstation lock. Best-effort, no banner.

    D-007: On Windows, if the agent is running in Session 0 (service context),
    LockWorkStation() only locks Session 0 — not the user's interactive
    desktop. In that case, we use `tsdiscon` to disconnect the active console
    session, which effectively forces the lock screen on the user's desktop.
    """
    if _DRY_RUN:
        log.info("[DRY-RUN] Would lock workstation (LockWorkStation/tsdiscon) — skipping")
        return
    system = platform.system()
    if system == "Windows":
        ctx = _detect_session_context()
        if ctx["is_session_zero"]:
            # D-007: Running as a service in Session 0.
            # LockWorkStation() would only lock Session 0 (invisible).
            # Use tsdiscon to disconnect the active console session instead.
            log.info(
                "D-007: Session 0 detected (session_id=%s) — using tsdiscon "
                "to disconnect active console session",
                ctx["session_id"],
            )
            try:
                # Use the actual console session ID instead of hardcoding 1.
                # The console session may not be Session 1 in Fast User
                # Switching or RDP reconnection scenarios.
                console_id = ctx.get("console_session_id")
                tsdiscon_args = ["tsdiscon"]
                if console_id is not None:
                    tsdiscon_args.append(str(console_id))
                subprocess.run(
                    tsdiscon_args,
                    check=True,
                    timeout=5,
                    capture_output=True,
                )
                return
            except FileNotFoundError:
                log.warning("D-007: tsdiscon not found — falling back to LockWorkStation")
            except subprocess.CalledProcessError as e:
                log.warning(
                    "D-007: tsdiscon failed (rc=%d) — falling back to LockWorkStation: %s",
                    e.returncode,
                    e.stderr.decode(errors="replace").strip() if e.stderr else "",
                )
            except (subprocess.TimeoutExpired, OSError) as e:
                log.warning("D-007: tsdiscon error — falling back to LockWorkStation: %s", e)
        # Either not Session 0, or tsdiscon failed — try LockWorkStation
        try:
            import ctypes

            ctypes.windll.user32.LockWorkStation()
        except (OSError, AttributeError) as e:
            log.warning("Windows lock failed: %s", e)
    elif system == "Linux":
        for cmd in [["dm-tool", "lock"], ["loginctl", "lock-session"], ["xdg-screensaver", "lock"]]:
            try:
                subprocess.run(cmd, check=True, timeout=5)
                break
            except (
                subprocess.CalledProcessError,
                subprocess.TimeoutExpired,
                FileNotFoundError,
                OSError,
            ) as e:
                log.debug("Lock command %s failed: %s", cmd[0], e)
                continue
    elif system == "Darwin":
        try:
            subprocess.run(
                [
                    "/System/Library/CoreServices/Menu Extras/"
                    "User.menu/Contents/Resources/CGSession",
                    "-suspend",
                ],
                timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
            log.warning("macOS lock failed: %s", e)


def apply_lock_screen() -> None:
    """Lock the workstation and display the stolen banner.

    On Windows, launches a fullscreen topmost overlay window that blocks
    all desktop interaction (separate process, can't be killed from the
    agent's main process). Falls back to LockWorkStation() if the overlay
    module is not available.
    """
    if _DRY_RUN:
        log.info("[DRY-RUN] Would lock workstation and display stolen banner — skipping")
        return
    # Launch fullscreen lock screen overlay (Windows only)
    if _lock_screen_available and platform.system() == "Windows":
        try:
            lock_screen_module.launch()
            log.info("Fullscreen lock screen overlay launched")
        except (OSError, RuntimeError) as e:
            log.warning("Lock screen overlay failed: %s — falling back to LockWorkStation", e)
            _lock_workstation()
    else:
        _lock_workstation()
    log.warning(_BANNER)


# ---------------------------------------------------------------------------
# Lock guardian — background thread that re-asserts the lock screen so a
# thief cannot simply unlock and use the device.
# ---------------------------------------------------------------------------

LOCK_GUARDIAN_INTERVAL = 10  # seconds between re-lock attempts
_lock_guardian_stop: threading.Event | None = None
_lock_guardian_thread: threading.Thread | None = None


def start_lock_guardian() -> None:
    """Start (or restart) the background thread that re-locks the screen."""
    if _DRY_RUN:
        log.info(
            "[DRY-RUN] Would start lock guardian thread (re-lock every %ds) — skipping",
            LOCK_GUARDIAN_INTERVAL,
        )
        return
    global _lock_guardian_stop, _lock_guardian_thread
    stop_lock_guardian()
    _lock_guardian_stop = threading.Event()
    _lock_guardian_thread = threading.Thread(
        target=_lock_guardian_loop, args=(_lock_guardian_stop,), daemon=True
    )
    _lock_guardian_thread.start()
    log.info("Lock guardian started — re-asserting lock every %ds", LOCK_GUARDIAN_INTERVAL)


def stop_lock_guardian() -> None:
    """Stop the lock guardian thread if one is running."""
    global _lock_guardian_stop, _lock_guardian_thread
    if _lock_guardian_stop:
        _lock_guardian_stop.set()
    if _lock_guardian_thread and _lock_guardian_thread.is_alive():
        _lock_guardian_thread.join(timeout=5)
    _lock_guardian_stop = None
    _lock_guardian_thread = None


def _lock_guardian_loop(stop_event: threading.Event) -> None:
    """Background loop — re-lock the screen at regular intervals.

    On Windows, also re-launches the fullscreen overlay if it was killed
    (e.g. via Task Manager before we disabled it).
    """
    while not stop_event.is_set():
        _lock_workstation()
        # Re-assert the fullscreen overlay if it's not running
        if _lock_screen_available and platform.system() == "Windows":
            try:
                if not lock_screen_module.is_running():
                    lock_screen_module.launch()
                    log.info("Lock guardian re-launched lock screen overlay")
            except (OSError, RuntimeError) as e:
                log.debug("Lock guardian overlay re-launch failed: %s", e)
        stop_event.wait(LOCK_GUARDIAN_INTERVAL)


def remove_lock_screen() -> None:
    stop_lock_guardian()
    # Kill the fullscreen lock screen overlay process
    if _lock_screen_available and platform.system() == "Windows":
        try:
            lock_screen_module.remove()
            log.info("Lock screen overlay removed")
        except (OSError, RuntimeError) as e:
            log.warning("Failed to remove lock screen overlay: %s", e)
    log.info("Lock screen removed — normal login restored")


# ---------------------------------------------------------------------------
# Hardware identity
# ---------------------------------------------------------------------------


def get_mac_address() -> str:
    """Return the primary MAC address as a colon-separated string."""
    mac = uuid.getnode()
    return ":".join(f"{mac:012X}"[i : i + 2] for i in range(0, 12, 2))


def get_hardware_uuid() -> str:
    """Return a stable hardware UUID from the OS."""
    system = platform.system()
    try:
        if system == "Windows":
            # wmic is deprecated on Windows 11 (removed in 24H2+).
            # Use PowerShell Get-CimInstance instead, with wmic as fallback
            # for older Windows versions.
            try:
                result = (
                    subprocess.check_output(
                        [
                            "powershell",
                            "-NoProfile",
                            "-Command",
                            "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
                        ],
                        timeout=10,
                        stderr=subprocess.DEVNULL,
                    )
                    .decode()
                    .strip()
                )
                if result and result != "00000000-0000-0000-0000-000000000000":
                    return result
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
                pass
            # Fallback: wmic (works on older Windows, may not exist on 24H2+)
            result = (
                subprocess.check_output(
                    ["wmic", "csproduct", "get", "UUID"], timeout=10, stderr=subprocess.DEVNULL
                )
                .decode()
                .strip()
                .split()
            )
            return result[-1] if result else str(uuid.getnode())
        elif system == "Linux":
            result = (
                subprocess.check_output(
                    ["cat", "/sys/class/dmi/id/product_uuid"], timeout=10, stderr=subprocess.DEVNULL
                )
                .decode()
                .strip()
            )
            return result
        elif system == "Darwin":
            result = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                timeout=10,
                stderr=subprocess.DEVNULL,
            ).decode()
            for line in result.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
        IndexError,
    ) as e:
        log.warning("Could not get hardware UUID: %s", e)
    return str(uuid.getnode())


# ---------------------------------------------------------------------------
# Geolocation — WiFi-based triangulation + IP fallback
# ---------------------------------------------------------------------------


def scan_wifi_networks() -> list[dict]:
    """Scan nearby WiFi networks. Returns list of {bssid, ssid, signal, channel}.

    Uses platform-native tools:
      - Windows: netsh wlan show networks mode=bssid
      - Linux:   nmcli dev wifi list
      - macOS:   /System/Library/PrivateFrameworks/Apple80211.framework/
                 Versions/Current/Resources/airport -s
    """
    networks = []
    system = platform.system()
    try:
        if system == "Windows":
            output = subprocess.check_output(
                ["netsh", "wlan", "show", "networks", "mode=bssid"],
                timeout=10,
                stderr=subprocess.DEVNULL,
            ).decode("utf-8", errors="replace")
            # Parse netsh output — blocks separated by BSSID lines
            current_ssid = None
            for line in output.splitlines():
                line = line.strip()
                if line.startswith("SSID ") and ":" in line:
                    current_ssid = line.split(":", 1)[1].strip()
                elif "BSSID" in line and ":" in line:
                    parts = line.split(":", 1)[1].strip().split()
                    bssid = parts[0] if parts else ""
                    networks.append({"ssid": current_ssid, "bssid": bssid})
                elif "Signal" in line and ":" in line:
                    pct = line.split(":")[-1].strip().replace("%", "")
                    if networks and pct:
                        networks[-1]["signal"] = int(pct)
        elif system == "Linux":
            output = subprocess.check_output(
                ["nmcli", "-t", "-f", "BSSID,SSID,SIGNAL,FREQ", "dev", "wifi", "list"],
                timeout=10,
                stderr=subprocess.DEVNULL,
            ).decode("utf-8", errors="replace")
            for line in output.splitlines():
                parts = line.split(":")
                if len(parts) >= 4:
                    bssid = ":".join(parts[:6])
                    ssid = parts[6] if len(parts) > 6 else ""
                    signal = int(parts[-2]) if parts[-2].isdigit() else 0
                    freq = parts[-1]
                    networks.append(
                        {"ssid": ssid, "bssid": bssid, "signal": signal, "frequency": freq}
                    )
        elif system == "Darwin":
            output = subprocess.check_output(
                [
                    "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport",
                    "-s",
                ],
                timeout=10,
                stderr=subprocess.DEVNULL,
            ).decode("utf-8", errors="replace")
            for line in output.splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 5:
                    networks.append(
                        {
                            "ssid": parts[0],
                            "bssid": parts[1],
                            "signal": int(parts[2]) if parts[2].isdigit() else 0,
                        }
                    )
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
        ValueError,
        IndexError,
    ) as e:
        log.warning("WiFi scan failed: %s", e)
    return networks


def get_ip_geolocation() -> dict | None:
    """Fallback: get rough location from IP address using ip-api.com (free, no key)."""
    try:
        resp = requests.get("http://ip-api.com/json/", timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "success":
            return {
                "latitude": data.get("lat"),
                "longitude": data.get("lon"),
                "city": data.get("city"),
                "region": data.get("regionName"),
                "country": data.get("countryCode"),
                "ip": data.get("query"),
                "source": "ip",
                "accuracy": "city",
            }
    except (requests.RequestException, ValueError) as e:
        log.warning("IP geolocation failed: %s", e)
    return None


def get_geolocation(cfg: dict) -> dict | None:
    """Get device geolocation. Tries WiFi triangulation first, falls back to IP.

    WiFi triangulation uses Google Geolocation API if GOOGLE_API_KEY is set,
    otherwise falls back to IP-based geolocation.
    """
    # Try WiFi-based geolocation if Google API key is configured
    google_key = os.environ.get("GOOGLE_API_KEY") or cfg.get("google_api_key")
    if google_key:
        wifi = scan_wifi_networks()
        if wifi:
            try:
                wifi_points = []
                for net in wifi[:20]:  # Max 20 access points
                    point = {"macAddress": net["bssid"]}
                    if "signal" in net:
                        # Google expects signal strength in dBm (negative).
                        # netsh gives percentage, convert approximately.
                        pct = net["signal"]
                        if pct > 0:
                            point["signalStrength"] = -(100 - pct)
                    if "frequency" in net:
                        point["channel"] = int(float(net["frequency"]) * 1000)
                    wifi_points.append(point)

                resp = requests.post(
                    f"https://www.googleapis.com/geolocation/v1/geolocate?key={google_key}",
                    json={"wifiAccessPoints": wifi_points},
                    timeout=10,
                )
                resp.raise_for_status()
                data = resp.json()
                loc = data.get("location", {})
                acc = data.get("accuracy", 0)
                return {
                    "latitude": loc.get("lat"),
                    "longitude": loc.get("lng"),
                    "accuracy_meters": acc,
                    "source": "wifi",
                    "wifi_count": len(wifi_points),
                }
            except (requests.RequestException, ValueError, TypeError, KeyError) as e:
                log.warning("WiFi geolocation failed: %s", e)

    # Fallback to IP-based geolocation
    return get_ip_geolocation()


def report_location(cfg: dict) -> dict | None:
    """Collect geolocation data and report it to the server.

    Phase 5: If the server is unreachable, the location report is queued
    locally and sent when connectivity returns.
    """
    location = get_geolocation(cfg)
    if not location:
        log.warning("Could not determine geolocation")
        return None

    payload = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
        "location": location,
    }

    try:
        resp = _post_with_fallback(
            "/api/agent/location",
            cfg,
            payload,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        log.info(
            "Location reported: %.4f, %.4f (%s, ~%sm)",
            location.get("latitude", 0),
            location.get("longitude", 0),
            location.get("source", "unknown"),
            location.get("accuracy_meters", location.get("accuracy", "?")),
        )
        return location
    except requests.RequestException as e:
        log.warning("Location report failed: %s — queuing offline", e)
        queue_offline("/api/agent/location", payload)
        return None


# ---------------------------------------------------------------------------
# HMAC request signing (Phase 0 security hardening)
# ---------------------------------------------------------------------------


def sign_headers(agent_key: str, body_bytes: bytes) -> dict:
    """Build HMAC-signed headers for a request to the server.

    Returns headers dict with x-agent-key, x-timestamp, x-nonce,
    x-signature, and x-sig-version. The server validates the signature
    and rejects replays (same nonce within 10 min).

    The signature is HMAC-SHA256(agent_key, "{timestamp}:{nonce}:{body_sha256}").
    """
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)  # 32-char hex
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    payload = f"{timestamp}:{nonce}:{body_hash}"
    signature = hmac.new(
        agent_key.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "x-agent-key": agent_key,
        "x-timestamp": timestamp,
        "x-nonce": nonce,
        "x-signature": signature,
        "x-sig-version": "1",
    }


def _signed_post(url: str, cfg: dict, json_body: dict, **kwargs) -> requests.Response:
    """Wrapper around requests.post that adds HMAC-signed headers.

    If HMAC signing fails, the request fails — we never send the agent key
    without replay protection. The body is pre-serialized to bytes and sent
    via data= (not json=) so the server sees the exact same bytes we
    computed the signature over.
    """
    body_bytes = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
    headers = sign_headers(cfg["agent_key"], body_bytes)
    # Merge any caller-provided headers (e.g., none currently, but future-proof)
    headers.update(kwargs.pop("headers", {}))
    headers.setdefault("Content-Type", "application/json")
    return requests.post(url, data=body_bytes, headers=headers, **kwargs)  # noqa: S113 -- timeout is passed by all callers via **kwargs


def _post_with_fallback(endpoint: str, cfg: dict, json_body: dict, **kwargs) -> requests.Response:
    """Signed POST with serverless fallback.

    Tries the primary server_url first. On connection failure (ConnectionError
    or Timeout), falls back to serverless_url if configured. This lets the
    agent survive a primary server outage by routing through the Cloudflare
    Worker — the Worker mirrors the /api/agent/* endpoints with KV storage.

    Non-connection errors (4xx, 5xx HTTP responses) are NOT retried on the
    fallback — those are application-level errors that the fallback would
    likely reproduce. Only network-level failures trigger the fallback.
    """
    primary_url = f"{cfg['server_url']}{endpoint}"
    try:
        return _signed_post(primary_url, cfg, json_body, **kwargs)
    except (requests.ConnectionError, requests.Timeout) as e:
        serverless_url = cfg.get("serverless_url", "")
        if not serverless_url:
            raise
        fallback_url = f"{serverless_url}{endpoint}"
        log.warning(
            "Primary server unreachable (%s), falling back to serverless: %s", e, fallback_url
        )
        return _signed_post(fallback_url, cfg, json_body, **kwargs)


# ---------------------------------------------------------------------------
# Server communication
# ---------------------------------------------------------------------------


def checkin(cfg: dict) -> dict | None:
    # S1.4: read the TPM restart counter OS-side (TPM2_ReadClock via TBS).
    # PBL never runs on an S3 resume (finding F6), so the firmware cannot
    # report a resume — only the agent can observe restartCount. The server
    # compares this against the last PBL-recorded boot_id (resetCount):
    # restartCount > last_boot_id => wake without cold boot => S3 resume,
    # which downgrades the S1.2 boot_fresh=false absence alarm. None on
    # non-Windows / no-TBS; the server treats absent as "unknown".
    tpm_restart = None
    try:
        from tpm_clock import read_restart_count

        tpm_restart = read_restart_count()
    except Exception as e:  # never let TPM read break check-in
        log.debug("TPM restart-count read unavailable: %s", e)

    body = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
    }
    if tpm_restart is not None:
        body["tpm_restart_count"] = tpm_restart

    try:
        resp = _post_with_fallback(
            "/api/agent/checkin",
            cfg,
            body,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        log.warning("Check-in failed: %s", e)
        return None


def ack_command(
    cfg: dict,
    command_id: str,
    result_status: str,
    key_material: str | None = None,
    bios_password: str | None = None,
    boot_lock_status: str | None = None,
    command_uuid: str | None = None,
    boot_lock_detail: dict | None = None,
    encryption_blocked_files: list[str] | None = None,
    lock_session_context: dict | None = None,
    power_on_password: str | None = None,
    bitlocker_pin: str | None = None,
    bitlocker_recovery_password: str | None = None,
) -> bool:
    """Send command ACK to server. Returns True on success, False on failure.

    The return value is used by the pending-ACK retry mechanism (A4):
    on failure, the ACK is persisted locally and retried on the next loop.

    Phase 5: command_uuid is a client-generated UUID for idempotent ACKs.
    If the server receives the same UUID twice, it deduplicates.

    Phase 17: boot_lock_detail carries per-layer enforcement counts
    (critical_applied, best_effort_applied, best_effort_failed) so the
    server can distinguish "full lockdown" from "encryption-only, boot
    lockdown silently no-op'd". This closes the dangerous gap where
    boot_lock_status="partial" with critical_applied=0 was reported as
    a successful lockdown to the operator.

    D-011: encryption_blocked_files is a list of file paths that could
    not be encrypted because they were locked/open by another process.
    The server stores this in the audit log so the operator knows which
    files weren't encrypted.

    D-007: lock_session_context reports whether the lock screen was
    applied from Session 0 (service) or an interactive session. If
    Session 0, the agent used tsdiscon instead of LockWorkStation.

    T7: power_on_password is the HP Power-On Password set during lockdown
    when enable_pba=True. The server stores it in bios_passwords with
    password_type='power_on' for use during unlock (the agent needs it
    to clear the Power-On Password during remove_boot_lockdown).

    T9: bitlocker_pin and bitlocker_recovery_password are the BitLocker
    TPM+PIN credentials set during lockdown when enable_pba=True and
    BitLocker is enabled. The server stores them in bios_passwords with
    password_type='bitlocker_pin' and 'bitlocker_recovery'. The operator
    needs these to physically unlock a rebooted PBA device.
    """
    # Phase 5: Generate a command_uuid if not provided.
    # This ensures idempotent retries — the server won't process the same ACK twice.
    if not command_uuid:
        command_uuid = str(uuid.uuid4())

    payload = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
        "command_id": command_id,
        "result_status": result_status,
        "command_uuid": command_uuid,
    }
    if key_material:
        payload["key_material"] = key_material
    if bios_password:
        payload["bios_password"] = bios_password
    if boot_lock_status:
        payload["boot_lock_status"] = boot_lock_status
    if boot_lock_detail:
        payload["boot_lock_detail"] = boot_lock_detail
    if encryption_blocked_files:
        payload["encryption_blocked_files"] = encryption_blocked_files
    if lock_session_context:
        payload["lock_session_context"] = lock_session_context
    if power_on_password:
        payload["power_on_password"] = power_on_password
    if bitlocker_pin:
        payload["bitlocker_pin"] = bitlocker_pin
    if bitlocker_recovery_password:
        payload["bitlocker_recovery_password"] = bitlocker_recovery_password
    try:
        resp = _post_with_fallback(
            "/api/agent/command-ack",
            cfg,
            payload,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        log.info(
            "ACK sent: command=%s status=%s uuid=%s", command_id, result_status, command_uuid[:8]
        )
        return True
    except requests.RequestException as e:
        log.error("ACK failed: %s", e)
        return False


def escrow_key(cfg: dict, command_id: str, key_material: str) -> bool:
    """S4: Escrow the encryption key to the server BEFORE encryption.

    Called during lockdown, after generate_key() and BEFORE encrypt_folder.
    The server persists the key (encrypted at rest) bound to the lockdown
    command_id, so the recovery key is escrowed before the point of no
    return. If this returns False the caller must NOT encrypt — a device
    that can't confirm its key is escrowed stays unlocked rather than
    locked-out (unlocked > locked-without-recovery-key).

    Idempotent on (device_id, command_id) — retries are safe.

    Returns True on confirmed escrow, False on any failure.
    """
    payload = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
        "command_id": command_id,
        "key_material": key_material,
    }
    try:
        resp = _post_with_fallback(
            "/api/agent/escrow-key",
            cfg,
            payload,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        body = resp.json()
        if body.get("escrowed"):
            log.info("Recovery key escrowed to server (command=%s)", command_id)
            return True
        log.error("Escrow rejected by server: %s", body)
        return False
    except requests.RequestException as e:
        log.error("Escrow failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Offline queue (Phase 5) — SQLite-based queue for location reports
# ---------------------------------------------------------------------------
#
# When the agent is offline, location reports and other non-critical
# data are queued locally and synced when connectivity returns.
# ACKs are already handled by the pending ACK mechanism (A1/A4).

import sqlite3  # noqa: E402 -- imported after sys.path setup for offline queue module

# Offline queue database (in _STATE_DIR)
OFFLINE_QUEUE_DB = _STATE_DIR / ".offline_queue.db"


def _get_queue_db() -> sqlite3.Connection:
    """Get a connection to the offline queue database."""
    conn = sqlite3.connect(str(OFFLINE_QUEUE_DB))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS offline_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            endpoint TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at REAL NOT NULL,
            attempts INTEGER DEFAULT 0
        )
    """)
    conn.commit()
    return conn


def queue_offline(endpoint: str, payload: dict) -> None:
    """Queue a request for later delivery when the server is unreachable."""
    try:
        conn = _get_queue_db()
        conn.execute(
            "INSERT INTO offline_queue (endpoint, payload, created_at) VALUES (?, ?, ?)",
            (endpoint, json.dumps(payload), time.time()),
        )
        conn.commit()
        conn.close()
        log.debug("Queued offline: %s (%d items in queue)", endpoint, _queue_size())
    except (sqlite3.Error, TypeError, OSError) as e:
        log.warning("Failed to queue offline request: %s", e)


def _queue_size() -> int:
    """Return the number of items in the offline queue."""
    try:
        conn = _get_queue_db()
        row = conn.execute("SELECT COUNT(*) FROM offline_queue").fetchone()
        conn.close()
        return row[0] if row else 0
    except (sqlite3.Error, OSError) as e:
        log.warning("Could not query offline queue size: %s", e)
        return 0


def drain_offline_queue(cfg: dict) -> None:
    """Send all queued requests to the server.

    Called after a successful checkin — if we can reach the server,
    we can probably deliver queued items too.
    """
    if _queue_size() == 0:
        return

    try:
        conn = _get_queue_db()
        rows = conn.execute(
            "SELECT id, endpoint, payload, attempts "
            "FROM offline_queue ORDER BY created_at ASC LIMIT 50"
        ).fetchall()

        sent = 0
        for row_id, endpoint, payload_json, attempts in rows:
            try:
                payload = json.loads(payload_json)
                resp = _post_with_fallback(
                    endpoint,
                    cfg,
                    payload,
                    timeout=15,
                    verify=cfg["verify_tls"],
                )
                resp.raise_for_status()
                conn.execute("DELETE FROM offline_queue WHERE id = ?", (row_id,))
                sent += 1
            except (json.JSONDecodeError, requests.RequestException, KeyError, TypeError):
                # Increment attempt count; give up after 10 attempts
                conn.execute(
                    "UPDATE offline_queue SET attempts = attempts + 1 WHERE id = ?", (row_id,)
                )
                if attempts >= 10:
                    log.warning(
                        "Dropping offline queue item after %d attempts: %s", attempts, endpoint
                    )
                    conn.execute("DELETE FROM offline_queue WHERE id = ?", (row_id,))
                break  # Stop on first failure (server might be down again)

        conn.commit()
        conn.close()
        if sent > 0:
            log.info("Drained %d offline queue items (%d remaining)", sent, _queue_size())
    except (sqlite3.Error, OSError) as e:
        log.warning("Failed to drain offline queue: %s", e)


# ---------------------------------------------------------------------------
# Pending ACK persistence (A1 + A4)
# ---------------------------------------------------------------------------


def _fsync_file(path: Path) -> None:
    """Ensure file contents are flushed to disk (crash safety)."""
    import contextlib

    with contextlib.suppress(Exception):
        with open(path, "r+b") as f:
            f.flush()
            os.fsync(f.fileno())


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text to a file atomically (write to temp + rename).

    Prevents corruption if the process crashes mid-write — the file is
    either fully old or fully new, never partially written.
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    _fsync_file(tmp)
    tmp.replace(path)


def write_pending_ack(
    file_path: Path,
    command_id: str,
    result_status: str,
    key_material: str | None = None,
    bios_password: str | None = None,
    boot_lock_status: str | None = None,
    command_uuid: str | None = None,
    boot_lock_detail: dict | None = None,
    power_on_password: str | None = None,
    bitlocker_pin: str | None = None,
    bitlocker_recovery_password: str | None = None,
) -> None:
    """Write the pending ACK state to disk (fsync'd).

    Called BEFORE encrypt_folder() so a crash doesn't lose the key.
    Phase 5: includes command_uuid for idempotent retries.
    Phase 17: includes boot_lock_detail for enforcement-quality reporting.
    T7: includes power_on_password for PBA credential persistence.
    T9: includes bitlocker_pin and bitlocker_recovery_password for BitLocker
    TPM+PIN PBA credential persistence.
    """
    state = {
        "command_id": command_id,
        "result_status": result_status,
        "created_at": time.time(),
    }
    if key_material:
        state["key_material"] = key_material
    if bios_password:
        state["bios_password"] = bios_password
    if boot_lock_status:
        state["boot_lock_status"] = boot_lock_status
    if command_uuid:
        state["command_uuid"] = command_uuid
    if boot_lock_detail:
        state["boot_lock_detail"] = boot_lock_detail
    if power_on_password:
        state["power_on_password"] = power_on_password
    if bitlocker_pin:
        state["bitlocker_pin"] = bitlocker_pin
    if bitlocker_recovery_password:
        state["bitlocker_recovery_password"] = bitlocker_recovery_password
    _atomic_write_text(file_path, json.dumps(state))


def update_pending_ack(
    file_path: Path,
    bios_password: str | None = None,
    boot_lock_status: str | None = None,
    boot_lock_detail: dict | None = None,
    power_on_password: str | None = None,
    bitlocker_pin: str | None = None,
    bitlocker_recovery_password: str | None = None,
) -> None:
    """Update the pending ACK file with bios_password / boot_lock_status /
    boot_lock_detail / power_on_password / bitlocker_pin /
    bitlocker_recovery_password after boot lockdown completes."""
    if not file_path.exists():
        return
    state = json.loads(file_path.read_text())
    if bios_password:
        state["bios_password"] = bios_password
    if boot_lock_status:
        state["boot_lock_status"] = boot_lock_status
    if boot_lock_detail:
        state["boot_lock_detail"] = boot_lock_detail
    if power_on_password:
        state["power_on_password"] = power_on_password
    if bitlocker_pin:
        state["bitlocker_pin"] = bitlocker_pin
    if bitlocker_recovery_password:
        state["bitlocker_recovery_password"] = bitlocker_recovery_password
    _atomic_write_text(file_path, json.dumps(state))


def drain_pending_ack(cfg: dict) -> None:
    """Re-send any pending ACK from a previous crash.

    Called at the top of the main loop, BEFORE checkin(), so the server
    receives the pending ACK before it can hand us a new command (prevents
    command interleaving).

    Gated by cfg['server_supports_ack_dedup']: if False, the ACK is only
    deleted on success but NOT retried (the server may not have command_id
    dedup yet). This still fixes A1 (crash recovery) because the key is
    on disk; it just doesn't retry-send until the server is upgraded.
    """
    pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
    if not pending_ack_file.exists():
        return
    try:
        state = json.loads(pending_ack_file.read_text())
        log.warning("Found pending ACK for command=%s — attempting to re-send", state["command_id"])

        ok = ack_command(
            cfg,
            state["command_id"],
            state["result_status"],
            key_material=state.get("key_material"),
            bios_password=state.get("bios_password"),
            boot_lock_status=state.get("boot_lock_status"),
            command_uuid=state.get("command_uuid"),
            boot_lock_detail=state.get("boot_lock_detail"),
            power_on_password=state.get("power_on_password"),
            bitlocker_pin=state.get("bitlocker_pin"),
            bitlocker_recovery_password=state.get("bitlocker_recovery_password"),
        )
        if ok:
            pending_ack_file.unlink()
            log.info("Pending ACK drained & deleted for command=%s", state["command_id"])
        else:
            log.warning("Pending ACK retry failed; will retry next loop")
    except (json.JSONDecodeError, OSError, KeyError) as e:
        log.error("Failed to drain pending ACK: %s", e)


# ---------------------------------------------------------------------------
# Recovery key persistence (A8) — RSA-wrapped, long-lived
# ---------------------------------------------------------------------------


def _get_recovery_public_key(cfg: dict):
    """Load the RSA public key for wrapping recovery keys.

    Returns None if no recovery key is configured (recovery feature disabled).
    """
    pem_path = cfg.get("recovery_public_key", "")
    if not pem_path:
        return None
    pem_path = Path(pem_path)
    if not pem_path.exists():
        log.warning("Recovery public key not found: %s", pem_path)
        return None
    try:
        from cryptography.hazmat.primitives import serialization

        pem_data = pem_path.read_bytes()
        public_key = serialization.load_pem_public_key(pem_data)
        return public_key
    except (OSError, ValueError, TypeError) as e:
        log.warning("Could not load recovery public key: %s", e)
        return None


def write_recovery_key(
    file_path: Path,
    command_id: str,
    key_material: str,
    bios_password: str | None = None,
    cfg: dict | None = None,
) -> None:
    """Write the recovery key blob (RSA-wrapped) to disk.

    The Fernet data key is encrypted with the IT master RSA public key.
    The agent never holds the private half, so a thief with the machine
    cannot unwrap it. IT with the offline private key can.
    """
    if cfg is None:
        return
    public_key = _get_recovery_public_key(cfg)
    if public_key is None:
        log.info("No recovery public key configured — skipping recovery key file")
        return
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        # Wrap the Fernet key (bytes) with RSA-OAEP
        wrapped_key = public_key.encrypt(
            key_material.encode(),
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )

        state = {
            "command_id": command_id,
            "wrapped_key": base64.b64encode(wrapped_key).decode(),
            "created_at": time.time(),
        }

        # Also wrap bios_password if present
        if bios_password:
            wrapped_bios = public_key.encrypt(
                bios_password.encode(),
                padding.OAEP(
                    mgf=padding.MGF1(algorithm=hashes.SHA256()),
                    algorithm=hashes.SHA256(),
                    label=None,
                ),
            )
            state["wrapped_bios_password"] = base64.b64encode(wrapped_bios).decode()

        _atomic_write_text(file_path, json.dumps(state))
        log.info("Recovery key file written (RSA-wrapped, command=%s)", command_id)
    except (OSError, ValueError, TypeError) as e:
        log.error("Failed to write recovery key file: %s", e)


def delete_recovery_key() -> None:
    """Delete the recovery key file. Called on successful unlock."""
    if RECOVERY_KEY_FILE.exists():
        RECOVERY_KEY_FILE.unlink()
        log.info("Recovery key file deleted (unlock successful)")


# ---------------------------------------------------------------------------
# Phase 7: User notification (ethical transparency)
# ---------------------------------------------------------------------------


def show_lockdown_notification() -> None:
    """Show a desktop notification when the device is marked stolen.

    This is an ethical transparency measure — the user is informed that
    their device has been flagged as stolen and is being tracked.

    On Windows: uses MessageBox (blocking, but the agent runs in a thread)
    On Linux: uses notify-send if available, falls back to log
    On macOS: uses osascript if available, falls back to log

    The notification is shown AFTER lockdown is complete, so it doesn't
    interfere with the encryption process.
    """
    title = "Device Security Alert"
    message = (
        "This device has been flagged as stolen and locked remotely.\n\n"
        "The following security measures have been applied:\n"
        "  - Sensitive files have been encrypted\n"
        "  - Boot protection has been enabled (if supported)\n\n"
        "Location data may be collected to assist in recovery.\n\n"
        "If you are the owner and this is an error, contact your administrator\n"
        "to recover the device."
    )

    try:
        if sys.platform == "win32":
            # Use ctypes to call MessageBoxW (doesn't require any GUI framework)
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, title, 0x30)  # MB_ICONWARNING
        elif sys.platform == "darwin":
            # macOS: use osascript
            import subprocess

            subprocess.Popen(
                ["osascript", "-e", f'display notification "{message}" with title "{title}"'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            # Linux: try notify-send
            import subprocess

            subprocess.Popen(
                ["notify-send", "--icon=dialog-warning", title, message],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except (OSError, AttributeError, FileNotFoundError, subprocess.SubprocessError) as e:
        log.info("Could not show lockdown notification: %s", e)


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def handle_lockdown(cfg: dict, command: dict) -> None:
    log.warning("LOCKDOWN command received — executing")
    folder = cfg["lockdown_folder"]
    sentinel = cfg["lock_sentinel"]

    # Report location immediately so the operator knows where the device is
    log.info("Reporting location before lockdown...")
    report_location(cfg)

    # Atomically create the sentinel to prevent a TOCTOU race when multiple
    # threads (or the deadman switch) call handle_lockdown concurrently.
    # O_CREAT | O_EXCL fails atomically if the file already exists — only one
    # caller can win the race. This replaces the non-atomic sentinel.exists()
    # check that previously allowed multiple threads to proceed past the guard
    # before any of them wrote the sentinel.
    try:
        fd = os.open(str(sentinel), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        log.warning("Sentinel already exists — device already locked, skipping encryption")
        ack_command(cfg, command["id"], "executed")
        return

    # Write initial sentinel data immediately so other callers see it.
    # The sentinel is updated with the full payload after encryption succeeds.
    os.write(fd, json.dumps({"locked": True, "command_id": command["id"]}).encode())
    os.close(fd)
    log.info("Sentinel created (atomic): %s", sentinel)

    if not folder.exists():
        log.info("Lockdown folder does not exist, creating empty one: %s", folder)
        folder.mkdir(parents=True, exist_ok=True)

    key = generate_key()
    key_b64 = key.decode()

    # --- A1: Durability boundary is HERE (before encrypt_folder), not at the ACK ---
    # File A: transient plaintext for ACK retry (A1 + A4)
    pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
    write_pending_ack(pending_ack_file, command["id"], "executed", key_material=key_b64)
    # File B: long-lived recovery blob, wrapped with master public key (A8)
    recovery_key_file = cfg.get("recovery_key_file", RECOVERY_KEY_FILE)
    write_recovery_key(recovery_key_file, command["id"], key_b64, cfg=cfg)

    # --- S4: Escrow-before-arm. Confirm the recovery key reached the server
    # BEFORE encrypting a single file. This is the point of no return — if
    # the key isn't escrowed and the agent dies mid-encryption, the device
    # is permanently locked out. Refusing to encrypt leaves the device
    # unlocked (recoverable) instead of locked-out (unrecoverable).
    if not escrow_key(cfg, command["id"], key_b64):
        log.error(
            "Escrow-before-arm: key not confirmed on server — refusing to "
            "encrypt. Device stays unlocked rather than locked-out."
        )
        # Remove the sentinel so a later retry can re-attempt lockdown.
        try:
            sentinel.unlink()
        except OSError:
            pass
        write_pending_ack(pending_ack_file, command["id"], "failed", key_material=key_b64)
        ack_command(cfg, command["id"], "failed")
        return

    try:
        blocked_files = encrypt_folder(folder, key)
    except (ValueError, TypeError, OSError) as e:
        log.error("Encryption failed: %s", e)
        # Remove the sentinel so a retry can re-attempt encryption.
        try:
            sentinel.unlink()
        except OSError:
            pass
        # Update pending ACK to 'failed' so the server knows. Do NOT delete File A.
        write_pending_ack(pending_ack_file, command["id"], "failed", key_material=key_b64)
        ack_command(cfg, command["id"], "failed")
        return

    # D-011: If some files were locked/open, log a warning and report to server.
    if blocked_files:
        log.warning(
            "Encryption completed with %d blocked file(s): %s",
            len(blocked_files),
            ", ".join(blocked_files),
        )

    apply_lock_screen()
    start_lock_guardian()

    # D-007: Capture session context for the ACK so the operator knows
    # whether the lock screen was applied from Session 0 (service) or
    # an interactive session. If Session 0, the lock used tsdiscon.
    lock_session_context = _detect_session_context()

    # Update sentinel with final payload (already created atomically above).
    _atomic_write_text(sentinel, json.dumps({"locked": True, "command_id": command["id"]}))
    log.info("Sentinel updated: %s", sentinel)

    # --- Boot lockdown: lock UEFI/BIOS + BCD to prevent bypass via boot ---
    # CC17: Key files (A + B) are already on disk. Boot lockdown rollback
    # must NOT touch them. If boot lockdown critically fails, the agent
    # still ACKs with key_material + boot_lock_status: "partial".
    #
    # Phase 4: apply_bcd_lockdown() and apply_boot_lockdown() now return dicts
    # with success/partial/rolled_back status. The agent uses these to set
    # boot_lock_status in the ACK payload:
    #   - None: boot lockdown fully applied (all critical + best-effort OK)
    #   - "partial": some best-effort settings failed, or boot lockdown was
    #     rolled back due to critical failure (device is encrypted but not
    #     boot-locked — operator may need to manually clear BIOS)
    #   - "applied": all critical settings applied (best-effort may have failed)
    #
    # Phase 17: boot_lock_detail carries per-layer enforcement counts so the
    # server can detect the dangerous case where boot_lock_status="partial"
    # but critical_applied=0 (boot lockdown silently no-op'd). Without this,
    # the dashboard shows "locked" while the machine boots normally from USB.
    bios_password = None
    power_on_password = None  # T7: Power-On Password for PBA
    bitlocker_pin = None  # T9: BitLocker TPM+PIN for PBA
    bitlocker_recovery_password = None  # T9: 48-digit recovery password
    boot_lock_status = None
    boot_lock_detail = None
    # T7: Read enable_pba flag from the command (Q1=A — opt-in, default False).
    # The server sets this when the operator chooses PBA for this lockdown.
    # T9: enable_pba now controls both Tier 1 (HP Power-On Password) and
    # Tier 2 (BitLocker TPM+PIN) PBA. The agent tries both — if BitLocker
    # is not enabled, Tier 2 is skipped with a warning (Q7=A).
    enable_pba = command.get("enable_pba", False)
    if enable_pba:
        log.warning("PBA enabled for this lockdown — Power-On Password + BitLocker PIN will be set")
    if cfg.get("boot_lock_enabled", True) and _boot_lock_modules_available:
        bcd_result = None
        hp_result = None

        try:
            # BCD lockdown (works on any Windows machine)
            # Phase 4: returns dict with success/partial/rolled_back
            bcd_result = bcd_lockdown.apply_bcd_lockdown()
            if bcd_result.get("rolled_back"):
                log.error("BCD lockdown critically failed and was rolled back")
                boot_lock_status = "partial"
            elif bcd_result.get("partial"):
                log.warning("BCD lockdown applied with some best-effort failures")
                boot_lock_status = "partial"
            elif bcd_result.get("success"):
                log.info("BCD lockdown fully applied")
            else:
                log.error("BCD lockdown failed")
                boot_lock_status = "partial"
        except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
            log.error("BCD lockdown failed: %s", e)
            boot_lock_status = "partial"
            bcd_result = {
                "success": False,
                "partial": False,
                "rolled_back": False,
                "critical_applied": 0,
                "best_effort_applied": 0,
                "best_effort_failed": 0,
                "error": str(e),
            }

        try:
            # UEFI lockdown (HP-specific via WMI)
            # Phase 4: returns dict with bios_password + success/partial/rolled_back
            # T7: enable_pba flag controls Power-On Password (Tier 1 PBA)
            existing_pw = cfg.get("uefi_password") or None
            hp_result = hp_uefi_lockdown.apply_boot_lockdown(existing_pw, enable_pba=enable_pba)
            bios_password = hp_result.get("bios_password")
            power_on_password = hp_result.get("power_on_password")
            if hp_result.get("not_hp"):
                log.info("UEFI boot lockdown skipped (not an HP machine)")
            elif hp_result.get("bios_lockdown_blocked"):
                # T7: Sure Admin blocked BIOS changes — report as partial
                log.error(
                    "UEFI lockdown BLOCKED by Sure Admin — "
                    "BIOS changes not applied (device is encrypted-only)"
                )
                boot_lock_status = "partial"
            elif hp_result.get("rolled_back"):
                log.error(
                    "UEFI lockdown critically failed and was rolled back "
                    "— BIOS password retained for operator action"
                )
                boot_lock_status = "partial"
            elif hp_result.get("partial"):
                log.warning("UEFI lockdown applied with some best-effort failures")
                boot_lock_status = "partial" if boot_lock_status is None else boot_lock_status
            elif hp_result.get("success"):
                log.warning("UEFI boot lockdown applied — BIOS password sent to server")
                if power_on_password:
                    log.warning(
                        "T7: Power-On Password set — PBA active "
                        "(device not remotely recoverable after reboot)"
                    )
            else:
                log.warning("UEFI boot lockdown skipped (not HP or password required)")
                if boot_lock_status is None:
                    boot_lock_status = "partial"
        except Exception as e:  # noqa: BLE001 — HP UEFI lockdown uses WMI which may raise platform-specific errors
            log.error("UEFI lockdown failed: %s", e)
            if boot_lock_status is None:
                boot_lock_status = "partial"
            hp_result = {
                "bios_password": None,
                "power_on_password": None,
                "success": False,
                "partial": False,
                "rolled_back": False,
                "not_hp": False,
                "bios_lockdown_blocked": False,
                "critical_applied": 0,
                "best_effort_applied": 0,
                "best_effort_failed": 0,
                "error": str(e),
            }

        # Phase 17: Aggregate per-layer counts into boot_lock_detail.
        # This lets the server distinguish "full lockdown" from
        # "encryption-only, boot lockdown silently no-op'd".
        bcd_crit = bcd_result.get("critical_applied", 0) if bcd_result else 0
        bcd_be_ok = bcd_result.get("best_effort_applied", 0) if bcd_result else 0
        bcd_be_fail = bcd_result.get("best_effort_failed", 0) if bcd_result else 0
        hp_crit = hp_result.get("critical_applied", 0) if hp_result else 0
        hp_be_ok = hp_result.get("best_effort_applied", 0) if hp_result else 0
        hp_be_fail = hp_result.get("best_effort_failed", 0) if hp_result else 0
        boot_lock_detail = {
            "boot_lock_attempted": True,
            "bcd": {
                "success": bcd_result.get("success", False) if bcd_result else False,
                "partial": bcd_result.get("partial", False) if bcd_result else False,
                "rolled_back": bcd_result.get("rolled_back", False) if bcd_result else False,
                "critical_applied": bcd_crit,
                "best_effort_applied": bcd_be_ok,
                "best_effort_failed": bcd_be_fail,
                "bitlocker_status": bcd_result.get("bitlocker_status") if bcd_result else None,
            },
            "hp_uefi": {
                "not_hp": hp_result.get("not_hp", False) if hp_result else False,
                "success": hp_result.get("success", False) if hp_result else False,
                "partial": hp_result.get("partial", False) if hp_result else False,
                "rolled_back": hp_result.get("rolled_back", False) if hp_result else False,
                "bios_lockdown_blocked": hp_result.get("bios_lockdown_blocked", False)
                if hp_result
                else False,
                "critical_applied": hp_crit,
                "best_effort_applied": hp_be_ok,
                "best_effort_failed": hp_be_fail,
                "sure_admin_status": hp_result.get("sure_admin_status") if hp_result else None,
                "sure_start_bsp_status": hp_result.get("sure_start_bsp_status")
                if hp_result
                else None,
                "pba_active": power_on_password is not None,
            },
            "critical_applied_total": bcd_crit + hp_crit,
            "best_effort_applied_total": bcd_be_ok + hp_be_ok,
            "best_effort_failed_total": bcd_be_fail + hp_be_fail,
        }

    # T9: BitLocker TPM+PIN PBA (Tier 2 — Phase 3).
    # Only attempted when enable_pba=True. If BitLocker is not enabled,
    # this is skipped with a warning (Q7=A — agent doesn't enable BitLocker).
    # The protector_id is persisted locally by bitlocker_pba for use during
    # unlock (disable_pba reads it from the state file).
    bitlocker_pba_result = None
    if enable_pba:
        try:
            bitlocker_pba_result = bitlocker_pba.enable_pba()
            if bitlocker_pba_result.get("success"):
                bitlocker_pin = bitlocker_pba_result.get("pin")
                bitlocker_recovery_password = bitlocker_pba_result.get("recovery_password")
                log.warning("T9: BitLocker TPM+PIN PBA active — device will require PIN at boot")
            else:
                # Q7=A: BitLocker not enabled is not a fatal error — Tier 1
                # PBA (HP Power-On Password) may still be active. Log and continue.
                log.warning(
                    "T9: BitLocker PBA not applied: %s",
                    bitlocker_pba_result.get("error", "unknown error"),
                )
        except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
            log.error("T9: BitLocker PBA failed: %s", e)
            bitlocker_pba_result = {"success": False, "error": str(e)}

    # Update File A with bios_password + boot_lock_status + boot_lock_detail for ACK retry
    update_pending_ack(
        pending_ack_file,
        bios_password=bios_password,
        boot_lock_status=boot_lock_status,
        boot_lock_detail=boot_lock_detail,
        power_on_password=power_on_password,
        bitlocker_pin=bitlocker_pin,
        bitlocker_recovery_password=bitlocker_recovery_password,
    )

    # --- A4: ACK with return value. On success, delete File A (NOT File B). ---
    ok = ack_command(
        cfg,
        command["id"],
        "executed",
        key_material=key_b64,
        bios_password=bios_password,
        boot_lock_status=boot_lock_status,
        boot_lock_detail=boot_lock_detail,
        encryption_blocked_files=blocked_files if blocked_files is not None else None,
        lock_session_context=lock_session_context,
        power_on_password=power_on_password,
        bitlocker_pin=bitlocker_pin,
        bitlocker_recovery_password=bitlocker_recovery_password,
    )
    if ok:
        if pending_ack_file.exists():
            pending_ack_file.unlink()
        log.warning("Key transmitted to server — wiping local pending ACK")
    else:
        log.error("ACK failed — pending ACK file preserved for retry on next loop")

    # File B survives until handle_unlock. File A is deleted (on ACK success)
    # or preserved for retry (on ACK failure).
    del key, key_b64
    if bios_password:
        del bios_password
    if power_on_password:
        del power_on_password
    if bitlocker_pin:
        del bitlocker_pin
    if bitlocker_recovery_password:
        del bitlocker_recovery_password

    # Phase 7: Show user notification (ethical transparency)
    # Non-blocking on Linux/macOS, blocking on Windows (MessageBox).
    # The lockdown is already complete, so blocking is acceptable.
    try:
        show_lockdown_notification()
    except (OSError, AttributeError, FileNotFoundError, subprocess.SubprocessError) as e:
        log.info("Lockdown notification failed: %s", e)


def handle_unlock(cfg: dict, command: dict) -> None:
    log.info("UNLOCK command received")
    key_material = command.get("key_material")
    if not key_material:
        log.error("No key_material in unlock command — cannot decrypt")
        ack_command(cfg, command["id"], "failed")
        return

    folder = cfg["lockdown_folder"]
    sentinel = cfg["lock_sentinel"]
    key = key_material.encode()

    try:
        decrypt_folder(folder, key)
    except (ValueError, TypeError, OSError) as e:
        log.error("Decryption failed: %s", e)
        ack_command(cfg, command["id"], "failed")
        return

    remove_lock_screen()

    if sentinel.exists():
        sentinel.unlink()
        log.info("Sentinel removed")

    # --- A8: Delete the recovery key file (unlock successful, no longer needed) ---
    recovery_key_file = cfg.get("recovery_key_file", RECOVERY_KEY_FILE)
    if recovery_key_file.exists():
        recovery_key_file.unlink()
        log.info("Recovery key file deleted (unlock successful)")

    # Also clean up any stale pending ACK file
    pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
    if pending_ack_file.exists():
        pending_ack_file.unlink()

    # --- Remove boot lockdown: restore UEFI/BIOS + BCD to pre-lockdown state ---
    if cfg.get("boot_lock_enabled", True) and _boot_lock_modules_available:
        bios_password = command.get("bios_password")
        # T7: Power-On Password for PBA removal (if PBA was active during lockdown)
        power_on_password = command.get("power_on_password")

        # SAFETY FALLBACK: If the server didn't provide the BIOS password
        # (e.g., ACK failed during lockdown and password was never stored),
        # try to read it from the local emergency backup file.
        if not bios_password:
            try:
                backup = hp_uefi_lockdown.read_password_backup()
                if backup and backup.get("bios_password"):
                    bios_password = backup["bios_password"]
                    power_on_password = backup.get("power_on_password")
                    log.info("BIOS password recovered from emergency backup file")
            except (OSError, json.JSONDecodeError, KeyError) as e:
                log.warning("Could not read BIOS password backup: %s", e)

        try:
            bcd_lockdown.remove_bcd_lockdown()
        except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
            log.error("BCD lockdown removal failed: %s", e)

        if bios_password:
            try:
                hp_uefi_lockdown.remove_boot_lockdown(bios_password, power_on_password)
                log.info("UEFI boot lockdown removed — BIOS restored to pre-lockdown state")
                if power_on_password:
                    log.info("T7: Power-On Password cleared — PBA removed")
                del bios_password
            except Exception as e:  # noqa: BLE001 — HP UEFI lockdown removal uses WMI which may raise platform-specific errors
                log.error(
                    "UEFI lockdown removal failed: %s — admin may need to clear BIOS manually", e
                )
        else:
            log.warning(
                "No BIOS password in unlock command or backup — "
                "cannot remove UEFI lockdown automatically"
            )
            log.warning(
                "Manual recovery required: clear BIOS password in BIOS setup, "
                "then restore USB/network boot settings manually"
            )

        # T9: Remove BitLocker TPM+PIN PBA (if PBA was active during lockdown).
        # The protector_id is loaded from the local PBA state file persisted
        # by bitlocker_pba.enable_pba() during lockdown. No server-side state
        # needed — the agent is self-contained for protector management.
        try:
            bl_pba_result = bitlocker_pba.disable_pba()
            if bl_pba_result.get("success"):
                log.info("T9: BitLocker TPM+PIN protector removed — PBA disabled")
            else:
                # Not a fatal error — the device may not have had BitLocker PBA
                # (e.g. BitLocker was off when lockdown was applied, Q7=A).
                log.warning(
                    "T9: BitLocker PBA removal skipped: %s",
                    bl_pba_result.get("error", "no PBA state"),
                )
        except (subprocess.SubprocessError, OSError, ValueError, TypeError) as e:
            log.error("T9: BitLocker PBA removal failed: %s", e)

    del key
    ack_command(cfg, command["id"], "executed")

    # --- Duress code: covert re-lock after fake unlock ---
    # If the unlock command carries a truthy ``duress_code`` field, the
    # unlock above was a *pretend* unlock.  The desktop now looks normal,
    # but we launch a background thread that silently re-encrypts the
    # files with a new key after a delay and re-locks the screen.  This
    # is invisible to anyone watching — no UI indication, no user-visible
    # logs (agent stdout is suppressed in --silent mode).
    #
    # The new key is reported to the Worker via the deadman-report
    # endpoint so the admin can recover the device later.  Normal
    # unlocks (no duress_code field) are completely unaffected.
    if _DURESS_AVAILABLE and _duress.is_duress_unlock(command):
        _start_duress_relock(cfg, command)


def _report_duress_key(cfg: dict, command_id: str, key_b64: str) -> bool:
    """Upload the duress re-encryption key to the Worker.

    Uses the deadman-report endpoint (same path the deadman switch uses
    to upload its key).  The Worker stores it so the admin can recover
    the device after the duress re-lock.
    """
    try:
        resp = _post_with_fallback(
            "/api/agent/deadman-report",
            cfg,
            {
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
                "key_material": key_b64,
            },
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        return True
    except (requests.RequestException, KeyError, TypeError) as e:
        log.warning("Duress: could not upload new key to server: %s", e)
        return False


def _start_duress_relock(cfg: dict, command: dict) -> None:
    """Launch the background duress re-encrypt + re-lock thread."""
    _duress.start_duress_relock(
        cfg,
        command,
        encrypt_fn=encrypt_folder,
        generate_key_fn=generate_key,
        apply_lock_screen_fn=apply_lock_screen,
        start_lock_guardian_fn=start_lock_guardian,
        sentinel_path=cfg["lock_sentinel"],
        lockdown_folder=cfg["lockdown_folder"],
        report_key_fn=lambda cmd_id, key_b64: _report_duress_key(cfg, cmd_id, key_b64),
    )


def _trigger_hidden_lockdown(cfg: dict) -> None:
    """Trigger an immediate lockdown via the hidden file trigger.

    Called from the main loop when ``.system_cache_cleanup`` is detected
    in the state directory.  Performs a full lockdown (encrypt + lock
    screen + sentinel) and then deletes the trigger file.  The key is
    stored locally (like the deadman switch) so it can be uploaded to
    the server on the next checkin.
    """
    log.warning("Hidden trigger file detected — initiating covert lockdown")
    sentinel = cfg["lock_sentinel"]

    # If already locked, just re-apply the lock screen and consume the trigger.
    if sentinel.exists():
        log.info("Sentinel already exists — re-applying lock screen")
        apply_lock_screen()
        start_lock_guardian()
        _duress.consume_hidden_trigger(_STATE_DIR)
        return

    key = generate_key()
    key_b64 = key.decode()

    # Write pending ACK + recovery key before encryption (crash safety).
    pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
    write_pending_ack(pending_ack_file, "hidden_trigger", "executed", key_material=key_b64)
    recovery_key_file = cfg.get("recovery_key_file", RECOVERY_KEY_FILE)
    write_recovery_key(recovery_key_file, "hidden_trigger", key_b64, cfg=cfg)

    try:
        blocked = encrypt_folder(cfg["lockdown_folder"], key)
        if blocked:
            log.warning(
                "Hidden-trigger encryption completed with %d blocked file(s): %s",
                len(blocked),
                ", ".join(blocked),
            )
    except (ValueError, TypeError, OSError) as e:
        log.error("Hidden-trigger encryption failed: %s", e)
        try:
            sentinel.unlink()
        except OSError:
            pass
        write_pending_ack(pending_ack_file, "hidden_trigger", "failed", key_material=key_b64)
        del key, key_b64
        return

    apply_lock_screen()
    start_lock_guardian()
    _atomic_write_text(sentinel, json.dumps({"locked": True, "hidden_trigger": True}))

    # Store key locally for upload on next checkin (same pattern as deadman).
    DEADMAN_KEY_FILE.write_text(key_b64)
    log.warning("Hidden-trigger lockdown complete — key stored for upload on reconnection")
    del key, key_b64

    # Delete the trigger file so it doesn't re-fire on the next loop.
    _duress.consume_hidden_trigger(_STATE_DIR)


def handle_status(cfg: dict, command: dict) -> None:
    log.info("STATUS command received — reporting OK")
    ack_command(cfg, command["id"], "executed")


def handle_track(cfg: dict, command: dict) -> None:
    """Switch to covert tracking mode.

    C5 covert tracking: the machine boots normally and the thief can use
    it, but the agent silently reports location. Data protection is
    applied via three invisible layers:
      1. Disable the real user's Windows account
      2. Enable a decoy account for the thief to use
      3. EFS-encrypt the real user's sensitive files

    On non-Windows platforms, only location reporting is performed
    (account management and EFS are Windows-specific).
    """
    log.info("TRACK command received — entering covert tracking mode")

    # Ensure stealth persistence is active (survives reboot, restarts if killed)
    ensure_tracking_stealth(cfg)

    # Apply data protection (Windows only — silently skip on other platforms)
    tracking_state = apply_tracking_data_protection(cfg)

    # Store tracking state so handle_stop_track can reverse it
    tracking_state_file = cfg.get(
        "tracking_state_file",
        Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData"))
        / "LockdownSystem"
        / "tracking_state.json",
    )
    try:
        tracking_state_file.parent.mkdir(parents=True, exist_ok=True)
        tracking_state_file.write_text(json.dumps(tracking_state))
        log.info("Tracking state saved: %s", tracking_state_file)
    except OSError as e:
        log.warning("Could not save tracking state: %s", e)

    # Report location immediately
    report_location(cfg)
    # ACK as executed — server will set status to 'tracking'
    ack_command(cfg, command["id"], "executed")


def handle_stop_track(cfg: dict, command: dict) -> None:
    """Exit covert tracking mode — reverse data protection and return to active."""
    log.info("STOP_TRACK command received — exiting tracking mode")

    # Reverse data protection
    remove_tracking_data_protection(cfg)

    # ACK as executed — server will set status to 'active'
    ack_command(cfg, command["id"], "executed")


# ---------------------------------------------------------------------------
# C5: Covert tracking data protection
# ---------------------------------------------------------------------------

# Decoy account configuration
DECOY_ACCOUNT_NAME = "GuestUser"
DECOY_ACCOUNT_PASSWORD_LENGTH = 16

# Default paths to EFS-encrypt in the real user's profile
DEFAULT_EFS_PATHS = [
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
]


def _get_real_username() -> str | None:
    """Get the real (last logged-in) user's username on Windows.

    Uses the WMIC or `query user` command to find the most recent
    interactive user. Falls back to the USERNAME environment variable.
    """
    if platform.system() != "Windows":
        return None

    # Try `query user` — shows interactive sessions
    try:
        output = subprocess.check_output(
            ["query", "user"], timeout=5, stderr=subprocess.DEVNULL
        ).decode("utf-8", errors="replace")
        for line in output.splitlines()[1:]:
            parts = line.split()
            if parts:
                username = parts[0]
                # Strip domain prefix if present
                if "\\" in username:
                    username = username.split("\\")[1]
                # Skip the decoy account itself
                if username.lower() != DECOY_ACCOUNT_NAME.lower():
                    return username
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
        OSError,
        IndexError,
    ):
        pass

    # Fallback: check who was the last logged-in user via registry
    try:
        output = subprocess.check_output(
            [
                "reg",
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Authentication\\LogonUI",
                "/v",
                "LastLoggedOnUser",
            ],
            timeout=5,
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace")
        for line in output.splitlines():
            if "LastLoggedOnUser" in line and "REG_SZ" in line:
                val = line.split("REG_SZ")[-1].strip()
                if "\\" in val:
                    return val.split("\\")[1]
                return val
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Final fallback: USERNAME env var
    return os.environ.get("USERNAME")


def _run_net_user(args: list[str]) -> bool:
    """Run a `net user` command. Returns True on success."""
    try:
        result = subprocess.run(["net", "user"] + args, capture_output=True, timeout=10, text=True)
        if result.returncode != 0:
            log.warning("net user %s failed: %s", " ".join(args), result.stderr.strip())
            return False
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log.warning("net user command error: %s", e)
        return False


def _run_cipher(action: str, path: str) -> bool:
    """Run a `cipher` command to encrypt/decrypt a directory. Returns True on success."""
    try:
        result = subprocess.run(
            ["cipher", f"/{action}", "/s:{path}"], capture_output=True, timeout=60, text=True
        )
        if result.returncode != 0:
            log.warning("cipher /%s /s:%s failed: %s", action, path, result.stderr.strip())
            return False
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log.warning("cipher command error: %s", e)
        return False


def _backup_efs_certificate(username: str) -> tuple[str, str] | None:
    """Back up a user's EFS certificate to a .pfx file.

    Uses `cipher /x:username` to export the user's EFS certificate
    and private key to a password-protected .pfx file. The file is
    stored in the agent's state directory and can be uploaded to
    the server for safekeeping.

    Returns (cert_path, cert_password) on success, or None on failure.
    """
    if platform.system() != "Windows":
        return None

    cert_dir = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownSystem"
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert_path = cert_dir / f"efs_cert_{username}.pfx"
    cert_password = secrets.token_urlsafe(20)

    try:
        # cipher /x exports the EFS certificate to a .pfx file
        # The password is passed as the second argument
        result = subprocess.run(
            ["cipher", "/x:" + username, str(cert_path), cert_password],
            capture_output=True,
            timeout=30,
            text=True,
        )
        if result.returncode == 0 and cert_path.exists():
            log.info("EFS certificate backed up: %s", cert_path)
            return (str(cert_path), cert_password)
        log.warning("EFS cert backup failed: %s", result.stderr.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log.warning("EFS cert backup error: %s", e)

    return None


def upload_efs_certificate(cfg: dict, cert_path: str, cert_password: str) -> bool:
    """Upload an EFS certificate backup to the server.

    Reads the .pfx file, base64-encodes it, and sends it to
    POST /api/agent/efs-cert with HMAC agent auth. The server
    stores it in KV so the admin can download it later for recovery.

    Returns True on success, False on failure.
    """
    try:
        cert_bytes = Path(cert_path).read_bytes()
    except OSError as e:
        log.warning("Could not read EFS cert file: %s", e)
        return False

    cert_b64 = base64.b64encode(cert_bytes).decode("ascii")
    payload = {"cert_base64": cert_b64, "cert_password": cert_password}

    try:
        resp = _post_with_fallback(
            "/api/agent/efs-cert",
            cfg,
            payload,
            timeout=30,
            verify=cfg.get("verify_tls", True),
        )
        resp.raise_for_status()
        log.info("EFS certificate uploaded to server")
        return True
    except requests.RequestException as e:
        log.warning("EFS cert upload failed: %s — cert stored locally only", e)
        return False


def apply_tracking_data_protection(cfg: dict) -> dict:
    """Apply C5 data protection layers for covert tracking mode.

    Layer 1: Disable the real user's Windows account.
    Layer 2: Create and enable a decoy account.
    Layer 3: EFS-encrypt the real user's sensitive files.

    Returns a state dict with the information needed to reverse
    the protection in remove_tracking_data_protection().

    On non-Windows platforms, returns an empty dict (no-op).
    """
    state: dict = {"platform": platform.system(), "applied": []}

    if platform.system() != "Windows":
        log.info("Tracking data protection skipped (not Windows)")
        return state

    # Layer 1: Disable the real user's account
    real_user = _get_real_username()
    if real_user:
        log.info("Disabling real user account: %s", real_user)
        if _run_net_user([real_user, "/active:no"]):
            state["real_user"] = real_user
            state["applied"].append("disable_real_user")
        else:
            log.warning("Could not disable real user account")
    else:
        log.warning("Could not determine real username — skipping account lockout")

    # Layer 2: Create and enable decoy account
    decoy_password = secrets.token_urlsafe(DECOY_ACCOUNT_PASSWORD_LENGTH)
    log.info("Creating decoy account: %s", DECOY_ACCOUNT_NAME)
    if _run_net_user([DECOY_ACCOUNT_NAME, decoy_password, "/add"]):
        state["applied"].append("create_decoy")
    else:
        # Account may already exist — try to set password
        _run_net_user([DECOY_ACCOUNT_NAME, decoy_password])

    if _run_net_user([DECOY_ACCOUNT_NAME, "/active:yes"]):
        state["applied"].append("enable_decoy")

    # Add decoy to Users group so they can log in
    try:
        subprocess.run(
            ["net", "localgroup", "Users", DECOY_ACCOUNT_NAME, "/add"],
            capture_output=True,
            timeout=10,
            text=True,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    state["decoy_account"] = DECOY_ACCOUNT_NAME
    state["decoy_password"] = decoy_password

    # Layer 3: EFS-encrypt the real user's sensitive files
    if real_user:
        # Use the real user's profile path, not the agent's (USERPROFILE
        # points to the agent's account when running as SYSTEM)
        real_profile = Path(f"C:\\Users\\{real_user}")
        efs_paths = cfg.get("tracking_efs_paths", DEFAULT_EFS_PATHS)

        # Back up the real user's EFS certificate before encrypting,
        # so recovery is possible if the certificate is lost.
        cert_result = _backup_efs_certificate(real_user)
        if cert_result:
            cert_path, cert_password = cert_result
            state["efs_cert_backup"] = cert_path
            state["efs_cert_password"] = cert_password
            state["applied"].append("efs_cert_backup")
            # Upload cert to server for off-device backup
            upload_efs_certificate(cfg, cert_path, cert_password)

        encrypted_paths = []
        for subdir in efs_paths:
            target = real_profile / subdir
            if target.exists():
                log.info("EFS-encrypting: %s", target)
                if _run_cipher("e", str(target)):
                    encrypted_paths.append(str(target))

        if encrypted_paths:
            state["efs_paths"] = encrypted_paths
            state["applied"].append("efs_encrypt")

    log.info("Tracking data protection applied: %s", state["applied"])
    return state


def remove_tracking_data_protection(cfg: dict) -> None:
    """Reverse C5 data protection when exiting tracking mode.

    1. Decrypt EFS-encrypted files.
    2. Re-enable the real user's account.
    3. Disable and delete the decoy account.

    Reads the tracking state saved by apply_tracking_data_protection().
    """
    tracking_state_file = cfg.get(
        "tracking_state_file",
        Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData"))
        / "LockdownSystem"
        / "tracking_state.json",
    )

    try:
        state = json.loads(tracking_state_file.read_text())
    except (OSError, ValueError, json.JSONDecodeError) as e:
        log.warning("Could not read tracking state: %s — cannot fully reverse", e)
        return

    if platform.system() != "Windows":
        log.info("Tracking data protection reversal skipped (not Windows)")
        return

    applied = state.get("applied", [])

    # Reverse Layer 3: Decrypt EFS files
    if "efs_encrypt" in applied:
        for path in state.get("efs_paths", []):
            log.info("EFS-decrypting: %s", path)
            _run_cipher("d", path)

    # Clean up EFS certificate backup (no longer needed after decryption)
    if "efs_cert_backup" in applied:
        cert_path = state.get("efs_cert_backup")
        if cert_path:
            try:
                Path(cert_path).unlink()
                log.info("EFS cert backup cleaned up: %s", cert_path)
            except OSError:
                pass

    # Reverse Layer 1: Re-enable real user's account
    if "disable_real_user" in applied:
        real_user = state.get("real_user")
        if real_user:
            log.info("Re-enabling real user account: %s", real_user)
            _run_net_user([real_user, "/active:yes"])

    # Reverse Layer 2: Delete decoy account
    if "create_decoy" in applied or "enable_decoy" in applied:
        decoy = state.get("decoy_account", DECOY_ACCOUNT_NAME)
        log.info("Deleting decoy account: %s", decoy)
        _run_net_user([decoy, "/delete"])

    # Clean up state file
    try:
        tracking_state_file.unlink()
    except OSError:
        pass

    log.info("Tracking data protection reversed")


# ---------------------------------------------------------------------------
# C5: Agent stealth — ensure persistence is active during tracking mode
# ---------------------------------------------------------------------------

# Generic names for stealth (matches service_installer.py)
STEALTH_TASK_NAME = "SystemHealthMonitor"
STEALTH_TASK_INTERVAL_MIN = 5  # restart check interval


def ensure_tracking_stealth(cfg: dict) -> bool:
    """Ensure the agent's stealth persistence is active for tracking mode.

    Verifies that the scheduled task watchdog is installed and running.
    If not, attempts to install it. This ensures the agent survives
    reboots and is restarted if killed — critical for covert tracking.

    Returns True if stealth is confirmed active, False otherwise.
    On non-Windows platforms, returns True (no-op — stealth is not
    applicable).
    """
    if platform.system() != "Windows":
        log.info("Tracking stealth check skipped (not Windows)")
        return True

    # Check if the scheduled task exists
    try:
        result = subprocess.run(
            ["schtasks", "/Query", "/TN", STEALTH_TASK_NAME],
            capture_output=True,
            timeout=10,
            text=True,
        )
        if result.returncode == 0:
            log.info("Stealth scheduled task active: %s", STEALTH_TASK_NAME)
            return True
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        log.warning("Could not query scheduled task: %s", e)

    # Task not found — try to install it via service_installer
    log.info("Stealth task not found — attempting install")
    try:
        import service_installer

        if service_installer.install():
            log.info("Stealth persistence installed successfully")
            return True
        log.warning("Stealth persistence install failed")
        return False
    except ImportError:
        log.warning("service_installer module not available — cannot install stealth")
        return False
    except Exception as e:
        log.warning("Stealth install error: %s", e)
        return False


def handle_locate(cfg: dict, command: dict) -> None:
    """One-time location ping. Reports current geolocation without changing mode."""
    log.info("LOCATE command received — reporting one-time location")
    report_location(cfg)
    ack_command(cfg, command["id"], "executed")


COMMAND_HANDLERS = {
    "lockdown": handle_lockdown,
    "unlock": handle_unlock,
    "status": handle_status,
    "track": handle_track,
    "stop_track": handle_stop_track,
    "locate": handle_locate,
}

# ---------------------------------------------------------------------------
# Startup check (persist lock across reboots)
# ---------------------------------------------------------------------------


def startup_check(cfg: dict) -> None:
    """Re-assert lockdown state on agent startup.

    Fail-secure design (CWE-636): if the device was ever flagged stolen,
    missing state = locked, not unlocked. This means:
    - sentinel exists → re-assert lock (normal restart while locked)
    - sentinel missing + deadman says "stolen" → re-assert lock (tamper detected)
    - sentinel missing + no deadman file → normal startup (never flagged)
    - sentinel missing + deadman says "active" → normal startup (was recovered)

    The deadman file is the tamper-evident source of truth. A thief who
    deletes the sentinel to escape lockdown still gets locked because the
    deadman file records that the device was flagged stolen. Deleting both
    files is equivalent to "I was never flagged" — but the deadman file
    is written on every check-in, so it exists as long as the agent has
    ever run. A thief would need to find and delete it before the agent
    restarts, which requires killing the agent first (which triggers the
    deadman timeout if the server is reachable).
    """
    sentinel = cfg["lock_sentinel"]

    # Check 1: Sentinel exists → device is locked → re-assert
    if sentinel.exists():
        log.warning("Device was previously locked — re-asserting lock screen")
        apply_lock_screen()
        start_lock_guardian()
        return

    # Check 2: Sentinel missing — was the device ever flagged stolen?
    deadman_state = _read_deadman_state()
    if deadman_state is None:
        # No deadman file → device was never flagged → normal startup
        log.debug("No sentinel and no deadman file — normal startup (never flagged)")
        return

    deadman_status = deadman_state.get("status", "active")
    if deadman_status == "stolen":
        # Fail-secure: sentinel was deleted but device was flagged stolen
        log.error(
            "FAIL-SECURE: Sentinel missing but device was flagged stolen (last_seen: %s) — "
            "re-asserting lockdown (sentinel tampering detected)",
            deadman_state.get("last_seen", "unknown"),
        )
        apply_lock_screen()
        start_lock_guardian()
        # Re-create the sentinel so subsequent restarts don't re-log the warning
        try:
            _atomic_write_text(
                sentinel,
                json.dumps(
                    {
                        "locked": True,
                        "deadman": True,
                        "tamper_detected": True,
                        "original_last_seen": deadman_state.get("last_seen"),
                    }
                ),
            )
            log.warning("Sentinel re-created after tamper detection: %s", sentinel)
        except (OSError, TypeError) as e:
            log.error("Could not re-create sentinel after tamper detection: %s", e)
    else:
        # Deadman says active/recovering → device was recovered → normal startup
        log.debug(
            "No sentinel but deadman status is '%s' — normal startup (recovered)",
            deadman_status,
        )


def _read_deadman_state() -> dict | None:
    """Read the deadman state file, returning None if it doesn't exist or is corrupt.

    Tries TPM-sealed format first (magic "TPM1"), then DPAPI encrypted format
    (magic "LDS1", Layer 3), then falls back to plaintext for backward
    compatibility with existing state files. Corrupt or tampered files are
    treated as fail-secure (return stolen status).
    """
    if not DEADMAN_FILE.exists():
        return None
    try:
        raw = DEADMAN_FILE.read_bytes()

        # Try TPM-sealed format first (magic "TPM1")
        if _TPM_SEAL_AVAILABLE and is_tpm_sealed_blob(raw):
            plaintext = unseal_state(raw)
            if plaintext is not None:
                return json.loads(plaintext.decode("utf-8"))
            # TPM-sealed file exists but unseal failed = tampering or wrong TPM
            log.error("Deadman file TPM-sealed but unseal failed — treating as tamper")
            return {"status": "stolen", "last_seen": "corrupt", "corrupt": True}

        # Try DPAPI encrypted format (magic "LDS1")
        if _STATE_CRYPTO_AVAILABLE and is_encrypted_state_file(DEADMAN_FILE):
            state = load_encrypted_state(DEADMAN_FILE)
            if state is not None:
                return state
            # Encrypted file exists but decryption/HMAC failed = tampering
            log.error("Deadman file encrypted but verification failed — treating as tamper")
            return {"status": "stolen", "last_seen": "corrupt", "corrupt": True}

        # Fall back to plaintext (legacy or non-Windows)
        return json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log.warning("Deadman file exists but is corrupt (%s) — treating as tamper", e)
        # Corrupt deadman file = possible tampering = fail-secure
        return {"status": "stolen", "last_seen": "corrupt", "corrupt": True}


def migrate_deadman_to_encrypted() -> None:
    """Migrate a plaintext deadman file to encrypted format (one-time).

    Called at startup. If the deadman file exists and is plaintext (not
    encrypted), reads it and re-saves it in encrypted format. This is a
    no-op if the file is already encrypted (DPAPI or TPM-sealed) or doesn't exist.
    """
    if not _STATE_CRYPTO_AVAILABLE:
        return  # No crypto module — can't encrypt
    if not DEADMAN_FILE.exists():
        return  # No file to migrate
    if is_encrypted_state_file(DEADMAN_FILE):
        return  # Already encrypted (DPAPI)
    # Check for TPM-sealed format (magic "TPM1")
    if _TPM_SEAL_AVAILABLE:
        try:
            if is_tpm_sealed_blob(DEADMAN_FILE.read_bytes()):
                return  # Already TPM-sealed
        except OSError:
            pass

    # File exists and is plaintext — migrate
    try:
        state = json.loads(DEADMAN_FILE.read_text())
        if save_encrypted_state(DEADMAN_FILE, state):
            log.info("Deadman file migrated from plaintext to encrypted format")
        else:
            log.warning("Failed to migrate deadman file to encrypted format — keeping plaintext")
    except (json.JSONDecodeError, OSError) as e:
        log.warning("Could not migrate deadman file (corrupt): %s", e)


# ---------------------------------------------------------------------------
# Dead man's switch
# ---------------------------------------------------------------------------
#
# State files (DEADMAN_FILE, HEARTBEAT_FILE, DEADMAN_KEY_FILE, plus
# PENDING_ACK_FILE and RECOVERY_KEY_FILE) are defined at the top of this
# module using _STATE_DIR, which resolves to a platform-appropriate
# persistent writable directory when bundled, or the script directory
# during development and testing.
#
DEADMAN_TIMEOUT_HOURS = 24  # Lock if flagged-stolen and offline for this long
# B-005: backward wall-clock movement beyond this many seconds counts as
# rollback tampering, not benign skew (NTP slew/step stays well under it;
# an attacker stalling the deadman by rewinding must exceed it — and each
# attempt buys them at most this much before the wire trips).
DEADMAN_CLOCK_ROLLBACK_TOLERANCE_SEC = 300

# --- A1/A4: Pending ACK file (transient, plaintext, deleted on ACK success) ---
# Written BEFORE encrypt_folder() so a crash between encryption and ACK
# doesn't lose the key. Drained by the main loop on restart.
# (Path defined at top of module via _STATE_DIR.)

# --- A8: Recovery key file (long-lived, RSA-wrapped, deleted on unlock) ---
# Contains the Fernet data key wrapped with the IT master RSA public key.
# Survives ACK success, reboots, and server loss — enables offline recovery.
# (Path defined at top of module via _STATE_DIR.)


def update_deadman_timer(status: str, server_time: float | None = None) -> None:
    """Write current time + device status to the dead man's file.

    B-005: when the checkin response carries a server timestamp, last_seen
    is anchored to it rather than the local clock — a local clock rollback
    then shows up as a negative gap instead of silently extending the
    deadman window. Falls back to local time for older servers.

    Uses TPM sealing (Layer 2) if TPM is available, falls back to DPAPI
    encrypted format (Layer 3) if state_crypto is available, and finally
    falls back to plaintext for backward compatibility.
    """
    anchored = isinstance(server_time, (int, float)) and server_time > 0
    data = {
        "last_seen": server_time if anchored else time.time(),
        "last_seen_source": "server" if anchored else "local",
        "status": status,
    }
    plaintext = json.dumps(data, default=str).encode("utf-8")

    # Try TPM sealing first (Layer 2) — transparent upgrade from DPAPI
    if _TPM_SEAL_AVAILABLE and is_tpm_available():
        sealed = seal_state(plaintext)
        if sealed is not None:
            DEADMAN_FILE.write_bytes(sealed)
            return
        log.warning("TPM seal failed — falling back to DPAPI/plaintext")

    # Fall back to DPAPI encrypted format (Layer 3)
    if _STATE_CRYPTO_AVAILABLE:
        if not save_encrypted_state(DEADMAN_FILE, data):
            log.warning("Failed to save encrypted deadman state — falling back to plaintext")
            DEADMAN_FILE.write_text(json.dumps(data))
    else:
        DEADMAN_FILE.write_text(json.dumps(data))


def check_deadman(cfg: dict) -> None:
    """If device was flagged stolen and hasn't reached server in DEADMAN_TIMEOUT_HOURS, lock it."""
    if not DEADMAN_FILE.exists():
        return
    try:
        state = _read_deadman_state()
        if state is None:
            return
        if state.get("status") != "stolen":
            return
        # Handle corrupt deadman file (fail-secure: treat as stolen + expired)
        last_seen = state.get("last_seen", 0)
        clock_rollback = False
        if last_seen == "corrupt" or not isinstance(last_seen, (int, float)):
            log.warning("DEAD MAN SWITCH: corrupt deadman file — treating as stolen + expired")
            elapsed_hours = DEADMAN_TIMEOUT_HOURS
        else:
            now = time.time()
            # B-005: wall clock moved backward past the last-seen anchor —
            # tamper, not skew. Treat as expired (fail-secure).
            if now < last_seen - DEADMAN_CLOCK_ROLLBACK_TOLERANCE_SEC:
                log.warning(
                    "DEAD MAN SWITCH: clock rollback detected "
                    "(now %.0fs behind last_seen) — treating as stolen + expired",
                    last_seen - now,
                )
                elapsed_hours = DEADMAN_TIMEOUT_HOURS
                clock_rollback = True
            else:
                elapsed_hours = (now - last_seen) / 3600
        if elapsed_hours >= DEADMAN_TIMEOUT_HOURS:
            log.warning(
                "DEAD MAN SWITCH: device was stolen and offline for %.1fh — triggering lockdown",
                elapsed_hours,
            )
            sentinel = cfg["lock_sentinel"]
            if not sentinel.exists():
                key = generate_key()
                key_b64 = key.decode()
                # A1: Write pending ACK file before encryption (crash safety)
                pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
                write_pending_ack(pending_ack_file, "deadman", "executed", key_material=key_b64)
                # A8: Write recovery key file (RSA-wrapped, for offline recovery)
                recovery_key_file = cfg.get("recovery_key_file", RECOVERY_KEY_FILE)
                write_recovery_key(recovery_key_file, "deadman", key_b64, cfg=cfg)
                blocked = encrypt_folder(cfg["lockdown_folder"], key)
                if blocked:
                    log.warning(
                        "Deadman encryption completed with %d blocked file(s): %s",
                        len(blocked),
                        ", ".join(blocked),
                    )
                apply_lock_screen()
                start_lock_guardian()
                sentinel_state = {"locked": True, "deadman": True}
                if clock_rollback:
                    sentinel_state["clock_rollback"] = True
                _atomic_write_text(sentinel, json.dumps(sentinel_state))
                # Store key locally so it can be uploaded to the server once
                # network connectivity is restored — without this the device
                # would be permanently unrecoverable.
                DEADMAN_KEY_FILE.write_text(key_b64)
                log.warning(
                    "Deadman lockdown complete — key stored locally for upload on reconnection"
                )
                del key, key_b64
    except Exception as e:  # noqa: BLE001 — deadman check orchestrates multiple lock operations
        log.error("Dead man check failed: %s", e)


def report_deadman_key(cfg: dict) -> None:
    """If a deadman key is stored locally, upload it to the server and wipe the local copy."""
    if not DEADMAN_KEY_FILE.exists():
        return
    try:
        key_material = DEADMAN_KEY_FILE.read_text().strip()
        resp = _post_with_fallback(
            "/api/agent/deadman-report",
            cfg,
            {
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
                "key_material": key_material,
            },
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        DEADMAN_KEY_FILE.unlink()
        log.warning("Deadman key uploaded to server — local copy wiped. Device is now recoverable.")
        del key_material
    except requests.RequestException as e:
        log.warning("Could not upload deadman key (will retry): %s", e)
    except (OSError, KeyError, TypeError) as e:
        log.error("Deadman key upload failed: %s", e)


# ---------------------------------------------------------------------------
# Auto-update (Phase 4)
# ---------------------------------------------------------------------------
#
# The agent checks for updates on each checkin. If a newer version is
# available, it downloads the new binary to a temp file, verifies the
# SHA-256 hash, then writes a signal file (.update_pending) that tells
# the watchdog to perform a hot-swap:
#
#   1. Watchdog sees .update_pending file
#   2. Watchdog stops the agent process
#   3. Watchdog replaces the agent binary with the downloaded one
#   4. Watchdog starts the new agent
#   5. New agent deletes .update_pending on startup
#
# This approach avoids self-replacement (which doesn't work on Windows
# while the binary is running) and lets the watchdog handle the swap.

# Update signal file (watchdog watches for this)
UPDATE_PENDING_FILE = _STATE_DIR / ".update_pending"
# Downloaded binary (watchdog moves this to replace the current binary)
UPDATE_DOWNLOAD_FILE = _STATE_DIR / ".update_downloaded"

# Check for updates at most once per hour (not every checkin)
UPDATE_CHECK_INTERVAL = 3600  # seconds

# Tamper check interval — run check_tamper at most every 5 minutes (not every
# poll cycle) to avoid overhead. Like last_update_check, throttled in main loop.
TAMPER_CHECK_INTERVAL = 300  # seconds (5 minutes)


def check_for_update(cfg: dict) -> None:
    """Check if a newer agent version is available on the server.

    If an update is available, downloads and verifies it, then writes
    a signal file for the watchdog to perform the hot-swap.
    """
    try:
        # Use a signed GET request (HMAC over empty body)
        headers = sign_headers(cfg["agent_key"], b"")
        headers["X-Agent-Version"] = AGENT_VERSION
        headers["X-Agent-Platform"] = "win" if sys.platform == "win32" else "linux"

        resp = requests.get(
            f"{cfg['server_url']}/api/agent/update",
            headers=headers,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        data = resp.json()

        if not data.get("update_available"):
            return

        latest_version = data.get("latest_version", "")
        expected_sha256 = data.get("sha256", "")
        download_url = data.get("download_url", "")
        size = data.get("size", 0)
        signature = data.get("signature", "")
        # Only Ed25519 signatures are meaningful to the verifier — an
        # unexpected alg means the signature can't be trusted; treat as
        # absent (fails closed when update_public_key is configured).
        sig_alg = data.get("signature_alg")
        if signature and sig_alg and sig_alg != "ed25519":
            log.warning("Unsupported update signature_alg %r — ignoring signature", sig_alg)
            signature = ""

        log.info("Update available: %s -> %s (%s bytes)", AGENT_VERSION, latest_version, size)

        # Download the new binary
        if not download_url:
            log.warning("Update available but no download_url provided")
            return

        full_url = f"{cfg['server_url']}{download_url}"
        download_update(cfg, full_url, expected_sha256, latest_version, signature=signature)

    except requests.RequestException as e:
        log.debug("Update check failed: %s", e)
    except (ValueError, KeyError, TypeError, OSError) as e:
        log.warning("Update check error: %s", e)


def _load_pem_public_key(pem_path: str):
    """Load a PEM public key from a path; None if unset/unreadable."""
    if not pem_path:
        return None
    p = Path(pem_path)
    if not p.exists():
        return None
    try:
        from cryptography.hazmat.primitives import serialization

        return serialization.load_pem_public_key(p.read_bytes())
    except (OSError, ValueError, TypeError):
        return None


def _get_update_public_key(cfg: dict):
    """Load the pinned public key for update-signature verification (S0.6, B-006).

    Separate key domain from recovery_public_key: the update key verifies
    detached signatures over update metadata; the recovery key wraps
    escrowed key material. Key-domain collisions are warned about in
    download_update.
    """
    pem_path = cfg.get("update_public_key", "")
    if not pem_path:
        return None
    if not Path(pem_path).exists():
        log.warning("Update public key not found: %s", pem_path)
        return None
    public_key = _load_pem_public_key(pem_path)
    if public_key is None:
        log.warning("Could not load update public key: %s", pem_path)
        return None
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if not isinstance(public_key, Ed25519PublicKey):
        log.warning("Update public key is not Ed25519 — refusing to use it")
        return None
    return public_key


def _public_key_bytes(public_key) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def _check_key_domain_separation(cfg: dict) -> None:
    """Warn if the update and recovery keys are the same key (S0.6).

    Compares actual key material (not just config paths) — the same key
    pinned under two different paths is still one key domain.
    """
    update_key = _load_pem_public_key(cfg.get("update_public_key", ""))
    recovery_key = _load_pem_public_key(cfg.get("recovery_public_key", ""))
    if update_key is None or recovery_key is None:
        return
    try:
        if _public_key_bytes(update_key) == _public_key_bytes(recovery_key):
            log.warning(
                "update_public_key and recovery_public_key are the SAME key "
                "— key domains not separated (S0.6)"
            )
    except (ValueError, TypeError):
        pass


def verify_update_signature(cfg: dict, signature_b64: str, version: str, sha256: str) -> bool:
    """Verify the detached Ed25519 signature over the update metadata.

    Signed payload: "v1:{version}:{sha256}" — binds the binary's hash to
    the version it claims. Returns True only when an update key is
    configured AND the signature verifies.
    """
    if not signature_b64:
        return False
    public_key = _get_update_public_key(cfg)
    if public_key is None:
        return False
    try:
        import base64

        from cryptography.exceptions import InvalidSignature

        payload = f"v1:{version}:{sha256}".encode()
        public_key.verify(base64.b64decode(signature_b64, validate=True), payload)
        return True
    except (InvalidSignature, ValueError, TypeError) as e:
        log.warning("Update signature verification failed: %s", e)
        return False


def download_update(
    cfg: dict, url: str, expected_sha256: str, version: str, signature: str = ""
) -> None:
    """Download the new agent binary, verify SHA-256 + detached signature,
    and signal the watchdog.

    Downloads to UPDATE_DOWNLOAD_FILE, then writes UPDATE_PENDING_FILE
    with metadata for the watchdog to consume. When update_public_key is
    configured, a valid detached signature is REQUIRED — a channel-
    delivered SHA-256 alone is self-certifying (B-006).
    """
    try:
        log.info("Downloading update from %s ...", url)
        headers = sign_headers(cfg["agent_key"], b"")
        headers["X-Agent-Platform"] = "win" if sys.platform == "win32" else "linux"

        resp = requests.get(
            url, headers=headers, stream=True, timeout=120, verify=cfg["verify_tls"]
        )
        resp.raise_for_status()

        # Download to temp file first, then rename (atomic)
        tmp_file = UPDATE_DOWNLOAD_FILE.with_suffix(".tmp")
        sha256 = hashlib.sha256()
        total = 0

        with open(tmp_file, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    sha256.update(chunk)
                    total += len(chunk)

        actual_sha256 = sha256.hexdigest()
        if actual_sha256 != expected_sha256:
            log.error(
                "Update SHA-256 mismatch: expected %s, got %s", expected_sha256, actual_sha256
            )
            tmp_file.unlink(missing_ok=True)
            return

        # S0.6 (B-006): when an update key is pinned, the detached signature
        # is mandatory — a channel-delivered hash alone is self-certifying.
        update_key_configured = bool(cfg.get("update_public_key"))
        signature_verified = False
        if update_key_configured:
            _check_key_domain_separation(cfg)
            if not signature:
                log.error("Update signature missing — refusing unverified update")
                tmp_file.unlink(missing_ok=True)
                return
            if not verify_update_signature(cfg, signature, version, actual_sha256):
                log.error("Update signature invalid — refusing update")
                tmp_file.unlink(missing_ok=True)
                return
            signature_verified = True
            log.info("Update signature verified (ed25519, pinned key)")
        else:
            log.warning(
                "No update_public_key configured — update verified by channel "
                "SHA-256 only (unauthenticated; B-006)"
            )

        # Rename to final download path
        tmp_file.replace(UPDATE_DOWNLOAD_FILE)
        log.info("Update downloaded and verified (%s bytes, SHA-256 OK)", total)

        # Write signal file for watchdog
        import json as _json

        signal = {
            "version": version,
            "sha256": actual_sha256,
            "downloaded_at": time.time(),
            "download_path": str(UPDATE_DOWNLOAD_FILE),
            # Provenance for the watchdog/auditor: whether this update was
            # detached-signature verified or only channel-SHA-256 checked.
            "signature_verified": signature_verified,
        }
        UPDATE_PENDING_FILE.write_text(_json.dumps(signal, indent=2))
        log.info("Update signal written — watchdog will apply on next check")

    except (requests.RequestException, OSError, ValueError, TypeError) as e:
        log.error("Update download failed: %s", e)
        # Clean up partial download
        try:
            tmp_file.unlink(missing_ok=True)
        except OSError as e:
            log.warning("Could not clean up partial update download: %s", e)


def clear_update_signal() -> None:
    """Clear any pending update signal on startup.

    Called by the agent after a successful start — if we're running,
    either the update was applied or it's stale.
    """
    if UPDATE_PENDING_FILE.exists():
        log.info("Clearing stale update signal")
        UPDATE_PENDING_FILE.unlink(missing_ok=True)
    if UPDATE_DOWNLOAD_FILE.exists():
        log.info("Clearing stale update download")
        UPDATE_DOWNLOAD_FILE.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Mutual watchdog — agent monitors the watchdog process and restarts it if dead
# ---------------------------------------------------------------------------

WATCHDOG_HEARTBEAT_FILE = _STATE_DIR / ".watchdog_heartbeat"
WATCHDOG_CHECK_INTERVAL = 60  # seconds between watchdog health checks
WATCHDOG_MAX_AGE_SEC = 180  # 3 minutes — watchdog should heartbeat every 30s


def _is_watchdog_running() -> bool:
    """Check if the watchdog process is running."""
    if sys.platform == "win32":
        try:
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq lockdown-watchdog.exe"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return "lockdown-watchdog.exe" in result.stdout
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return False
    else:
        try:
            result = subprocess.run(
                ["pgrep", "-f", "watchdog.py"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.returncode == 0 and bool(result.stdout.strip())
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            return False


def _start_watchdog() -> subprocess.Popen | None:
    """Start the watchdog process if it's not running."""
    if getattr(sys, "frozen", False):
        # PyInstaller bundle — look for lockdown-watchdog exe next to agent
        exe_dir = Path(sys.executable).parent
        exe_name = "lockdown-watchdog.exe" if sys.platform == "win32" else "lockdown-watchdog"
        watchdog_bin = exe_dir / exe_name
        if watchdog_bin.exists():
            try:
                creationflags = 0
                if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW"):
                    creationflags = subprocess.CREATE_NO_WINDOW
                proc = subprocess.Popen(
                    [str(watchdog_bin)],
                    creationflags=creationflags,
                    close_fds=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                log.info("Watchdog restarted (PID %d)", proc.pid)
                return proc
            except (OSError, FileNotFoundError) as e:
                log.warning("Could not start watchdog: %s", e)
                return None
    else:
        # Running from source
        watchdog_script = Path(__file__).parent / "watchdog.py"
        if watchdog_script.exists():
            try:
                proc = subprocess.Popen(
                    [sys.executable, str(watchdog_script)],
                    close_fds=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                log.info("Watchdog restarted (PID %d)", proc.pid)
                return proc
            except (OSError, FileNotFoundError) as e:
                log.warning("Could not start watchdog: %s", e)
                return None
    return None


def check_watchdog_health() -> None:
    """Check if the watchdog is alive; restart it if not.

    Called from the main polling loop. The watchdog monitors the agent
    via heartbeat file, and the agent monitors the watchdog via process
    check — this is the "mutual watchdog" pattern. Killing one triggers
    the other to restart it.
    """
    if not _is_watchdog_running():
        log.warning("Watchdog not running — attempting restart")
        _start_watchdog()


def _run_tamper_check(cfg: dict, current_status: str) -> None:
    """Run the tamper detection check and trigger re-lock if tamper is detected.

    Called from the main polling loop (throttled to once per
    TAMPER_CHECK_INTERVAL). If tamper is detected AND the device is in a
    stolen/locked state, a re-lock is triggered to re-assert protection
    (re-create missing sentinel, re-apply lock screen, re-encrypt if needed).

    This is fail-secure: any exception in the tamper check is logged but
    does NOT crash the agent.
    """
    try:
        result = check_tamper(_STATE_DIR)
        if not result.get("tampered"):
            return

        log.warning(
            "TAMPER DETECTED: files_missing=%s service_missing=%s task_missing=%s",
            result.get("files_missing", []),
            result.get("service_missing"),
            result.get("task_missing"),
        )

        # Only re-lock if the device is in a stolen/locked state.
        # If the device is active/recovering, tamper may be a legitimate
        # uninstall or migration — don't re-lock.
        if current_status in ("stolen", "locked", "tracking"):
            log.warning(
                "Tamper detected while device status is '%s' — triggering re-lock",
                current_status,
            )
            sentinel = cfg["lock_sentinel"]
            if not sentinel.exists():
                key = generate_key()
                key_b64 = key.decode()
                pending_ack_file = cfg.get("pending_ack_file", PENDING_ACK_FILE)
                write_pending_ack(pending_ack_file, "tamper", "executed", key_material=key_b64)
                recovery_key_file = cfg.get("recovery_key_file", RECOVERY_KEY_FILE)
                write_recovery_key(recovery_key_file, "tamper", key_b64, cfg=cfg)
                blocked = encrypt_folder(cfg["lockdown_folder"], key)
                if blocked:
                    log.warning(
                        "Tamper re-lock encryption completed with %d blocked file(s): %s",
                        len(blocked),
                        ", ".join(blocked),
                    )
                apply_lock_screen()
                start_lock_guardian()
                _atomic_write_text(
                    sentinel,
                    json.dumps({"locked": True, "deadman": True, "tamper_detected": True}),
                )
                DEADMAN_KEY_FILE.write_text(key_b64)
                log.warning(
                    "Tamper re-lock complete — key stored locally for upload on reconnection"
                )
                del key, key_b64
            else:
                # Sentinel already exists — device is already locked.
                # Re-apply lock screen in case it was dismissed.
                log.info("Tamper detected but sentinel exists — re-applying lock screen")
                apply_lock_screen()
                start_lock_guardian()
    except Exception as e:  # noqa: BLE001 — tamper check orchestrates multiple lock operations
        log.error("Tamper check failed: %s", e)


# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------


def main() -> None:
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description="Remote Device Lockdown Agent")
    parser.add_argument(
        "--config", "-c", type=str, default=None, help="Path to config file (JSON or INI format)"
    )
    parser.add_argument(
        "--silent", action="store_true", help="Suppress stdout logging for covert operation"
    )
    parser.add_argument(
        "--startup",
        action="store_true",
        help="Mark this run as startup-triggered (logs a banner, does not change behavior)",
    )
    parser.add_argument("--version", "-v", action="store_true", help="Show version and exit")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode: attach to console, show all output, write detailed log",
    )
    parser.add_argument(
        "--lockscreen",
        action="store_true",
        help="Run as fullscreen lock screen overlay (internal use — launched by agent)",
    )
    parser.add_argument(
        "--lockscreen-test",
        action="store_true",
        help="Run lock screen in test mode (ESC to close)",
    )
    args, _ = parser.parse_known_args()

    # --- Debug mode: reattach to parent console so output is visible ---
    # When built with console=False (PyInstaller GUI mode), stdout/stderr
    # are None. --debug reattaches to the parent process's console so
    # the user can see output when running from cmd/PowerShell.
    if args.debug:
        try:
            ctypes.windll.kernel32.AttachConsole(-1)  # ATTACH_PARENT_PROCESS
            # Reopen stdout/stderr to the console
            sys.stdout = open("CONOUT$", "w", encoding="utf-8", errors="replace")
            sys.stderr = open("CONOUT$", "w", encoding="utf-8", errors="replace")
        except (OSError, AttributeError, FileNotFoundError):
            pass  # Not Windows or no parent console

    if args.version:
        # Use sys.stdout if available (console=True build), otherwise
        # write to stderr or a file so --version always works.
        version_msg = f"lockdown-agent {AGENT_VERSION} (frozen={_is_frozen()})"
        try:
            print(version_msg)
        except (AttributeError, OSError):
            # console=False build — sys.stdout is None
            sys.stderr.write(version_msg + "\n") if sys.stderr else None
        sys.exit(0)

    # If --lockscreen flag is set, run the lock screen overlay instead of the agent
    if args.lockscreen or args.lockscreen_test:
        if _lock_screen_available and platform.system() == "Windows":
            win = lock_screen_module.LockScreenWindow(test_mode=args.lockscreen_test)
            win.run()
        else:
            log.error("Lock screen not available")
        sys.exit(0)

    # Propagate master dry-run switch to all lock modules
    if _DRY_RUN:
        log.info("=== DRY RUN MODE === All lock actions will be logged, not executed.")
        if _boot_lock_modules_available:
            bcd_lockdown.set_dry_run(True)
            hp_uefi_lockdown.set_dry_run(True)
            bitlocker_pba.set_dry_run(True)

    # Log startup-triggered banner
    if args.startup:
        log.info("=== STARTUP-TRIGGERED RUN === Agent launched at system startup/logon.")

    cfg = load_config(config_path=args.config)

    # In dry-run mode, skip the agent_key requirement and server validation.
    # The agent can run startup_check() without a live server.
    if _DRY_RUN:
        log.info("DRY RUN: Skipping agent_key check (dry-run mode does not require server).")
        # Still validate config, but allow http:// in dry-run mode
        try:
            validate_config(cfg)
        except ValueError as e:
            # In dry-run mode, be lenient — log but don't exit
            log.warning("DRY RUN: Config validation warning: %s", e)
        log.info(
            "Agent starting (DRY RUN) — hostname=%s server=%s poll=%ss",
            cfg["hostname"],
            cfg["server_url"],
            cfg["poll_interval"],
        )
        # Migrate any plaintext state files to encrypted format (one-time)
        migrate_deadman_to_encrypted()

        startup_check(cfg)
        log.info("DRY RUN: Startup check complete. Exiting (dry-run mode).")
        sys.exit(0)

    if not cfg["agent_key"]:
        log.error("AGENT_SHARED_KEY is not set. Exiting.")
        log.error("Set DEVICE_API_KEY env var, or provide a config file with --config")
        sys.exit(1)

    # Phase 3: Validate critical config values at startup (server URL, lockdown folder)
    try:
        validate_config(cfg)
    except ValueError as e:
        log.error("Invalid configuration: %s", e)
        sys.exit(1)

    # --silent flag: suppress stdout logging for covert operation.
    # File logging (agent.log) continues regardless.
    if args.silent:
        for h in log.handlers:
            if isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler):
                log.removeHandler(h)
        log.info("Running in silent mode — stdout logging suppressed (file logging continues)")

    log.info(
        "Agent starting — hostname=%s server=%s poll=%ss",
        cfg["hostname"],
        cfg["server_url"],
        cfg["poll_interval"],
    )
    if cfg.get("serverless_url"):
        log.info("Serverless fallback configured: %s", cfg["serverless_url"])
    # Migrate any plaintext state files to encrypted format (one-time)
    migrate_deadman_to_encrypted()

    startup_check(cfg)

    # Clear any stale update signal from a previous run
    clear_update_signal()

    last_location_report = 0.0
    last_update_check = 0.0
    last_tamper_check = 0.0
    current_status = "active"
    # Phase 5: effective_poll_interval starts from config, updated by server
    effective_poll_interval = cfg["poll_interval"]

    while True:
        # Update heartbeat so watchdog knows agent is alive
        try:
            HEARTBEAT_FILE.touch()
        except OSError as e:
            log.debug("Could not update heartbeat file: %s", e)

        # --- Hidden file trigger: covert lockdown via marker file ---
        # If a file named ``.system_cache_cleanup`` appears in the
        # agent's state directory, immediately trigger lockdown.  The
        # file name looks like a system cache file — not suspicious.
        # Only the owner knows to create this file (e.g., via RDP, SSH,
        # or another machine with access).  After triggering lockdown
        # the file is deleted.  This is a no-op when the duress module
        # is unavailable or the trigger file does not exist.
        if _DURESS_AVAILABLE and _duress.check_hidden_trigger(_STATE_DIR):
            _trigger_hidden_lockdown(cfg)

        # Mutual watchdog: check if the watchdog process is alive,
        # restart it if not. The watchdog monitors us via heartbeat,
        # we monitor the watchdog via process check.
        try:
            check_watchdog_health()
        except Exception as e:  # noqa: BLE001 — watchdog health check must not crash main loop
            log.debug("Watchdog health check failed: %s", e)

        # Tamper detection: check for missing state files / service / task.
        # Throttled to once per TAMPER_CHECK_INTERVAL (5 min) to avoid overhead.
        # If tamper is detected and device is stolen/locked, triggers re-lock.
        now = time.time()
        if now - last_tamper_check >= TAMPER_CHECK_INTERVAL:
            _run_tamper_check(cfg, current_status)
            last_tamper_check = now

        # Check dead man's switch before attempting network
        check_deadman(cfg)

        # A4: Drain any pending ACK from a previous crash BEFORE checkin.
        # This ensures the server receives the pending ACK before it can
        # hand us a new command (prevents command interleaving).
        drain_pending_ack(cfg)

        data = checkin(cfg)
        if data:
            # Upload deadman key (if any) now that we have connectivity
            report_deadman_key(cfg)

            # Phase 5: Drain offline queue (location reports, etc.)
            drain_offline_queue(cfg)

            # Update dead man's timer with current server-reported status;
            # anchor last_seen to the server's clock when provided (B-005)
            current_status = data.get("status", "active")
            update_deadman_timer(current_status, server_time=data.get("server_time"))

            # Phase 5: Adaptive polling — use server-sent poll_interval if present.
            # The server tells us how often to check in based on device status:
            #   stolen/tracking: 30s, locked: 60s, active: 300s
            # We use a separate variable so we don't modify cfg (which is
            # the config from file/env). The server value takes precedence.
            server_poll = data.get("poll_interval")
            if server_poll and isinstance(server_poll, (int, float)) and server_poll > 0:
                if server_poll != effective_poll_interval:
                    log.info(
                        "Adaptive polling: %ss -> %ss (status=%s)",
                        effective_poll_interval,
                        int(server_poll),
                        current_status,
                    )
                effective_poll_interval = int(server_poll)

            command = data.get("command")
            if command:
                cmd_type = command.get("type")
                # Phase 5: Extract command_uuid from server response for idempotent ACK
                cmd_uuid = command.get("command_uuid")
                handler = COMMAND_HANDLERS.get(cmd_type)
                if handler:
                    try:
                        handler(cfg, command)
                    except Exception as e:  # noqa: BLE001 — main loop must not crash
                        log.exception("Handler %s crashed: %s", cmd_type, e)
                        ack_command(cfg, command["id"], "failed", command_uuid=cmd_uuid)
                else:
                    log.warning("Unknown command type: %s", cmd_type)

            # Report location periodically when in tracking or stolen mode.
            # Tracking: covert mode — agent reports location silently.
            # Stolen: device is locked down — still report location so the
            # operator can track where the device is.
            if current_status in ("tracking", "stolen"):
                now = time.time()
                if now - last_location_report >= cfg["location_interval"]:
                    report_location(cfg)
                    last_location_report = now

            # Phase 4: Check for agent updates (throttled to once per hour)
            now = time.time()
            if now - last_update_check >= UPDATE_CHECK_INTERVAL:
                check_for_update(cfg)
                last_update_check = now

        time.sleep(effective_poll_interval)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — catch-all so crash is logged
        # When console=False, there's no stderr. Write to a crash log file
        # so we can diagnose why the agent died.
        import traceback

        crash_file = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
        crash_file = crash_file / "crash.log"
        try:
            crash_file.parent.mkdir(parents=True, exist_ok=True)
            with open(crash_file, "a", encoding="utf-8") as f:
                f.write(f"\n{'=' * 60}\n")
                f.write(f"CRASH at {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"Version: {AGENT_VERSION}\n")
                f.write(f"Python: {sys.version}\n")
                f.write(f"Platform: {platform.platform()}\n")
                f.write(f"Frozen: {_is_frozen()}\n")
                f.write(f"Error: {type(e).__name__}: {e}\n")
                f.write(traceback.format_exc())
                f.write(f"{'=' * 60}\n")
        except OSError:
            pass  # Can't even write crash log — nothing more we can do
        raise
