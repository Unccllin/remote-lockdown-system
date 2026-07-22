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

import os
import sys
import time
import json
import base64
import logging
import platform
import subprocess
import socket
import uuid
import configparser
import argparse
import threading
import hashlib
import hmac
import secrets
from pathlib import Path

import requests
from cryptography.fernet import Fernet

# Boot lockdown modules (imported lazily on Windows to avoid import errors on Linux)
try:
    import hp_uefi_lockdown
    import bcd_lockdown
    _boot_lock_modules_available = True
except ImportError:
    _boot_lock_modules_available = False

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("lockdown-agent")

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
    return getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')

# Base directory: PyInstaller bundle dir, or script dir
_BASE_DIR = Path(sys._MEIPASS) if _is_frozen() else Path(__file__).parent

# Executable directory (where the .exe or binary lives — for config file search)
_EXE_DIR = Path(sys.executable).parent if _is_frozen() else Path(__file__).parent

# System config directory (for bundled agent)
if sys.platform == 'win32':
    _SYSTEM_CONFIG_DIR = Path(os.environ.get('PROGRAMDATA', 'C:\\ProgramData')) / 'LockdownAgent'
else:
    _SYSTEM_CONFIG_DIR = Path('/etc/lockdown-agent')

# State directory: persistent writable location for runtime state files.
# When frozen (PyInstaller bundle): use platform-specific system directory
# (writable without elevated privileges, survives reboots).
# When running from source (dev/test): use the script directory so existing
# tests and dev workflows keep working without root/admin privileges.
if _is_frozen():
    if sys.platform == 'win32':
        _STATE_DIR = Path(os.environ.get('PROGRAMDATA', 'C:\\ProgramData')) / 'LockdownAgent'
    else:
        _STATE_DIR = Path('/var/lib/lockdown-agent')
else:
    _STATE_DIR = Path(__file__).parent

# Default config file locations (searched in order)
_CONFIG_SEARCH_PATHS = [
    _EXE_DIR / 'config.json',
    _EXE_DIR / 'config.ini',
    _SYSTEM_CONFIG_DIR / 'agent-config.json',
    _SYSTEM_CONFIG_DIR / 'config.ini',
    _BASE_DIR / 'config.ini',  # legacy fallback (script directory)
]

