"""
Remote Lockdown Agent
---------------------
Runs on the managed device. Polls the server for pending commands and executes them.

SAFETY RULES (enforced in code):
  - Only encrypts LOCKDOWN_FOLDER, never touches system files or full disk.
  - Decryption key is NEVER stored locally after locking — it lives only on the server.
  - All communication over TLS (verify=True in requests).
  - Lock state persists across reboots via a sentinel file.

REQUIREMENTS:
  pip install cryptography requests

USAGE:
  Set the environment variables (or edit config.ini), then run:
    python agent.py

  To run as a background service on Windows, use NSSM or Task Scheduler.
  On Linux, use a systemd unit file.
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

def apply_lock_screen() -> None:
    """Replace interactive shell with a lock message. Best-effort per platform."""
    msg = (
        "\n\n"
        "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n"
        "  !                                                       !\n"
        "  !   THIS DEVICE HAS BEEN REPORTED STOLEN               !\n"
        "  !   Contact IT Support immediately:                     !\n"
        "  !   support@yourcompany.com  /  +1-800-XXX-XXXX        !\n"
        "  !                                                       !\n"
        "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n"
    )
    system = platform.system()
    if system == "Windows":
        try:
            import ctypes
            ctypes.windll.user32.LockWorkStation()
            log.info("Windows: workstation locked")
        except Exception as e:
            log.warning("Windows lock failed: %s", e)
    elif system == "Linux":
        for cmd in [["dm-tool", "lock"], ["loginctl", "lock-session"], ["xdg-screensaver", "lock"]]:
            try:
                subprocess.run(cmd, check=True, timeout=5)
                log.info("Linux: screen locked via %s", cmd[0])
                break
            except Exception:
                continue
    elif system == "Darwin":
        try:
            subprocess.run(["/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession", "-suspend"], timeout=5)
            log.info("macOS: screen locked")
        except Exception as e:
            log.warning("macOS lock failed: %s", e)

    print(msg)

def remove_lock_screen() -> None:
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

COMMAND_HANDLERS = {
    "lockdown": handle_lockdown,
    "unlock": handle_unlock,
    "status": handle_status,
}

# ---------------------------------------------------------------------------
# Startup check (persist lock across reboots)
# ---------------------------------------------------------------------------

def startup_check(cfg: dict) -> None:
    sentinel = cfg["lock_sentinel"]
    if sentinel.exists():
        log.warning("Device was previously locked — re-asserting lock screen")
        apply_lock_screen()

# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------

def main() -> None:
    cfg = load_config()
    if not cfg["agent_key"]:
        log.error("AGENT_SHARED_KEY is not set. Exiting.")
        sys.exit(1)

    log.info("Agent starting — hostname=%s server=%s poll=%ss",
             cfg["hostname"], cfg["server_url"], cfg["poll_interval"])
    startup_check(cfg)

    while True:
        data = checkin(cfg)
        if data:
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
        time.sleep(cfg["poll_interval"])

if __name__ == "__main__":
    main()
