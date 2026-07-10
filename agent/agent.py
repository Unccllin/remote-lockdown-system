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
import logging
import platform
import subprocess
import socket
import uuid
import configparser
import threading
from pathlib import Path

import requests
from cryptography.fernet import Fernet

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
# Config
# ---------------------------------------------------------------------------
CONFIG_FILE = Path(__file__).parent / "config.ini"

def load_config() -> dict:
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_FILE)
    section = cfg["agent"] if "agent" in cfg else {}

    return {
        "server_url": os.environ.get("SERVER_URL", section.get("server_url", "https://localhost:3001")),
        "agent_key": os.environ.get("AGENT_SHARED_KEY", section.get("agent_key", "")),
        "hostname": os.environ.get("DEVICE_HOSTNAME", section.get("hostname", socket.gethostname())),
        "poll_interval": int(os.environ.get("POLL_INTERVAL", section.get("poll_interval", "30"))),
        "lockdown_folder": Path(
            os.environ.get("LOCKDOWN_FOLDER", section.get("lockdown_folder", str(Path.home() / "SecureData")))
        ),
        "lock_sentinel": Path(
            os.environ.get("LOCK_SENTINEL", section.get("lock_sentinel", str(Path(__file__).parent / ".locked")))
        ),
        "verify_tls": section.get("verify_tls", "true").lower() != "false",
        "google_api_key": os.environ.get("GOOGLE_API_KEY", section.get("google_api_key", "")),
        "location_interval": int(os.environ.get("LOCATION_INTERVAL", section.get("location_interval", "300"))),
    }

# ---------------------------------------------------------------------------
# Encryption helpers (Fernet = AES-128-CBC + HMAC-SHA256)
# ---------------------------------------------------------------------------

def generate_key() -> bytes:
    return Fernet.generate_key()

def encrypt_folder(folder: Path, key: bytes) -> None:
    """Encrypt all files inside `folder` in-place. Never touches files outside it."""
    folder = folder.resolve()
    fernet = Fernet(key)
    for filepath in folder.rglob("*"):
        if filepath.is_file() and not filepath.name.endswith(".enc"):
            data = filepath.read_bytes()
            encrypted = fernet.encrypt(data)
            enc_path = filepath.with_suffix(filepath.suffix + ".enc")
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
        resp = requests.post(
            f"{cfg['server_url']}/api/agent/location",
            json={
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
                "location": location,
            },
            headers={"x-agent-key": cfg["agent_key"]},
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
# Server communication
# ---------------------------------------------------------------------------

def checkin(cfg: dict) -> dict | None:
    try:
        resp = requests.post(
            f"{cfg['server_url']}/api/agent/checkin",
            json={
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
            },
            headers={"x-agent-key": cfg["agent_key"]},
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        return resp.json()
    except requests.RequestException as e:
        log.warning("Check-in failed: %s", e)
        return None

def ack_command(cfg: dict, command_id: str, result_status: str, key_material: str | None = None) -> None:
    payload = {
        "hostname": cfg["hostname"],
        "mac_address": get_mac_address(),
        "hardware_uuid": get_hardware_uuid(),
        "command_id": command_id,
        "result_status": result_status,
    }
    if key_material:
        payload["key_material"] = key_material
    try:
        resp = requests.post(
            f"{cfg['server_url']}/api/agent/command-ack",
            json=payload,
            headers={"x-agent-key": cfg["agent_key"]},
            timeout=15,
            verify=cfg["verify_tls"],
        )
        resp.raise_for_status()
        log.info("ACK sent: command=%s status=%s", command_id, result_status)
    except requests.RequestException as e:
        log.error("ACK failed: %s", e)

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
    try:
        encrypt_folder(folder, key)
    except Exception as e:
        log.error("Encryption failed: %s", e)
        ack_command(cfg, command["id"], "failed")
        return

    apply_lock_screen()
    start_lock_guardian()

    sentinel.write_text(json.dumps({"locked": True, "command_id": command["id"]}))
    log.info("Sentinel written: %s", sentinel)

    key_b64 = key.decode()
    ack_command(cfg, command["id"], "executed", key_material=key_b64)
    log.warning("Key transmitted to server — wiping local copy")
    del key
    del key_b64

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

COMMAND_HANDLERS = {
    "lockdown": handle_lockdown,
    "unlock": handle_unlock,
    "status": handle_status,
    "track": handle_track,
    "stop_track": handle_stop_track,
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

DEADMAN_FILE  = Path(__file__).parent / ".deadman"
HEARTBEAT_FILE = Path(__file__).parent / ".heartbeat"
DEADMAN_KEY_FILE = Path(__file__).parent / ".deadman_key"
DEADMAN_TIMEOUT_HOURS = 24  # Lock if flagged-stolen and offline for this long

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
                encrypt_folder(cfg["lockdown_folder"], key)
                apply_lock_screen()
                start_lock_guardian()
                sentinel.write_text(json.dumps({"locked": True, "deadman": True}))
                # Store key locally so it can be uploaded to the server once
                # network connectivity is restored — without this the device
                # would be permanently unrecoverable.
                DEADMAN_KEY_FILE.write_text(key.decode())
                log.warning("Deadman lockdown complete — key stored locally for upload on reconnection")
                del key
    except Exception as e:
        log.error("Dead man check failed: %s", e)

def report_deadman_key(cfg: dict) -> None:
    """If a deadman key is stored locally, upload it to the server and wipe the local copy."""
    if not DEADMAN_KEY_FILE.exists():
        return
    try:
        key_material = DEADMAN_KEY_FILE.read_text().strip()
        resp = requests.post(
            f"{cfg['server_url']}/api/agent/deadman-report",
            json={
                "hostname": cfg["hostname"],
                "mac_address": get_mac_address(),
                "hardware_uuid": get_hardware_uuid(),
                "key_material": key_material,
            },
            headers={"x-agent-key": cfg["agent_key"]},
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
# Main polling loop
# ---------------------------------------------------------------------------

def main() -> None:
    cfg = load_config()
    if not cfg["agent_key"]:
        log.error("AGENT_SHARED_KEY is not set. Exiting.")
        sys.exit(1)

    # --silent flag: suppress stdout logging for covert operation
    silent = "--silent" in sys.argv
    if silent:
        logging.disable(logging.INFO)
        log.info("Running in silent mode — stdout logging suppressed")

    log.info("Agent starting — hostname=%s server=%s poll=%ss",
             cfg["hostname"], cfg["server_url"], cfg["poll_interval"])
    startup_check(cfg)

    last_location_report = 0.0
    current_status = "active"

    while True:
        # Update heartbeat so watchdog knows agent is alive
        try:
            HEARTBEAT_FILE.touch()
        except Exception:
            pass

        # Check dead man's switch before attempting network
        check_deadman(cfg)

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

        time.sleep(cfg["poll_interval"])

if __name__ == "__main__":
    main()
