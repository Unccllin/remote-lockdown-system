#!/usr/bin/env python3
"""
Lockdown Agent Setup Wizard — GUI Installer
-------------------------------------------
A single .exe that an operator runs on a target Windows machine.

It shows a wizard GUI that:
  1. Checks for admin privileges (auto-elevates if needed)
  2. Collects the enrollment token (paste from dashboard)
  3. Auto-detects hostname, hardware UUID, serial number, MAC address
  4. Enrolls the device via POST /api/enroll/claim
  5. Writes config.json to C:\\ProgramData\\LockdownAgent\\
  6. Copies the agent binary to the install directory
  7. Installs the scheduled task watchdog (auto-restart if killed)
  8. Launches the agent
  9. Optionally runs hardware self-tests (encrypt, lock-screen, guardian)
 10. Shows a summary with device ID + hardware IDs

The operator only needs:
  - The enrollment token (generated in the admin dashboard, 15-min validity)
  - Admin privileges (the app auto-elevates via UAC)

Build with PyInstaller:
    py -m PyInstaller --onefile --noconsole --name lockdown-setup \\
        --hidden-import service_installer \\
        --hidden-import tamper_protection \\
        --hidden-import cryptography.fernet \\
        --icon=lockdown-icon.ico \\
        installer_gui.py
"""

from __future__ import annotations

import ctypes
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, cast

import requests

# Tkinter is Windows-only (the GUI runs on the target Windows machine).
# Import lazily so the non-GUI functions (hardware ID collection, enrollment,
# config writing) can be tested on Linux without tkinter installed.
#
# The module-level names are annotated `Any` in the fallback branch on purpose:
# the wizard's ~60 `tk.*` / `ttk.*` call sites are guarded by TKINTER_AVAILABLE at
# the point where the wizard is constructed, and annotating the fallback keeps the
# whole file importable and type-checkable on a host that is not the target.
try:
    import tkinter as tk
    from tkinter import messagebox, ttk

    TKINTER_AVAILABLE = True
except ImportError:  # pragma: no cover - Windows always ships tkinter
    TKINTER_AVAILABLE = False
    tk: Any = None
    messagebox: Any = None
    ttk: Any = None

# Windows-only attributes, resolved defensively. `ctypes.windll` and the Popen
# creation flags exist only on Windows; reading them through getattr keeps this
# module importable (and checkable) on Linux without changing Windows behaviour.
_WINDLL: Any = getattr(ctypes, "windll", None)
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0)


def _shell32() -> Any:
    """ctypes' shell32 handle on Windows, None everywhere else.

    Typed `Any` deliberately: these two calls are Windows-only by construction,
    and the module must still import on the host that runs the test suite.
    """
    windll = cast(Any, _WINDLL)
    return None if windll is None else cast(Any, windll.shell32)


# ---------------------------------------------------------------------------
# Constants — shared with installer.py
# ---------------------------------------------------------------------------

# Deliberately empty: prefilling a backend silently enrolled devices into a server
# that had never issued the operator's token (S213). An empty field with a
# placeholder makes the operator choose.
DEFAULT_SERVER_URL = ""
INSTALL_DIR = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
CONFIG_FILE = INSTALL_DIR / "config.json"
AGENT_EXE_NAME = "lockdown-agent.exe"
LOCKDOWN_FOLDER = INSTALL_DIR / "lockdown_folder"

# ---------------------------------------------------------------------------
# Hardware ID collection — shared with installer.py
# ---------------------------------------------------------------------------


def get_hostname() -> str:
    try:
        return socket.gethostname()
    except OSError:
        return "UNKNOWN"


def get_mac_address() -> str | None:
    try:
        import uuid

        mac = uuid.getnode()
        return ":".join(f"{(mac >> ele) & 0xFF:02X}" for ele in range(40, -1, -8))
    except (OSError, AttributeError, ValueError):
        return None


def get_hardware_uuid() -> str | None:
    if platform.system() != "Windows":
        return None
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        uid = result.stdout.strip()
        if uid and uid != "00000000-0000-0000-0000-000000000000":
            return uid
    except Exception:  # noqa: S110
        pass
    return None


def get_serial_number() -> str | None:
    system = platform.system()
    try:
        if system == "Windows":
            result = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "(Get-CimInstance -ClassName Win32_BIOS).SerialNumber",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            serial = result.stdout.strip()
            placeholders = {"", "none", "default string", "to be filled by o.e.m.", "0"}
            if serial and serial.lower() not in placeholders:
                return serial
        elif system == "Linux":
            try:
                serial = Path("/sys/class/dmi/id/product_serial").read_text().strip()
                if serial:
                    return serial
            except (FileNotFoundError, PermissionError):
                pass
        elif system == "Darwin":
            result = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.splitlines():
                if "IOPlatformSerialNumber" in line:
                    return line.split('"')[-2]
    except Exception:  # noqa: S110
        pass
    return None


def is_admin() -> bool:
    shell32: Any = _shell32()
    if shell32 is None:
        return False
    try:
        return bool(shell32.IsUserAnAdmin())
    except (OSError, AttributeError, PermissionError):
        return False


def relaunch_as_admin():
    """Re-launch the current executable with UAC elevation."""
    params = " ".join(f'"{a}"' for a in sys.argv[1:])
    shell32: Any = _shell32()
    shell32.ShellExecuteW(None, "runas", sys.executable, params, None, 1)
    sys.exit(0)


