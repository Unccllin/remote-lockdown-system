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

import requests

# Tkinter is Windows-only (the GUI runs on the target Windows machine).
# Import lazily so the non-GUI functions (hardware ID collection, enrollment,
# config writing) can be tested on Linux without tkinter installed.
try:
    import tkinter as tk
    from tkinter import messagebox, ttk

    TKINTER_AVAILABLE = True
except ImportError:
    TKINTER_AVAILABLE = False
    tk = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Constants — shared with installer.py
# ---------------------------------------------------------------------------

DEFAULT_SERVER_URL = "https://lockdown-serverless.mainacollins196.workers.dev"
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
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except (OSError, AttributeError, PermissionError):
        return False


def relaunch_as_admin():
    """Re-launch the current executable with UAC elevation."""
    params = " ".join(f'"{a}"' for a in sys.argv[1:])
    ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, None, 1)
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
        raise Exception("Enrollment token rejected — it may be invalid or already used.")
    if resp.status_code != 201:
        raise Exception(f"Enrollment failed (HTTP {resp.status_code}): {resp.text}")
    return resp.json()


def write_config(
    server_url: str, api_key: str, hostname: str, device_id: str, boot_lock_enabled: bool = True
) -> Path:
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
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2))
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


def download_agent_exe(server_url: str, dest_dir: Path) -> Path | None:
    """Download the agent binary from the Worker (GET /api/download/agent).

    This is used when the agent exe is not bundled with the installer.
    The binary is stored in Cloudflare KV and served by the Worker.
    """
    url = f"{server_url.rstrip('/')}/api/download/agent"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / AGENT_EXE_NAME
    try:
        resp = requests.get(url, timeout=120, verify=True, stream=True)
        if resp.status_code != 200:
            return None
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
        return dest if dest.exists() and dest.stat().st_size > 1000000 else None
    except (requests.RequestException, OSError):
        if dest.exists():
            dest.unlink()
        return None


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


def install_service() -> bool:
    try:
        import service_installer

        return service_installer.install()
    except ImportError:
        return False
    except (subprocess.SubprocessError, OSError, RuntimeError):
        return False


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
        creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
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

    def __init__(self):
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
        self.server_url = tk.StringVar(value=DEFAULT_SERVER_URL)
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
                    self.install_result = data
                    self.root.after(0, self._log, f"  Device ID: {data['device']['id']}")
                    self.root.after(
                        0, self._log, f"  Reassociated: {data.get('reassociated', False)}"
                    )

                elif "Writing config" in msg:
                    write_config(
                        self.server_url.get(),
                        self.install_result["api_key"],
                        self.hostname.get(),
                        self.install_result["device"]["id"],
                        boot_lock_enabled=self.boot_lock.get(),
                    )
                    self.root.after(0, self._log, f"  Config: {CONFIG_FILE}")

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

                elif "Creating lockdown" in msg:
                    create_lockdown_folder()
                    self.root.after(0, self._log, f"  Folder: {LOCKDOWN_FOLDER}")

                elif "Installing service" in msg:
                    success = install_service()
                    self.root.after(
                        0,
                        self._log,
                        f"  Service: {'installed' if success else 'skipped (module not found)'}",
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


def main():
    if platform.system() != "Windows":
        print("This installer is for Windows only.")
        sys.exit(1)

    if not TKINTER_AVAILABLE:
        print("tkinter is not available. Install it with: pip install tk")
        sys.exit(1)

    # Check for admin — if not admin, the wizard will offer to relaunch
    # (relaunch happens when the user clicks "Get Started" on the welcome page)
    app = SetupWizard()
    app.run()


if __name__ == "__main__":
    main()