# Runtime state files (all live in _STATE_DIR so they persist across reboots
# when bundled, and stay in the script directory during dev/test).
PENDING_ACK_FILE  = _STATE_DIR / '.pending_ack'
RECOVERY_KEY_FILE = _STATE_DIR / '.recovery_key'
DEADMAN_FILE      = _STATE_DIR / '.deadman'
HEARTBEAT_FILE    = _STATE_DIR / '.heartbeat'
DEADMAN_KEY_FILE  = _STATE_DIR / '.deadman_key'


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
    with open(config_path, 'r') as f:
        data = json.load(f)

    section = {}

    # server_url — direct mapping
    if 'server_url' in data:
        section['server_url'] = data['server_url']

    # agent_key — JSON may use any of several key names (api_key, agent_key,
    # device_api_key) depending on when the enrollment page was last updated.
    for json_key in ('api_key', 'agent_key', 'device_api_key'):
        if json_key in data and data[json_key]:
            section['agent_key'] = data[json_key]
            break

    # hostname — JSON may use device_hostname or hostname
    for json_key in ('device_hostname', 'hostname'):
        if json_key in data and data[json_key]:
            section['hostname'] = data[json_key]
            break

    # Numeric/string settings — convert to string for consistency with INI
    for json_key in ('poll_interval', 'location_interval'):
        if json_key in data:
            section[json_key] = str(data[json_key])

    # Boolean settings — convert to lowercase string ("true"/"false")
    for json_key in ('verify_tls', 'boot_lock_enabled', 'server_supports_ack_dedup'):
        if json_key in data:
            section[json_key] = str(data[json_key]).lower()

    # String settings — direct mapping (only if non-empty)
    for json_key in ('lockdown_folder', 'lock_sentinel', 'google_api_key',
                     'uefi_password', 'pending_ack_file', 'recovery_key_file',
                     'recovery_public_key'):
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

    if found_path and found_path.suffix == '.json':
        section = _load_json_config(found_path)
        log.info("Loaded JSON config from: %s", found_path)
    elif found_path:
        section = _load_ini_config(found_path)
        log.info("Loaded INI config from: %s", found_path)
    else:
        log.warning("No config file found — using defaults and environment variables")
        section = {}

    return {
        "server_url": os.environ.get("SERVER_URL", section.get("server_url", "https://localhost:3001")),
        # FA3: Per-device API key (preferred) with AGENT_SHARED_KEY legacy fallback.
        # The per-device key is provisioned at enrollment and unique to this device.
        # The legacy shared key is used only for devices that haven't been
        # re-enrolled with a per-device key yet (CC5 per-device fallback).
        "agent_key": os.environ.get("DEVICE_API_KEY", os.environ.get(
            "AGENT_SHARED_KEY", section.get("agent_key", section.get("device_api_key", ""))
        )),
        "hostname": os.environ.get("DEVICE_HOSTNAME", section.get("hostname", socket.gethostname())),
        "poll_interval": int(os.environ.get("POLL_INTERVAL", section.get("poll_interval", "30"))),
        "lockdown_folder": Path(
            os.environ.get("LOCKDOWN_FOLDER", section.get("lockdown_folder", str(Path.home() / "SecureData")))
        ),
        "lock_sentinel": Path(
            os.environ.get("LOCK_SENTINEL", section.get("lock_sentinel", str(_EXE_DIR / ".locked")))
        ),
        "verify_tls": section.get("verify_tls", "true").lower() != "false",
        "google_api_key": os.environ.get("GOOGLE_API_KEY", section.get("google_api_key", "")),
        "location_interval": int(os.environ.get("LOCATION_INTERVAL", section.get("location_interval", "300"))),
        # Boot lockdown: when True, the agent locks the UEFI/BIOS and BCD
        # on lockdown commands and reverts them on unlock. Requires Windows
        # + HP WMI BIOS interface (for UEFI lockdown). BCD lockdown works
        # on any Windows machine.
        "boot_lock_enabled": os.environ.get(
            "BOOT_LOCK_ENABLED", section.get("boot_lock_enabled", "true")
        ).lower() != "false",
        # Pre-existing BIOS Setup password (if the machine already has one).
        # If empty and no password is set, the agent generates a random one.
        # If empty and a password IS set, UEFI lockdown is skipped (can't
        # authenticate BIOS changes without it).
        "uefi_password": os.environ.get("UEFI_PASSWORD", section.get("uefi_password", "")),
        # A1/A4: Pending ACK state file (transient, deleted on ACK success)
        "pending_ack_file": Path(
            os.environ.get("PENDING_ACK_FILE", section.get("pending_ack_file", str(PENDING_ACK_FILE)))
        ),
        # A8: Recovery key file (long-lived, RSA-wrapped, deleted on unlock)
        "recovery_key_file": Path(
            os.environ.get("RECOVERY_KEY_FILE", section.get("recovery_key_file", str(RECOVERY_KEY_FILE)))
        ),
        # A8: IT's offline master recovery PUBLIC key (PEM). Private key never on device.
        "recovery_public_key": os.environ.get(
            "RECOVERY_PUBLIC_KEY", section.get("recovery_public_key", "")
        ),
        # A4: Flip to true once server supports command_id dedup on encryption_keys
        "server_supports_ack_dedup": os.environ.get(
            "SERVER_SUPPORTS_ACK_DEDUP", section.get("server_supports_ack_dedup", "false")
        ).lower() != "false",
    }

# ---------------------------------------------------------------------------
# Encryption helpers (Fernet = AES-128-CBC + HMAC-SHA256)
# ---------------------------------------------------------------------------

def generate_key() -> bytes:
    return Fernet.generate_key()

def encrypt_folder(folder: Path, key: bytes) -> None:
    """Encrypt all files inside `folder` in-place. Never touches files outside it.

    CC20: Resumable — skips files that already have a .enc counterpart
    (from a previous interrupted run). This allows handle_lockdown to
    resume encryption with the same persisted key after a crash, rather
    than generating a new key and leaving a mix of .enc and plaintext files.
    """
    folder = folder.resolve()
    fernet = Fernet(key)
    for filepath in folder.rglob("*"):
        if filepath.is_file() and not filepath.name.endswith(".enc"):
            enc_path = filepath.with_suffix(filepath.suffix + ".enc")
            # CC20: Skip if already encrypted (resumable encryption)
            if enc_path.exists():
                log.info("Already encrypted, skipping: %s", filepath.name)
                continue
            data = filepath.read_bytes()
            encrypted = fernet.encrypt(data)
            enc_path.write_bytes(encrypted)
            filepath.unlink()
            log.info("Encrypted: %s", filepath.name)

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
    "  !   Contact IT Support immediately:                     !\n"
    "  !   support@yourcompany.com  /  +1-800-XXX-XXXX        !\n"
    "  !                                                       !\n"
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n"
)