# ---------------------------------------------------------------------------
# Enrollment + installation logic (runs in background thread)
# ---------------------------------------------------------------------------


def enroll_device_with_token(
    server_url: str,
    token: str,
    hostname: str,
    owner_name: str,
    hardware_uuid: str | None,
    mac_address: str | None,
    serial_number: str | None,
) -> dict:
    url = f"{server_url.rstrip('/')}/api/enroll/claim"
    payload = {
        "token": token,
        "hostname": hostname,
        "owner_name": owner_name,
        "hardware_uuid": hardware_uuid,
        "mac_address": mac_address,
        "serial_number": serial_number,
    }
    resp = requests.post(url, json=payload, timeout=30, verify=True)
    if resp.status_code == 401:
        body = ""
        try:
            body = resp.json().get("error", "")
        except (ValueError, KeyError):
            pass
        if "expired" in body.lower():
            raise Exception("Enrollment token has expired. Generate a new one in the dashboard.")
        if "already used" in body.lower():
            raise Exception(
                "Enrollment token already used — generate a new token in the dashboard."
            )
        raise Exception("Enrollment token rejected. Check the token and try again.")
    # 200 = re-associated with an already-enrolled hardware identity; both are success.
    if resp.status_code not in (200, 201):
        raise Exception(f"Enrollment failed (HTTP {resp.status_code}): {resp.text}")
    return resp.json()


UPDATE_KEY_FILENAME = "update_signing.pub"


def staged_update_public_key() -> str:
    """Path of a staged update public key, or "" when none is present.

    Only a key that exists may be named in config.json: the agent refuses every
    future update when update_public_key is configured but unreadable, so a
    missing file must mean "unpinned", never "pinned to nothing".
    """
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).parent
    else:
        base = Path(__file__).parent
    candidate = base / UPDATE_KEY_FILENAME
    return str(candidate) if candidate.is_file() else ""


def install_update_public_key(source: str | Path | None = None) -> str:
    """Copy a staged update public key into INSTALL_DIR; return its final path.

    The pin must name a path that outlives the install run. The GUI is normally
    launched from the download folder, so naming the staged path would break every
    future update as soon as that folder is cleaned (the agent fails closed on a
    configured key it cannot read). A copy failure returns "" — unpinned and
    reported as SHA-256-only at check-in — rather than naming an unusable path.
    """
    candidate = Path(source) if source else Path(staged_update_public_key() or "")
    if not candidate.is_file():
        return ""

    dest = INSTALL_DIR / UPDATE_KEY_FILENAME
    try:
        INSTALL_DIR.mkdir(parents=True, exist_ok=True)
        if candidate.resolve() != dest.resolve():
            shutil.copy2(candidate, dest)
    except OSError:  # pragma: no cover - depends on host filesystem
        return ""
    return str(dest)


def write_config(
    server_url: str,
    api_key: str,
    hostname: str,
    device_id: str,
    boot_lock_enabled: bool = True,
    update_public_key: str = "",
) -> Path:
    """Write the agent config file atomically.

    Writes to a temp file first, then renames to the final path so a
    crash during the write doesn't leave a corrupt config.
    """
    config = {
        "server_url": server_url.rstrip("/"),
        "api_key": api_key,
        "hostname": hostname,
        "device_id": device_id,
        "poll_interval": 30,
        "lockdown_folder": str(LOCKDOWN_FOLDER),
        "lock_sentinel": str(INSTALL_DIR / ".locked"),
        "pending_ack_file": str(INSTALL_DIR / ".pending_ack"),
        "recovery_key_file": str(INSTALL_DIR / ".recovery_key"),
        "boot_lock_enabled": boot_lock_enabled,
        "verify_tls": True,
        "server_supports_ack_dedup": True,
    }
    # Only present when a key was actually provisioned — a configured-but-missing
    # path would make the agent refuse all future updates.
    if update_public_key:
        config["update_public_key"] = update_public_key
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)

    # Atomic write: write to temp file, then rename
    tmp_file = CONFIG_FILE.with_suffix(".json.tmp")
    try:
        tmp_file.write_text(json.dumps(config, indent=2))
        # On Windows, os.replace() atomically replaces the target
        os.replace(str(tmp_file), str(CONFIG_FILE))
    except OSError as e:
        if tmp_file.exists():
            tmp_file.unlink()
        raise RuntimeError(f"Failed to write config file: {e}") from e

    # Verify the file was actually written
    if not CONFIG_FILE.exists():
        raise RuntimeError(f"Config file was not created at {CONFIG_FILE}")
    return CONFIG_FILE


def find_agent_exe() -> Path | None:
    """Find the agent exe locally (next to installer or in cwd)."""
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).parent
    else:
        exe_dir = Path(__file__).parent
    for candidate in [exe_dir / AGENT_EXE_NAME, Path.cwd() / AGENT_EXE_NAME]:
        if candidate.exists():
            return candidate
    return None


# A real agent/lock-screen binary is many megabytes. The digest check below is
# the real gate; this floor only rejects an obviously wrong body early.
MIN_BINARY_BYTES = 1_000_000


def _download_verified(url: str, dest: Path, *, timeout: int = 120) -> Path | None:
    """Download *url* to *dest*, verifying the response's x-content-sha256.

    The Worker computes the digest of exactly the bytes it serves, so a
    truncated, corrupted or altered body is refused instead of installed. This is
    transport integrity, not authenticity: a hash delivered alongside the bytes
    is self-certifying (the same caveat the agent's update path records for
    channel-delivered hashes). Authenticity needs a signature, and the binaries
    are not Authenticode-signed yet.

    Returns the path on success, None on any failure (nothing is left behind).
    """
    import hashlib

    tmp = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with requests.get(url, timeout=timeout, verify=True, stream=True) as resp:
            if resp.status_code != 200:
                return None
            expected = (resp.headers.get("x-content-sha256") or "").strip().lower()
            if not expected:
                return None
            digest = hashlib.sha256()
            with open(tmp, "wb") as f:
                for chunk in resp.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
                        digest.update(chunk)
        if digest.hexdigest() != expected:
            tmp.unlink(missing_ok=True)
            return None
        if tmp.stat().st_size <= MIN_BINARY_BYTES:
            tmp.unlink(missing_ok=True)
            return None
        tmp.replace(dest)
        return dest
    except (requests.RequestException, OSError):
        tmp.unlink(missing_ok=True)
        return None


def download_agent_exe(server_url: str, dest_dir: Path) -> Path | None:
    """Download the agent binary from the Worker (GET /api/download/agent).

    This is used when the agent exe is not bundled with the installer.
    The binary is stored in Cloudflare KV and served by the Worker, together with
    the digest that :func:`_download_verified` checks.
    """
    url = f"{server_url.rstrip('/')}/api/download/agent"
    dest_dir.mkdir(parents=True, exist_ok=True)
    return _download_verified(url, dest_dir / AGENT_EXE_NAME)


def download_lockscreen_exe(server_url: str, dest_dir: Path) -> Path | None:
    """Download the lock screen overlay from the Worker (GET /api/download/lockscreen).

    The lock screen is a fullscreen topmost window that blocks all desktop
    interaction during lockdown. Without it, the agent falls back to
    LockWorkStation() which a thief can bypass by logging back in. The download is
    digest-checked exactly like the agent binary.
    """
    url = f"{server_url.rstrip('/')}/api/download/lockscreen"
    dest_dir.mkdir(parents=True, exist_ok=True)
    return _download_verified(url, dest_dir / "lockdown-lockscreen.exe")


def install_files(agent_exe: Path) -> Path:
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    dest = INSTALL_DIR / AGENT_EXE_NAME
    if agent_exe.resolve() != dest.resolve():
        shutil.copy2(agent_exe, dest)

    # Also install the lock screen overlay if it's next to the agent exe
    lockscreen_src = agent_exe.parent / "lockdown-lockscreen.exe"
    if lockscreen_src.exists():
        lockscreen_dest = INSTALL_DIR / "lockdown-lockscreen.exe"
        if lockscreen_src.resolve() != lockscreen_dest.resolve():
            shutil.copy2(lockscreen_src, lockscreen_dest)

    return dest


def create_lockdown_folder():
    LOCKDOWN_FOLDER.mkdir(parents=True, exist_ok=True)
    test_file = LOCKDOWN_FOLDER / "README.txt"
    if not test_file.exists():
        test_file.write_text(
            "This device is protected by Remote Lockdown System.\n"
            "If you see this file encrypted, the device has been flagged as stolen.\n"
            "Contact your administrator to recover access.\n"
        )


def install_service() -> tuple[bool, str]:
    """Install the scheduled task + registry run key.

    Returns (success, message) so the GUI can show the actual error
    instead of a generic "module not found".
    """
    try:
        import service_installer

        result = service_installer.install()
        if result:
            return True, "installed"
        return False, "service_installer.install() returned False — check agent.log"
    except ImportError:
        return False, "service_installer module not found"
    except FileNotFoundError as e:
        return False, f"missing system binary: {e}"
    except subprocess.SubprocessError as e:
        return False, f"subprocess error: {e}"
    except (OSError, RuntimeError) as e:
        return False, f"{type(e).__name__}: {e}"


def add_defender_exclusions() -> bool:
    """Add Windows Defender exclusions for the agent install directory.

    PyInstaller-built executables often trigger false positives in
    antivirus software because they pack Python + dependencies into a
    single .exe (similar to how malware packs payloads). Adding an
    exclusion for the install directory prevents Defender from
    quarantining the agent binary.
    """
    if platform.system() != "Windows":
        return False
    try:
        install_path = str(INSTALL_DIR)
        agent_path = str(INSTALL_DIR / AGENT_EXE_NAME)
        for path in [install_path, agent_path]:
            subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"Add-MpPreference -ExclusionPath '{path}'",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
        return True
    except Exception:  # noqa: S110
        return False


def launch_agent(agent_path: Path):
    subprocess.Popen(
        [str(agent_path), "--config", str(CONFIG_FILE)],
        creationflags=_CREATE_NO_WINDOW | _DETACHED_PROCESS,
        cwd=str(INSTALL_DIR),
    )