def _lock_workstation() -> None:
    """Platform-specific workstation lock. Best-effort, no banner."""
    system = platform.system()
    if system == "Windows":
        try:
            import ctypes
            ctypes.windll.user32.LockWorkStation()
        except Exception as e:
            log.warning("Windows lock failed: %s", e)
    elif system == "Linux":
        for cmd in [["dm-tool", "lock"], ["loginctl", "lock-session"], ["xdg-screensaver", "lock"]]:
            try:
                subprocess.run(cmd, check=True, timeout=5)
                break
            except Exception:
                continue
    elif system == "Darwin":
        try:
            subprocess.run(["/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend"], timeout=5)
        except Exception as e:
            log.warning("macOS lock failed: %s", e)

def apply_lock_screen() -> None:
    """Lock the workstation and display the stolen banner."""
    _lock_workstation()
    print(_BANNER)

# ---------------------------------------------------------------------------
# Lock guardian — background thread that re-asserts the lock screen so a
# thief cannot simply unlock and use the device.
# ---------------------------------------------------------------------------

LOCK_GUARDIAN_INTERVAL = 10  # seconds between re-lock attempts
_lock_guardian_stop: threading.Event | None = None
_lock_guardian_thread: threading.Thread | None = None

def start_lock_guardian() -> None:
    """Start (or restart) the background thread that re-locks the screen."""
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
    """Background loop — re-lock the screen at regular intervals."""
    while not stop_event.is_set():
        _lock_workstation()
        stop_event.wait(LOCK_GUARDIAN_INTERVAL)

def remove_lock_screen() -> None:
    stop_lock_guardian()
    log.info("Lock screen removed — normal login restored")

# ---------------------------------------------------------------------------
# Hardware identity
# ---------------------------------------------------------------------------

def get_mac_address() -> str:
    """Return the primary MAC address as a colon-separated string."""
    mac = uuid.getnode()
    return ':'.join(('%012X' % mac)[i:i+2] for i in range(0, 12, 2))