def run_hardware_tests() -> dict:
    """Run the hardware test harness and return results."""
    try:
        harness_path = Path(__file__).parent / "hw_test_harness.py"
        if not harness_path.exists():
            if getattr(sys, "frozen", False):
                harness_path = Path(sys.executable).parent / "hw_test_harness.py"
        if not harness_path.exists():
            return {"error": "hw_test_harness.py not found"}

        results = {}
        for test_name in ["encrypt", "lock-screen", "guardian"]:
            try:
                proc = subprocess.run(
                    [sys.executable, str(harness_path), "--only", test_name],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                results[test_name] = {
                    "status": "PASS" if proc.returncode == 0 else "FAIL",
                    "stdout": proc.stdout[-500:] if proc.stdout else "",
                    "stderr": proc.stderr[-500:] if proc.stderr else "",
                }
            except subprocess.TimeoutExpired:
                results[test_name] = {"status": "TIMEOUT", "stdout": "", "stderr": ""}
            except (OSError, subprocess.SubprocessError) as e:
                results[test_name] = {"status": "ERROR", "stdout": "", "stderr": str(e)}
        return results
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# GUI Wizard
# ---------------------------------------------------------------------------


class SetupWizard:
    """Multi-page wizard GUI built with tkinter."""

    # Wizard pages
    PAGE_WELCOME = 0
    PAGE_TOKEN = 1
    PAGE_HARDWARE = 2
    PAGE_INSTALLING = 3
    PAGE_TEST = 4
    PAGE_COMPLETE = 5
    PAGE_ERROR = 6

    def __init__(self, initial_server_url: str | None = None):
        self.root = tk.Tk()
        self.root.title("Remote Lockdown System — Setup Wizard")
        self.root.geometry("640x520")
        self.root.resizable(False, False)

        # Style
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TLabel", font=("Segoe UI", 10))
        style.configure("Title.TLabel", font=("Segoe UI", 16, "bold"))
        style.configure("Subtitle.TLabel", font=("Segoe UI", 11))
        style.configure("Info.TLabel", font=("Consolas", 9))
        style.configure("TButton", font=("Segoe UI", 10), padding=8)
        style.configure("Accent.TButton", font=("Segoe UI", 10, "bold"), padding=10)

        # State
        self.current_page = self.PAGE_WELCOME
        self.token = tk.StringVar()
        self.server_url = tk.StringVar(value=initial_server_url or DEFAULT_SERVER_URL)
        self.owner_name = tk.StringVar(value="Hardware Test")
        self.hostname = tk.StringVar(value=get_hostname())
        self.hardware_uuid = ""
        self.serial_number = ""
        self.mac_address = ""
        self.boot_lock = tk.BooleanVar(value=False)  # Default OFF (user opted out of BIOS)
        self.run_tests = tk.BooleanVar(value=True)
        self.install_result = {}  # enrollment + install results
        self.test_results = {}

        # Container
        self.container = ttk.Frame(self.root, padding=20)
        self.container.pack(fill="both", expand=True)

        # Footer with navigation buttons
        self.footer = ttk.Frame(self.root)
        self.footer.pack(fill="x", side="bottom", padx=20, pady=10)
        self.back_btn = ttk.Button(
            self.footer, text="← Back", command=self.go_back, state="disabled"
        )
        self.back_btn.pack(side="left")
        self.next_btn = ttk.Button(
            self.footer, text="Next →", command=self.go_next, style="Accent.TButton"
        )
        self.next_btn.pack(side="right")
        self.cancel_btn = ttk.Button(self.footer, text="Cancel", command=self.root.quit)
        self.cancel_btn.pack(side="right", padx=5)

        self.show_page(self.PAGE_WELCOME)

    def show_page(self, page: int):
        for child in self.container.winfo_children():
            child.destroy()

        self.current_page = page

        if page == self.PAGE_WELCOME:
            self._page_welcome()
        elif page == self.PAGE_TOKEN:
            self._page_token()
        elif page == self.PAGE_HARDWARE:
            self._page_hardware()
        elif page == self.PAGE_INSTALLING:
            self._page_installing()
        elif page == self.PAGE_TEST:
            self._page_test()
        elif page == self.PAGE_COMPLETE:
            self._page_complete()
        elif page == self.PAGE_ERROR:
            self._page_error()

        self._update_nav_buttons()

    def _update_nav_buttons(self):
        page = self.current_page
        self.back_btn.config(
            state="normal" if page in (self.PAGE_TOKEN, self.PAGE_HARDWARE) else "disabled"
        )
        self.next_btn.config(
            state="normal"
            if page in (self.PAGE_WELCOME, self.PAGE_TOKEN, self.PAGE_HARDWARE, self.PAGE_TEST)
            else "disabled"
        )
        if page == self.PAGE_WELCOME:
            self.next_btn.config(text="Get Started →")
        elif page == self.PAGE_TOKEN:
            self.next_btn.config(text="Next →")
        elif page == self.PAGE_HARDWARE:
            self.next_btn.config(text="Install →")
        elif page == self.PAGE_INSTALLING:
            self.next_btn.config(text="...", state="disabled")
        elif page == self.PAGE_TEST:
            self.next_btn.config(text="Finish →")
        elif page == self.PAGE_COMPLETE:
            self.next_btn.config(text="Done", state="normal")
        elif page == self.PAGE_ERROR:
            self.next_btn.config(text="Retry", state="normal")

    def _page_welcome(self):
        ttk.Label(self.container, text="Remote Lockdown System", style="Title.TLabel").pack(
            pady=(40, 5)
        )
        ttk.Label(self.container, text="Setup Wizard", style="Subtitle.TLabel").pack(pady=(0, 30))

        ttk.Label(
            self.container,
            text=(
                "This wizard will:\n"
                "  •  Enroll this device with the lockdown server\n"
                "  •  Collect hardware identifiers (serial, UUID, MAC)\n"
                "  •  Install the background agent service\n"
                "  •  Optionally run hardware self-tests\n\n"
                "You will need:\n"
                "  •  An enrollment token (from the admin dashboard)\n"
                "  •  Administrator privileges"
            ),
            justify="left",
        ).pack(pady=10)

        # Admin status indicator
        admin_frame = ttk.Frame(self.container)
        admin_frame.pack(pady=20)
        if is_admin():
            ttk.Label(admin_frame, text="✓ Running as Administrator", foreground="green").pack()
        else:
            ttk.Label(
                admin_frame, text="⚠ Administrator privileges required", foreground="red"
            ).pack()
            ttk.Label(
                admin_frame,
                text="The wizard will auto-elevate when you click Get Started.",
                font=("Segoe UI", 9),
            ).pack()

    def _page_token(self):
        ttk.Label(self.container, text="Enrollment Configuration", style="Title.TLabel").pack(
            pady=(10, 20)
        )

        form = ttk.Frame(self.container)
        form.pack(fill="x", padx=40)

        ttk.Label(form, text="Enrollment Token:").grid(row=0, column=0, sticky="w", pady=8)
        token_entry = ttk.Entry(form, textvariable=self.token, width=50, show="•")
        token_entry.grid(row=0, column=1, pady=8, padx=10)
        ttk.Label(
            form, text="(from the admin dashboard — valid for 15 min)", font=("Segoe UI", 8)
        ).grid(row=1, column=1, sticky="w")

        ttk.Label(form, text="Server URL:").grid(row=2, column=0, sticky="w", pady=8)
        ttk.Entry(form, textvariable=self.server_url, width=50).grid(
            row=2, column=1, pady=8, padx=10
        )

        ttk.Label(form, text="Owner Name:").grid(row=3, column=0, sticky="w", pady=8)
        ttk.Entry(form, textvariable=self.owner_name, width=50).grid(
            row=3, column=1, pady=8, padx=10
        )

        ttk.Label(form, text="Hostname:").grid(row=4, column=0, sticky="w", pady=8)
        ttk.Entry(form, textvariable=self.hostname, width=50).grid(row=4, column=1, pady=8, padx=10)

        # Boot lock checkbox
        ttk.Checkbutton(
            form, text="Enable boot lockdown (BCD + BIOS)", variable=self.boot_lock
        ).grid(row=5, column=1, sticky="w", pady=8)
        ttk.Label(
            form,
            text="⚠ Modifies boot settings — only enable if you have a recovery plan",
            font=("Segoe UI", 8),
            foreground="orange",
        ).grid(row=6, column=1, sticky="w")

    def _page_hardware(self):
        ttk.Label(self.container, text="Hardware Identity", style="Title.TLabel").pack(
            pady=(10, 10)
        )
        ttk.Label(
            self.container,
            text=(
                "These identifiers are sent to the server and used to identify\n"
                "this physical machine — even if the hostname is changed."
            ),
            justify="left",
        ).pack(pady=(0, 20))

        # Collect hardware IDs now (in main thread)
        self.hardware_uuid = get_hardware_uuid() or "N/A"
        self.serial_number = get_serial_number() or "N/A"
        self.mac_address = get_mac_address() or "N/A"

        info_frame = ttk.Frame(self.container)
        info_frame.pack(fill="x", padx=40)

        rows = [
            ("Hostname:", self.hostname.get()),
            ("Serial Number:", self.serial_number),
            ("Hardware UUID:", self.hardware_uuid),
            ("MAC Address:", self.mac_address),
        ]
        for i, (label, value) in enumerate(rows):
            ttk.Label(info_frame, text=label, font=("Segoe UI", 10, "bold")).grid(
                row=i, column=0, sticky="w", pady=6
            )
            ttk.Label(info_frame, text=value, style="Info.TLabel").grid(
                row=i, column=1, sticky="w", pady=6, padx=10
            )

        # Test checkbox
        test_frame = ttk.Frame(self.container)
        test_frame.pack(fill="x", padx=40, pady=20)
        ttk.Checkbutton(
            test_frame, text="Run hardware self-tests after installation", variable=self.run_tests
        ).pack(anchor="w")
        ttk.Label(
            test_frame,
            text="Tests: file encryption, screen lock, lock guardian\n"
            "(screen will lock briefly during testing)",
            font=("Segoe UI", 8),
        ).pack(anchor="w", padx=20)

    def _page_installing(self):
        ttk.Label(self.container, text="Installing...", style="Title.TLabel").pack(pady=(10, 20))

        self.install_progress = ttk.Progressbar(self.container, mode="determinate", length=400)
        self.install_progress.pack(pady=10)
        self.install_progress["maximum"] = 100

        self.install_status = ttk.Label(self.container, text="Starting...", font=("Segoe UI", 10))
        self.install_status.pack(pady=10)

        self.install_log = tk.Text(
            self.container,
            height=12,
            width=70,
            font=("Consolas", 8),
            state="disabled",
            bg="#1e1e1e",
            fg="#cccccc",
        )
        self.install_log.pack(pady=10)

        # Start installation in background thread
        threading.Thread(target=self._do_install, daemon=True).start()

    def _log(self, msg: str):
        self.install_log.config(state="normal")
        self.install_log.insert("end", msg + "\n")
        self.install_log.see("end")
        self.install_log.config(state="disabled")

    def _set_status(self, msg: str, progress: int | None = None):
        self.install_status.config(text=msg)
        if progress is not None:
            self.install_progress["value"] = progress

    def _do_install(self):
        try:
            steps = [
                ("Checking admin privileges...", 5),
                ("Finding agent binary...", 10),
                ("Enrolling device with server...", 30),
                ("Writing configuration...", 45),
                ("Installing agent files...", 60),
                ("Creating lockdown folder...", 70),
                ("Installing service (scheduled task)...", 85),
                ("Launching agent...", 95),
            ]

            for msg, progress in steps:
                self.root.after(0, self._set_status, msg, progress)
                self.root.after(0, self._log, f"[{progress}%] {msg}")

                if "Enrolling" in msg:
                    # Actual enrollment
                    # The field has no default on purpose (S213): prefilling a
                    # backend silently sent enrollments to a server that had never
                    # issued the operator's token. Fail here, with what to type,
                    # rather than at the network call.
                    if not self.server_url.get().strip():
                        raise Exception(
                            "No server URL set. Enter the address of your server "
                            "(for example http://192.168.1.20:3001) and try again."
                        )
                    if not self.token.get():
                        raise Exception("No enrollment token provided")
                    data = enroll_device_with_token(
                        self.server_url.get(),
                        self.token.get(),
                        self.hostname.get(),
                        self.owner_name.get(),
                        self.hardware_uuid if self.hardware_uuid != "N/A" else None,
                        self.mac_address if self.mac_address != "N/A" else None,
                        self.serial_number if self.serial_number != "N/A" else None,
                    )
                    # Validate enrollment response before using it
                    if not isinstance(data, dict):
                        raise Exception(
                            f"Invalid enrollment response: expected dict, got {type(data).__name__}"
                        )
                    if not data.get("api_key"):
                        raise Exception("Enrollment response missing api_key")
                    if not data.get("device") or not data["device"].get("id"):
                        raise Exception("Enrollment response missing device.id")
                    self.install_result = data
                    self.root.after(0, self._log, f"  Device ID: {data['device']['id']}")
                    self.root.after(
                        0, self._log, f"  Reassociated: {data.get('reassociated', False)}"
                    )

                elif "Writing config" in msg:
                    pinned = install_update_public_key()
                    write_config(
                        self.server_url.get(),
                        self.install_result["api_key"],
                        self.hostname.get(),
                        self.install_result["device"]["id"],
                        boot_lock_enabled=self.boot_lock.get(),
                        update_public_key=pinned,
                    )
                    self.root.after(0, self._log, f"  Config: {CONFIG_FILE}")
                    self.root.after(
                        0,
                        self._log,
                        f"  Update key: {pinned}"
                        if pinned
                        else "  Update key: none staged (updates are SHA-256 only)",
                    )

                elif "Installing agent" in msg:
                    # Add Defender exclusions first — PyInstaller exes
                    # often trigger false positives. This must happen
                    # BEFORE the agent binary is placed in the install dir.
                    self.root.after(0, self._log, "  Adding Defender exclusions...")
                    add_defender_exclusions()
                    self.root.after(0, self._log, "  Exclusions added")

                    # First try to find the agent exe locally (bundled or
                    # placed next to the installer). If not found, download
                    # it from the Worker.
                    agent_exe = find_agent_exe()
                    if not agent_exe:
                        self.root.after(
                            0, self._log, "  Agent not found locally, downloading from server..."
                        )
                        agent_exe = download_agent_exe(self.server_url.get(), INSTALL_DIR)
                        if not agent_exe:
                            raise Exception(
                                f"Cannot find or download {AGENT_EXE_NAME}. "
                                "Check your network connection and server URL."
                            )
                        self.root.after(0, self._log, f"  Downloaded: {agent_exe}")
                    dest = install_files(agent_exe)
                    self.root.after(0, self._log, f"  Agent: {dest}")

                    # Download and install the lock screen overlay
                    self.root.after(0, self._log, "  Downloading lock screen overlay...")
                    lockscreen = download_lockscreen_exe(self.server_url.get(), INSTALL_DIR)
                    if lockscreen:
                        self.root.after(0, self._log, f"  Lock screen: {lockscreen}")
                    else:
                        self.root.after(
                            0,
                            self._log,
                            "  Lock screen not available — will fall back to LockWorkStation",
                        )

                elif "Creating lockdown" in msg:
                    create_lockdown_folder()
                    self.root.after(0, self._log, f"  Folder: {LOCKDOWN_FOLDER}")

                elif "Installing service" in msg:
                    success, svc_msg = install_service()
                    self.root.after(
                        0,
                        self._log,
                        f"  Service: {svc_msg}",
                    )

                elif "Launching" in msg:
                    dest = INSTALL_DIR / AGENT_EXE_NAME
                    if dest.exists():
                        launch_agent(dest)
                        self.root.after(0, self._log, "  Agent started in background")
                    else:
                        self.root.after(0, self._log, "  Agent not found — skipping launch")

                time.sleep(0.3)  # Visual pacing

            self.root.after(0, self._set_status, "Installation complete!", 100)
            self.root.after(0, self._log, "\n✓ Installation complete!")

            # Move to test page or complete page
            if self.run_tests.get():
                self.root.after(500, self.show_page, self.PAGE_TEST)
            else:
                self.root.after(500, self.show_page, self.PAGE_COMPLETE)

        except Exception as e:  # noqa: BLE001 — GUI install thread catch-all for user-facing error display
            self.root.after(0, self._set_status, f"Error: {e}", None)
            self.root.after(0, self._log, f"\n✗ ERROR: {e}")
            self.install_error = str(e)
            self.root.after(500, self.show_page, self.PAGE_ERROR)

    def _page_test(self):
        ttk.Label(self.container, text="Hardware Self-Test", style="Title.TLabel").pack(
            pady=(10, 10)
        )
        ttk.Label(
            self.container,
            text=(
                "Running non-destructive hardware tests...\n"
                "Your screen may lock briefly during the lock-screen test."
            ),
            justify="left",
        ).pack(pady=(0, 15))

        self.test_progress = ttk.Progressbar(self.container, mode="determinate", length=400)
        self.test_progress.pack(pady=5)
        self.test_progress["maximum"] = 100

        self.test_status = ttk.Label(self.container, text="Starting tests...")
        self.test_status.pack(pady=5)

        self.test_log = tk.Text(
            self.container,
            height=14,
            width=70,
            font=("Consolas", 8),
            state="disabled",
            bg="#1e1e1e",
            fg="#cccccc",
        )
        self.test_log.pack(pady=10)

        threading.Thread(target=self._do_tests, daemon=True).start()

    def _test_log(self, msg: str):
        self.test_log.config(state="normal")
        self.test_log.insert("end", msg + "\n")
        self.test_log.see("end")
        self.test_log.config(state="disabled")

    def _do_tests(self):
        tests = [
            ("encrypt", "File encryption roundtrip (E-ENCRYPT)...", 33),
            ("lock-screen", "Screen lock test (E-LOCK-SCREEN)...", 66),
            ("guardian", "Lock guardian test (E-GUARDIAN)...", 100),
        ]
        all_pass = True
        for test_name, label, progress in tests:
            self.root.after(0, self.test_status.config, {"text": label})
            self.root.after(0, self.test_progress.config, {"value": progress})
            self.root.after(0, self._test_log, f"\n[{progress}%] {label}")

            result = run_hardware_tests()
            if "error" in result:
                self.root.after(0, self._test_log, f"  ERROR: {result['error']}")
                all_pass = False
                break

            test_result = result.get(test_name, {"status": "SKIP"})
            status = test_result.get("status", "UNKNOWN")
            self.root.after(0, self._test_log, f"  Result: {status}")
            if status != "PASS":
                all_pass = False
                if test_result.get("stderr"):
                    self.root.after(0, self._test_log, f"  stderr: {test_result['stderr'][:200]}")

            time.sleep(0.5)

        self.test_results = {"all_pass": all_pass}
        self.root.after(
            0,
            self.test_status.config,
            {"text": "Tests complete!" if all_pass else "Some tests failed — see log"},
        )
        if all_pass:
            self.root.after(0, self._test_log, "\n✓ All tests passed!")
        else:
            self.root.after(
                0,
                self._test_log,
                "\n⚠ Some tests failed — check the log above.",
            )
        self.root.after(0, self._update_nav_buttons)

    def _page_complete(self):
        ttk.Label(
            self.container, text="✓ Installation Complete", style="Title.TLabel", foreground="green"
        ).pack(pady=(30, 20))

        info_frame = ttk.Frame(self.container)
        info_frame.pack(fill="x", padx=40)

        dev = self.install_result.get("device", {})
        rows = [
            ("Device ID:", dev.get("id", "N/A")),
            ("Hostname:", dev.get("hostname", self.hostname.get())),
            ("Serial Number:", self.serial_number),
            ("Hardware UUID:", self.hardware_uuid),
            ("MAC Address:", self.mac_address),
            ("Config File:", str(CONFIG_FILE)),
            ("Install Dir:", str(INSTALL_DIR)),
        ]
        for i, (label, value) in enumerate(rows):
            ttk.Label(info_frame, text=label, font=("Segoe UI", 10, "bold")).grid(
                row=i, column=0, sticky="w", pady=4
            )
            ttk.Label(info_frame, text=value, style="Info.TLabel").grid(
                row=i, column=1, sticky="w", pady=4, padx=10
            )

        if self.test_results:
            ttk.Label(info_frame, text="Self-Test:", font=("Segoe UI", 10, "bold")).grid(
                row=len(rows), column=0, sticky="w", pady=4
            )
            test_text = "All passed ✓" if self.test_results.get("all_pass") else "Some failed ⚠"
            color = "green" if self.test_results.get("all_pass") else "orange"
            ttk.Label(info_frame, text=test_text, foreground=color).grid(
                row=len(rows), column=1, sticky="w", pady=4, padx=10
            )

        ttk.Label(
            self.container,
            text=(
                "\nThe agent is now running in the background and will\n"
                "auto-restart if killed. You can manage this device from\n"
                "the admin dashboard."
            ),
            justify="left",
        ).pack(pady=20)

    def _page_error(self):
        ttk.Label(
            self.container, text="✗ Installation Failed", style="Title.TLabel", foreground="red"
        ).pack(pady=(40, 20))
        ttk.Label(
            self.container,
            text=self.install_error if hasattr(self, "install_error") else "Unknown error",
            font=("Segoe UI", 10),
            wraplength=500,
        ).pack(pady=10)
        ttk.Label(
            self.container,
            text="Click Retry to try again, or Cancel to exit.",
            font=("Segoe UI", 9),
        ).pack(pady=20)

    def go_next(self):
        page = self.current_page
        if page == self.PAGE_WELCOME:
            if not is_admin():
                relaunch_as_admin()
                return
            self.show_page(self.PAGE_TOKEN)
        elif page == self.PAGE_TOKEN:
            if not self.token.get().strip():
                messagebox.showwarning("Missing Token", "Please enter the enrollment token.")
                return
            self.show_page(self.PAGE_HARDWARE)
        elif page == self.PAGE_HARDWARE:
            self.show_page(self.PAGE_INSTALLING)
        elif page == self.PAGE_TEST:
            self.show_page(self.PAGE_COMPLETE)
        elif page == self.PAGE_COMPLETE:
            self.root.quit()
        elif page == self.PAGE_ERROR:
            self.show_page(self.PAGE_TOKEN)

    def go_back(self):
        page = self.current_page
        if page == self.PAGE_TOKEN:
            self.show_page(self.PAGE_WELCOME)
        elif page == self.PAGE_HARDWARE:
            self.show_page(self.PAGE_TOKEN)

    def run(self):
        self.root.mainloop()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def build_parser():
    """CLI surface for the wizard.

    Exists so one PowerShell command can drive the whole install: download the
    wizard, then run `--server-url <url> --token <token> --silent`. Without it the
    operator has to launch a GUI and hand-type the server address — which is how a
    mistyped tailnet hostname (`desktop-q4pcdhk.ta?06a7e9`) turned into a
    "cannot resolve" failure (S214).
    """
    import argparse

    parser = argparse.ArgumentParser(
        description="Lockdown Agent setup wizard (omit flags for the GUI)"
    )
    parser.add_argument("--server-url", help="server base URL, e.g. https://lockdown.example.com")
    parser.add_argument("--token", help="enrollment token (single use, 15 minutes)")
    parser.add_argument("--hostname", help="hostname to report (default: this machine)")
    parser.add_argument(
        "--owner", default="Auto-enrolled", help="owner name recorded on the device"
    )
    parser.add_argument("--no-boot-lock", action="store_true", help="do not enable boot lockdown")
    parser.add_argument(
        "--silent",
        action="store_true",
        help="install without the GUI (requires --server-url and --token)",
    )
    return parser


def run_headless(
    server_url: str,
    token: str,
    hostname: str,
    owner_name: str = "Auto-enrolled",
    boot_lock: bool = True,
) -> int:
    """The wizard's install sequence without tkinter.

    Calls exactly the primitives the GUI calls, in the same order — one
    implementation of each step, so the two entry points cannot drift. Returns a
    process exit code.
    """
    try:
        print(f"[1/6] Enrolling {hostname} with {server_url} ...")
        data = enroll_device_with_token(
            server_url,
            token,
            hostname,
            owner_name,
            None,  # hardware_uuid: collected by enroll_device_with_token
            None,
            None,
        )
        api_key = data["api_key"]
        print(
            f"      device_id={data['device']['id']} reassociated={data.get('reassociated', False)}"
        )

        print("[2/6] Writing configuration ...")
        write_config(
            server_url,
            api_key,
            hostname,
            data["device"]["id"],
            boot_lock_enabled=boot_lock,
            update_public_key=staged_update_public_key(),
        )

        print("[3/6] Adding Defender exclusions ...")
        add_defender_exclusions()

        print("[4/6] Installing the agent binary ...")
        agent_exe = find_agent_exe() or download_agent_exe(server_url, INSTALL_DIR)
        if not agent_exe:
            raise Exception(
                f"agent binary unavailable from {server_url}/api/download/agent?platform=win"
            )
        installed = install_files(agent_exe)

        print("[5/6] Creating lockdown folder and service ...")
        create_lockdown_folder()
        ok, message = install_service()
        if not ok:
            raise Exception(f"service install failed: {message}")

        print("[6/6] Starting the agent ...")
        launch_agent(installed)
        print("OK: installed")
        return 0
    except Exception as exc:  # the operator gets one line, not a traceback
        print(f"FAILED: {exc}")
        return 1


def main(argv: list[str] | None = None):
    args = build_parser().parse_args(argv)

    if platform.system() != "Windows":
        print("This installer is for Windows only.")
        sys.exit(1)

    if args.silent:
        if not args.server_url or not args.token:
            print("--silent requires --server-url and --token", file=sys.stderr)
            sys.exit(2)
        sys.exit(
            run_headless(
                args.server_url,
                args.token,
                args.hostname or get_hostname(),
                args.owner,
                boot_lock=not args.no_boot_lock,
            )
        )

    if not TKINTER_AVAILABLE:
        print("tkinter is not available. Install it with: pip install tk")
        sys.exit(1)

    # Check for admin — if not admin, the wizard will offer to relaunch
    # (relaunch happens when the user clicks "Get Started" on the welcome page)
    app = SetupWizard(initial_server_url=args.server_url)
    app.run()


if __name__ == "__main__":
    main()