def get_hardware_uuid() -> str:
    """Return a stable hardware UUID from the OS."""
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.check_output(
                ["wmic", "csproduct", "get", "UUID"],
                timeout=10, stderr=subprocess.DEVNULL
            ).decode().strip().split()
            return result[-1] if result else str(uuid.getnode())
        elif system == "Linux":
            result = subprocess.check_output(
                ["cat", "/sys/class/dmi/id/product_uuid"],
                timeout=10, stderr=subprocess.DEVNULL
            ).decode().strip()
            return result
        elif system == "Darwin":
            result = subprocess.check_output(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                timeout=10, stderr=subprocess.DEVNULL
            ).decode()
            for line in result.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
    except Exception as e:
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
      - macOS:   /System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s
    """
    networks = []
    system = platform.system()
    try:
        if system == "Windows":
            output = subprocess.check_output(
                ["netsh", "wlan", "show", "networks", "mode=bssid"],
                timeout=10, stderr=subprocess.DEVNULL
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
                timeout=10, stderr=subprocess.DEVNULL
            ).decode("utf-8", errors="replace")
            for line in output.splitlines():
                parts = line.split(":")
                if len(parts) >= 4:
                    bssid = ":".join(parts[:6])
                    ssid = parts[6] if len(parts) > 6 else ""
                    signal = int(parts[-2]) if parts[-2].isdigit() else 0
                    freq = parts[-1]
                    networks.append({"ssid": ssid, "bssid": bssid, "signal": signal, "frequency": freq})
        elif system == "Darwin":
            output = subprocess.check_output(
                ["/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport", "-s"],
                timeout=10, stderr=subprocess.DEVNULL
            ).decode("utf-8", errors="replace")
            for line in output.splitlines()[1:]:
                parts = line.split()
                if len(parts) >= 5:
                    networks.append({"ssid": parts[0], "bssid": parts[1], "signal": int(parts[2]) if parts[2].isdigit() else 0})
    except Exception as e:
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
    except Exception as e:
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
            except Exception as e:
                log.warning("WiFi geolocation failed: %s", e)

    # Fallback to IP-based geolocation
    return get_ip_geolocation()


def report_location(cfg: dict) -> dict | None:
    """Collect geolocation data and report it to the server."""
    location = get_geolocation(cfg)
    if not location:
        log.warning("Could not determine geolocation")
        return None

    try:
        resp = _signed_post(
            f"{cfg['server_url']}/api/agent/location",
            cfg,
            {
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
                "location": location,
            },
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        log.info("Location reported: %.4f, %.4f (%s, ~%sm)",
                 location.get("latitude", 0),
                 location.get("longitude", 0),
                 location.get("source", "unknown"),
                 location.get("accuracy_meters", location.get("accuracy", "?")))
        return location
    except requests.RequestException as e:
        log.warning("Location report failed: %s", e)
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

    Falls back to plain x-agent-key header if signing fails (shouldn't happen,
    but keeps the agent working if there's an encoding edge case).

    The body is pre-serialized to bytes and sent via data= (not json=) so the
    server sees the exact same bytes we computed the signature over.
    """
    body_bytes = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
    try:
        headers = sign_headers(cfg["agent_key"], body_bytes)
    except Exception as e:
        log.warning("HMAC signing failed, falling back to plain key: %s", e)
        headers = {"x-agent-key": cfg["agent_key"]}
    # Merge any caller-provided headers (e.g., none currently, but future-proof)
    headers.update(kwargs.pop("headers", {}))
    headers.setdefault("Content-Type", "application/json")
    return requests.post(url, data=body_bytes, headers=headers, **kwargs)


# ---------------------------------------------------------------------------
# Server communication
# ---------------------------------------------------------------------------

def checkin(cfg: dict) -> dict | None:
    try:
        resp = _signed_post(
            f"{cfg['server_url']}/api/agent/checkin",
            cfg,
            {
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
            },
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
) -> bool:
    """Send command ACK to server. Returns True on success, False on failure.

    The return value is used by the pending-ACK retry mechanism (A4):
    on failure, the ACK is persisted locally and retried on the next loop.
    """
    payload = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
        "command_id": command_id,
        "result_status": result_status,
    }
    if key_material:
        payload["key_material"] = key_material
    if bios_password:
        payload["bios_password"] = bios_password
    if boot_lock_status:
        payload["boot_lock_status"] = boot_lock_status
    try:
        resp = _signed_post(
            f"{cfg['server_url']}/api/agent/command-ack",
            cfg,
            payload,
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        log.info("ACK sent: command=%s status=%s", command_id, result_status)
        return True
    except requests.RequestException as e:
        log.error("ACK failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Pending ACK persistence (A1 + A4)
# ---------------------------------------------------------------------------

def _fsync_file(path: Path) -> None:
    """Ensure file contents are flushed to disk (crash safety)."""
    import contextlib
    with contextlib.suppress(Exception):
        with open(path, 'r+b') as f:
            f.flush()
            os.fsync(f.fileno())


def write_pending_ack(
    file_path: Path,
    command_id: str,
    result_status: str,
    key_material: str | None = None,
    bios_password: str | None = None,
    boot_lock_status: str | None = None,
) -> None:
    """Write the pending ACK state to disk (fsync'd).

    Called BEFORE encrypt_folder() so a crash doesn't lose the key.
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
    file_path.write_text(json.dumps(state))
    _fsync_file(file_path)


def update_pending_ack(
    file_path: Path,
    bios_password: str | None = None,
    boot_lock_status: str | None = None,
) -> None:
    """Update the pending ACK file with bios_password / boot_lock_status
    after boot lockdown completes."""
    if not file_path.exists():
        return
    state = json.loads(file_path.read_text())
    if bios_password:
        state["bios_password"] = bios_password
    if boot_lock_status:
        state["boot_lock_status"] = boot_lock_status
    file_path.write_text(json.dumps(state))
    _fsync_file(file_path)


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
        )
        if ok:
            pending_ack_file.unlink()
            log.info("Pending ACK drained & deleted for command=%s", state["command_id"])
        else:
            log.warning("Pending ACK retry failed; will retry next loop")
    except Exception as e:
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
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives import hashes
        pem_data = pem_path.read_bytes()
        public_key = serialization.load_pem_public_key(pem_data)
        return public_key
    except Exception as e:
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
        from cryptography.hazmat.primitives.asymmetric import padding
        from cryptography.hazmat.primitives import hashes

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

        file_path.write_text(json.dumps(state))
        _fsync_file(file_path)
        log.info("Recovery key file written (RSA-wrapped, command=%s)", command_id)
    except Exception as e:
        log.error("Failed to write recovery key file: %s", e)


def delete_recovery_key() -> None:
    """Delete the recovery key file. Called on successful unlock."""
    if RECOVERY_KEY_FILE.exists():
        RECOVERY_KEY_FILE.unlink()
        log.info("Recovery key file deleted (unlock successful)")

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

def handle_lockdown(cfg: dict, command: dict) -> None:
    log.warning("LOCKDOWN command received — executing")
    folder = cfg["lockdown_folder"]
    sentinel = cfg["lock_sentinel"]

    # If the deadman switch already locked the device, the folder is already
    # encrypted and the key was uploaded via report_deadman_key. Just ACK.
    if sentinel.exists():
        log.warning("Sentinel already exists — device already locked, skipping encryption")
        ack_command(cfg, command["id"], "executed")
        return

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

    try:
        encrypt_folder(folder, key)
    except Exception as e:
        log.error("Encryption failed: %s", e)
        # Update pending ACK to 'failed' so the server knows. Do NOT delete File A.
        write_pending_ack(pending_ack_file, command["id"], "failed", key_material=key_b64)
        ack_command(cfg, command["id"], "failed")
        return

    apply_lock_screen()
    start_lock_guardian()

    sentinel.write_text(json.dumps({"locked": True, "command_id": command["id"]}))
    log.info("Sentinel written: %s", sentinel)

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
    bios_password = None
    boot_lock_status = None
    if cfg.get("boot_lock_enabled", True) and _boot_lock_modules_available:
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
        except Exception as e:
            log.error("BCD lockdown failed: %s", e)
            boot_lock_status = "partial"

        try:
            # UEFI lockdown (HP-specific via WMI)
            # Phase 4: returns dict with bios_password + success/partial/rolled_back
            existing_pw = cfg.get("uefi_password") or None
            hp_result = hp_uefi_lockdown.apply_boot_lockdown(existing_pw)
            bios_password = hp_result.get("bios_password")
            if hp_result.get("not_hp"):
                log.info("UEFI boot lockdown skipped (not an HP machine)")
            elif hp_result.get("rolled_back"):
                log.error("UEFI lockdown critically failed and was rolled back — BIOS password retained for operator action")
                boot_lock_status = "partial"
            elif hp_result.get("partial"):
                log.warning("UEFI lockdown applied with some best-effort failures")
                boot_lock_status = "partial" if boot_lock_status is None else boot_lock_status
            elif hp_result.get("success"):
                log.warning("UEFI boot lockdown applied — BIOS password sent to server")
            else:
                log.warning("UEFI boot lockdown skipped (not HP or password required)")
                if boot_lock_status is None:
                    boot_lock_status = "partial"
        except Exception as e:
            log.error("UEFI lockdown failed: %s", e)
            if boot_lock_status is None:
                boot_lock_status = "partial"

    # Update File A with bios_password + boot_lock_status for ACK retry
    update_pending_ack(pending_ack_file, bios_password=bios_password, boot_lock_status=boot_lock_status)

    # --- A4: ACK with return value. On success, delete File A (NOT File B). ---
    ok = ack_command(
        cfg, command["id"], "executed",
        key_material=key_b64,
        bios_password=bios_password,
        boot_lock_status=boot_lock_status,
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
    except Exception as e:
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
        try:
            bcd_lockdown.remove_bcd_lockdown()
        except Exception as e:
            log.error("BCD lockdown removal failed: %s", e)

        if bios_password:
            try:
                hp_uefi_lockdown.remove_boot_lockdown(bios_password)
                log.info("UEFI boot lockdown removed — BIOS restored to pre-lockdown state")
                del bios_password
            except Exception as e:
                log.error("UEFI lockdown removal failed: %s — admin may need to clear BIOS manually", e)
        else:
            log.warning("No BIOS password in unlock command — cannot remove UEFI lockdown automatically")

    del key
    ack_command(cfg, command["id"], "executed")

def handle_status(cfg: dict, command: dict) -> None:
    log.info("STATUS command received — reporting OK")
    ack_command(cfg, command["id"], "executed")

def handle_track(cfg: dict, command: dict) -> None:
    """Switch to covert tracking mode. No visible action — just report location."""
    log.info("TRACK command received — entering covert tracking mode")
    # Report location immediately
    report_location(cfg)
    # ACK as executed — server will set status to 'tracking'
    ack_command(cfg, command["id"], "executed")

def handle_stop_track(cfg: dict, command: dict) -> None:
    """Exit covert tracking mode — return to normal active status."""
    log.info("STOP_TRACK command received — exiting tracking mode")
    ack_command(cfg, command["id"], "executed")

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
    sentinel = cfg["lock_sentinel"]
    if sentinel.exists():
        log.warning("Device was previously locked — re-asserting lock screen")
        apply_lock_screen()
        start_lock_guardian()

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

# --- A1/A4: Pending ACK file (transient, plaintext, deleted on ACK success) ---
# Written BEFORE encrypt_folder() so a crash between encryption and ACK
# doesn't lose the key. Drained by the main loop on restart.
# (Path defined at top of module via _STATE_DIR.)

# --- A8: Recovery key file (long-lived, RSA-wrapped, deleted on unlock) ---
# Contains the Fernet data key wrapped with the IT master RSA public key.
# Survives ACK success, reboots, and server loss — enables offline recovery.
# (Path defined at top of module via _STATE_DIR.)

def update_deadman_timer(status: str) -> None:
    """Write current time + device status to the dead man's file."""
    DEADMAN_FILE.write_text(json.dumps({
        "last_seen": time.time(),
        "status": status,
    }))

def check_deadman(cfg: dict) -> None:
    """If device was flagged stolen and hasn't reached server in DEADMAN_TIMEOUT_HOURS, lock it."""
    if not DEADMAN_FILE.exists():
        return
    try:
        state = json.loads(DEADMAN_FILE.read_text())
        if state.get("status") != "stolen":
            return
        elapsed_hours = (time.time() - state["last_seen"]) / 3600
        if elapsed_hours >= DEADMAN_TIMEOUT_HOURS:
            log.warning(
                "DEAD MAN SWITCH: device was stolen and offline for %.1fh — triggering lockdown",
                elapsed_hours
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
                encrypt_folder(cfg["lockdown_folder"], key)
                apply_lock_screen()
                start_lock_guardian()
                sentinel.write_text(json.dumps({"locked": True, "deadman": True}))
                # Store key locally so it can be uploaded to the server once
                # network connectivity is restored — without this the device
                # would be permanently unrecoverable.
                DEADMAN_KEY_FILE.write_text(key_b64)
                log.warning("Deadman lockdown complete — key stored locally for upload on reconnection")
                del key, key_b64
    except Exception as e:
        log.error("Dead man check failed: %s", e)

def report_deadman_key(cfg: dict) -> None:
    """If a deadman key is stored locally, upload it to the server and wipe the local copy."""
    if not DEADMAN_KEY_FILE.exists():
        return
    try:
        key_material = DEADMAN_KEY_FILE.read_text().strip()
        resp = _signed_post(
            f"{cfg['server_url']}/api/agent/deadman-report",
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
    except Exception as e:
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
UPDATE_PENDING_FILE = _STATE_DIR / '.update_pending'
# Downloaded binary (watchdog moves this to replace the current binary)
UPDATE_DOWNLOAD_FILE = _STATE_DIR / '.update_downloaded'

# Check for updates at most once per hour (not every checkin)
UPDATE_CHECK_INTERVAL = 3600  # seconds


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

        log.info("Update available: %s → %s (%s bytes)",
                 AGENT_VERSION, latest_version, size)

        # Download the new binary
        if not download_url:
            log.warning("Update available but no download_url provided")
            return

        full_url = f"{cfg['server_url']}{download_url}"
        download_update(cfg, full_url, expected_sha256, latest_version)

    except requests.RequestException as e:
        log.debug("Update check failed: %s", e)
    except Exception as e:
        log.warning("Update check error: %s", e)


def download_update(cfg: dict, url: str, expected_sha256: str, version: str) -> None:
    """Download the new agent binary, verify SHA-256, and signal the watchdog.

    Downloads to UPDATE_DOWNLOAD_FILE, then writes UPDATE_PENDING_FILE
    with metadata for the watchdog to consume.
    """
    try:
        log.info("Downloading update from %s ...", url)
        headers = sign_headers(cfg["agent_key"], b"")
        headers["X-Agent-Platform"] = "win" if sys.platform == "win32" else "linux"

        resp = requests.get(url, headers=headers, stream=True,
                            timeout=120, verify=cfg["verify_tls"])
        resp.raise_for_status()

        # Download to temp file first, then rename (atomic)
        tmp_file = UPDATE_DOWNLOAD_FILE.with_suffix('.tmp')
        sha256 = hashlib.sha256()
        total = 0

        with open(tmp_file, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    sha256.update(chunk)
                    total += len(chunk)

        actual_sha256 = sha256.hexdigest()
        if actual_sha256 != expected_sha256:
            log.error("Update SHA-256 mismatch: expected %s, got %s",
                      expected_sha256, actual_sha256)
            tmp_file.unlink(missing_ok=True)
            return

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
        }
        UPDATE_PENDING_FILE.write_text(_json.dumps(signal, indent=2))
        log.info("Update signal written — watchdog will apply on next check")

    except Exception as e:
        log.error("Update download failed: %s", e)
        # Clean up partial download
        try:
            tmp_file.unlink(missing_ok=True)
        except Exception:
            pass


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
# Main polling loop
# ---------------------------------------------------------------------------

def main() -> None:
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description='Remote Device Lockdown Agent')
    parser.add_argument('--config', '-c', type=str, default=None,
                        help='Path to config file (JSON or INI format)')
    parser.add_argument('--silent', action='store_true',
                        help='Suppress stdout logging for covert operation')
    parser.add_argument('--version', '-v', action='store_true',
                        help='Show version and exit')
    args, _ = parser.parse_known_args()

    if args.version:
        print(f"lockdown-agent {AGENT_VERSION} (frozen={_is_frozen()})")
        sys.exit(0)

    cfg = load_config(config_path=args.config)
    if not cfg["agent_key"]:
        log.error("AGENT_SHARED_KEY is not set. Exiting.")
        log.error("Set DEVICE_API_KEY env var, or provide a config file with --config")
        sys.exit(1)

    # --silent flag: suppress stdout logging for covert operation
    if args.silent:
        logging.disable(logging.INFO)
        log.info("Running in silent mode — stdout logging suppressed")

    log.info("Agent starting — hostname=%s server=%s poll=%ss",
             cfg["hostname"], cfg["server_url"], cfg["poll_interval"])
    startup_check(cfg)

    # Clear any stale update signal from a previous run
    clear_update_signal()

    last_location_report = 0.0
    last_update_check = 0.0
    current_status = "active"

    while True:
        # Update heartbeat so watchdog knows agent is alive
        try:
            HEARTBEAT_FILE.touch()
        except Exception:
            pass

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

            # Update dead man's timer with current server-reported status
            current_status = data.get("status", "active")
            update_deadman_timer(current_status)

            command = data.get("command")
            if command:
                cmd_type = command.get("type")
                handler = COMMAND_HANDLERS.get(cmd_type)
                if handler:
                    try:
                        handler(cfg, command)
                    except Exception as e:
                        log.exception("Handler %s crashed: %s", cmd_type, e)
                        ack_command(cfg, command["id"], "failed")
                else:
                    log.warning("Unknown command type: %s", cmd_type)

            # If device is in tracking mode, report location periodically
            if current_status == "tracking":
                now = time.time()
                if now - last_location_report >= cfg["location_interval"]:
                    report_location(cfg)
                    last_location_report = now

            # Phase 4: Check for agent updates (throttled to once per hour)
            now = time.time()
            if now - last_update_check >= UPDATE_CHECK_INTERVAL:
                check_for_update(cfg)
                last_update_check = now

        time.sleep(cfg["poll_interval"])

if __name__ == "__main__":
    main()
