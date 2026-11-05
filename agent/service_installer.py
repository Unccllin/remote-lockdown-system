"""
Windows Service / Scheduled Task Installer
-------------------------------------------
Installs the agent as a persistent background process that auto-restarts
when killed. Two mechanisms work together:

1. **Scheduled task watchdog** — runs every 5 minutes, checks if the agent
   is running, and re-launches it if not. Also runs at system startup.
   This is the primary persistence mechanism.

2. **Registry run key** — a backup that launches the agent at user logon.
   This is a secondary mechanism in case the scheduled task is disabled.

The scheduled task runs with SYSTEM privileges (requires admin to install)
and is hidden from non-admin users. The task name is innocuous
("SystemHealthMonitor") to avoid drawing attention.

Usage:
    python service_installer.py install    # Install the watchdog
    python service_installer.py uninstall  # Remove the watchdog
    python service_installer.py status     # Check if installed

Requirements:
    - Windows (uses schtasks.exe and reg.exe)
    - Admin privileges (for schtasks /create with SYSTEM account)
"""

import logging
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

log = logging.getLogger("lockdown-agent")

# CREATE_NO_WINDOW exists only on Windows. getattr keeps the reference valid (and
# statically resolvable) when this module is imported on another platform.
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Tamper protection — applied after service install to harden against deletion
try:
    from tamper_protection import apply_all_protection, remove_all_protection

    _HAS_TAMPER_PROTECTION = True
except ImportError:
    _HAS_TAMPER_PROTECTION = False

    # Define the names in the failure branch too. Every call site is already guarded
    # by _HAS_TAMPER_PROTECTION, but leaving them unbound means the guard is the only
    # thing between a missing module and a NameError — invisible to static analysis
    # and easy to break by editing one call site.
    # Same return shape as the real functions (dict), so call sites such as
    # `remove_all_protection(...).get("protection_removed")` stay type-correct.
    def apply_all_protection(*_args: object, **_kwargs: object) -> dict:
        return {}

    def remove_all_protection(*_args: object, **_kwargs: object) -> dict:
        return {}


# Task name — innocuous to avoid drawing attention
TASK_NAME = "SystemHealthMonitor"
TASK_DESCRIPTION = "Monitors system health and performance metrics"

# Registry run key (backup persistence)
REG_RUN_KEY = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run"
REG_VALUE_NAME = "SystemHealthMonitor"


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _is_admin() -> bool:
    """Check if running with admin privileges."""
    if not _is_windows():
        return False
    try:
        result = subprocess.run(["net", "session"], capture_output=True, text=True, timeout=5)
        return result.returncode == 0
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        return False


def _get_agent_path() -> Path:
    """Get the path to the agent executable or script."""
    if getattr(sys, "frozen", False):
        # PyInstaller bundle — the installer exe is NOT the agent.
        # Look for lockdown-agent.exe in the same directory, then in
        # the standard install location. Fall back to sys.executable
        # only for backward compat (when the agent exe IS frozen).
        exe_dir = Path(sys.executable).parent
        candidates = [
            exe_dir / "lockdown-agent.exe",
            exe_dir / "lockdown-agent",
            Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData"))
            / "LockdownAgent"
            / "lockdown-agent.exe",
        ]
        for c in candidates:
            if c.exists():
                return c
        # Last resort: assume this exe IS the agent (backward compat)
        return Path(sys.executable)
    # Running as a Python script — use the agent.py path
    return Path(__file__).parent / "agent.py"


def _get_python_path() -> str | None:
    """Get the Python executable path for running the agent script."""
    if getattr(sys, "frozen", False):
        return None  # Not needed — the exe is self-contained
    return sys.executable


def _get_config_path() -> Path | None:
    """Find the config file the agent should use."""
    # When frozen with PyInstaller, __file__ points to a temp dir.
    # Use the exe's directory instead.
    if getattr(sys, "frozen", False):
        base_dir = Path(sys.executable).parent
    else:
        base_dir = Path(__file__).parent
    candidates = [
        base_dir / "config.json",
        base_dir / "config.ini",
        Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent" / "config.json",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def _agent_running() -> bool:
    """True when a lockdown-agent process already exists.

    The install-time launch and the scheduled task both start the agent, so a
    machine can end up with two (S216: pids 7540 and 22316 at once). The watchdog
    already refuses to start a second one; this is the same guard for install time.
    """
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq lockdown-agent.exe", "/NH"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return False
    return "lockdown-agent.exe" in (result.stdout or "").lower()


def _install_dir() -> Path:
    """Where the agent, config and watchdog script live on the target."""
    return Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "LockdownAgent"


def _ps_quote(value: str) -> str:
    """Single-quote a PowerShell literal (doubling any single quote)."""
    return "'" + value.replace("'", "''") + "'"


def _agent_launch_parts() -> tuple[str, list[str]]:
    """(executable, arguments) for the agent, preferring the INSTALLED binary.

    Running the installer from source left `sys.frozen` False, so the scheduled task
    was written with the *source* path (``...\\agent.py``) — which does not exist on
    the target. The task then reported success (exit 0) and started nothing, and the
    agent never came up (S216, FRANKENSTEIN).
    """
    installed = _install_dir() / "lockdown-agent.exe"

    if installed.exists():
        exe, args = str(installed), ["--silent"]
    elif getattr(sys, "frozen", False):
        exe, args = str(_get_agent_path()), ["--silent"]
    else:
        exe, args = _get_python_path(), [str(_get_agent_path()), "--silent"]

    config_path = _get_config_path()
    if config_path:
        args += ["--config", str(config_path)]

    return exe, args


def _build_agent_command() -> str:
    """The agent command as one string (for logs and the registry Run key)."""
    exe, args = _agent_launch_parts()
    parts = [exe, *args]
    return " ".join(f'"{p}"' if " " in p else p for p in parts)


def _build_watchdog_command() -> str:
    """Build the watchdog PowerShell command that checks and restarts the agent."""
    exe, args = _agent_launch_parts()

    # PowerShell script that:
    # 1. Checks if the agent process is running
    # 2. If not, launches it
    # 3. Runs silently (no window)
    # Start-Process on the executable directly. Going through `cmd /c "C:\Program
    # Files\..."` mangles quoted paths containing spaces.
    launch = ", ".join(_ps_quote(p) for p in args)
    ps_script = f"""
$ErrorActionPreference = 'SilentlyContinue'
$agentProcess = Get-Process -Name 'lockdown-agent' -ErrorAction SilentlyContinue
if (-not $agentProcess) {{
    # Also check for python running agent.py
    $pythonProcs = Get-WmiObject Win32_Process `
        -Filter "Name='python.exe' OR Name='python3.exe'" `
        | Where-Object {{ $_.CommandLine -like '*agent.py*' }}
    if (-not $pythonProcs) {{
        Start-Process -FilePath {_ps_quote(exe)} `
            -ArgumentList @({launch}) `
            -WindowStyle Hidden
    }}
}}
""".strip()

    # The script goes in a FILE and the task points at it. schtasks caps the /TR
    # action at 261 characters, and an inline -EncodedCommand (base64 of this script)
    # blows past that as soon as the agent path is long — which is exactly what
    # happened on a machine whose Python lives in "C:\Program Files\Python312":
    #   ERROR: Value for '/TR' option cannot be more than 261 character(s)  (S216)
    try:
        state_dir = _install_dir()
        state_dir.mkdir(parents=True, exist_ok=True)
        script_path = state_dir / "watchdog-task.ps1"
        # utf-8-sig: Windows PowerShell 5.1 misreads BOM-less UTF-8 in some locales.
        script_path.write_text(ps_script, encoding="utf-8-sig")
        return f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{script_path}"'
    except OSError as exc:
        # Falling back is better than refusing to install, but the caller should know
        # the action may exceed the limit.
        log.warning("Could not write the watchdog script (%s) — using -EncodedCommand", exc)
        import base64

        encoded = base64.b64encode(ps_script.encode("utf-16LE")).decode("ascii")
        return f"powershell.exe -NoProfile -EncodedCommand {encoded}"


SERVICE_NAME = "LockdownAgent"
SERVICE_DISPLAY_NAME = "Lockdown Agent"
SERVICE_DESCRIPTION = "Remote lockdown agent (device policy, EFS, tracking, recovery)."


def _service_bin_path() -> str:
    """Command line the SCM should run.

    A frozen service build (`lockdown-service.exe`) is preferred. Otherwise the
    service runs this interpreter with service_host.py from the install directory —
    that path is what the lab/test machines use, and what produced the first
    successful unattended start (S220).
    """
    service_exe = _install_dir() / "lockdown-service.exe"
    if service_exe.exists():
        return f'"{service_exe}"'
    # --service makes the host bootstrap the SCM dispatcher; without it the SCM
    # starts the process and immediately reports it stopped.
    return f'"{sys.executable}" "{_install_dir() / "service_host.py"}" --service'


def _copy_service_host() -> bool:
    """Put service_host.py where the SCM command line can find it."""
    src = Path(__file__).with_name("service_host.py")
    if not src.exists():
        return False
    dest = _install_dir() / "service_host.py"
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    except OSError as exc:
        log.error("Could not stage service_host.py: %s", exc)
        return False
    return True


def _sc(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["sc.exe", *args], capture_output=True, text=True)


def install_service() -> bool:
    """Create, configure and start the agent as a Windows service.

    Runs as LocalSystem at boot, with no logon and no Task Scheduler involved — the
    two mechanisms that failed on the live machine (S218, S219).
    """
    if not _copy_service_host():
        log.error("service_host.py is missing — cannot register the service")
        return False

    bin_path = _service_bin_path()

    # Recreate rather than reconfigure: a stale binary path is the usual leftover.
    _sc("stop", SERVICE_NAME)
    _sc("delete", SERVICE_NAME)

    created = _sc(
        "create",
        SERVICE_NAME,
        "binPath=",
        bin_path,
        "start=",
        "auto",
        "obj=",
        "LocalSystem",
        "DisplayName=",
        SERVICE_DISPLAY_NAME,
    )
    if created.returncode != 0:
        log.error("sc create failed: %s", (created.stdout or created.stderr).strip())
        return False

    _sc("description", SERVICE_NAME, SERVICE_DESCRIPTION)
    # Restart on crash instead of relying on a watchdog script. reset= 86400 means the
    # failure counter clears once a day.
    _sc(
        "failure",
        SERVICE_NAME,
        "reset=",
        "86400",
        "actions=",
        "restart/5000/restart/10000/restart/30000",
    )

    started = _sc("start", SERVICE_NAME)
    if started.returncode != 0:
        log.error("sc start failed: %s", (started.stdout or started.stderr).strip())
        return False

    # sc start returns before the service reports RUNNING; believe the state, not the
    # exit code (S218: schtasks reported success while doing nothing).
    for _ in range(20):
        time.sleep(1)
        query = _sc("query", SERVICE_NAME)
        if "RUNNING" in (query.stdout or ""):
            log.info("Service '%s' is running", SERVICE_NAME)
            return True
    log.error("Service '%s' did not reach RUNNING", SERVICE_NAME)
    return False


def remove_service() -> None:
    _sc("stop", SERVICE_NAME)
    _sc("delete", SERVICE_NAME)


def install() -> bool:
    """Install the scheduled task watchdog and registry run key.

    Returns True if installation succeeded.
    """
    if not _is_windows():
        log.error("Service installer is Windows-only")
        return False

    if not _is_admin():
        log.error("Service installation requires admin privileges")
        return False

    # Check that required Windows binaries exist
    required_binaries = ["schtasks", "reg", "cmd"]
    for binary in required_binaries:
        try:
            subprocess.run(["where", binary], capture_output=True, text=True, timeout=5, check=True)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            log.error("Required binary '%s' not found on PATH", binary)
            return False

    # --- 0. Preferred: a real Windows service ---
    # Boot-time, no logon, no Task Scheduler. The task/Run key path below stays as a
    # fallback for machines where service creation is blocked by policy.
    if install_service():
        log.info("Installed as a Windows service (%s)", SERVICE_NAME)
        if _HAS_TAMPER_PROTECTION:
            log.info("Applying tamper protection (file ACLs + registry protection)...")
            try:
                apply_all_protection(
                    _install_dir() / "lockdown-agent.exe",
                    _get_config_path(),
                    _install_dir(),
                    None,
                )
            except (OSError, RuntimeError) as exc:
                log.warning("Tamper protection failed: %s", exc)
        log.info("Installation complete — the service starts at boot without a logon")
        return True

    log.warning("Service registration failed — falling back to a scheduled task + Run key")
    watchdog_cmd = _build_watchdog_command()
    agent_cmd = _build_agent_command()

    # --- 1. Create the scheduled task ---
    # Delete existing task if it exists (ignore errors — may not exist yet)
    subprocess.run(
        ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
        capture_output=True,
        text=True,
    )

    # Create the task to run at startup and every 5 minutes
    # /SC ONSTART = at system startup
    # /SC MINUTE /MO 5 = every 5 minutes
    # /RU SYSTEM = run as SYSTEM
    # /RL HIGHEST = run with highest privileges

    # Create the startup trigger — try current user first, SYSTEM as fallback
    # (SYSTEM often fails with -2147467259 on non-domain machines)

    current_user = f"{os.environ.get('USERDOMAIN', '.')}\\{os.environ.get('USERNAME', '')}"

    result = subprocess.run(
        [
            "schtasks",
            "/Create",
            "/TN",
            TASK_NAME,
            "/TR",
            watchdog_cmd,
            "/SC",
            "ONSTART",
            "/RU",
            current_user,
            "/F",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        log.warning("Failed to create task as %s: %s — trying SYSTEM", current_user, result.stderr)
        result = subprocess.run(
            [
                "schtasks",
                "/Create",
                "/TN",
                TASK_NAME,
                "/TR",
                watchdog_cmd,
                "/SC",
                "ONSTART",
                "/RU",
                "SYSTEM",
                "/RL",
                "HIGHEST",
                "/F",
            ],
            capture_output=True,
            text=True,
        )

    if result.returncode != 0:
        log.error("Failed to create startup task: %s", result.stderr)
        return False

    log.info("Scheduled task '%s' created (startup trigger)", TASK_NAME)

    # Add the recurring 5-minute trigger using PowerShell
    # (schtasks doesn't support multiple triggers in one command)
    ps_add_trigger = f"""
$task = Get-ScheduledTask -TaskName '{TASK_NAME}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 365)
$task.Triggers += $trigger
Set-ScheduledTask -TaskName '{TASK_NAME}' -Trigger $task.Triggers
""".strip()

    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_add_trigger],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        log.warning("Failed to add recurring trigger: %s", result.stderr)
        log.warning("Startup trigger is still active — agent will restart on reboot")
    else:
        log.info("Recurring 5-minute trigger added to task '%s'", TASK_NAME)

    # --- 2. Add registry run key (backup persistence) ---
    result = subprocess.run(
        [
            "reg",
            "add",
            REG_RUN_KEY,
            "/v",
            REG_VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            agent_cmd,
            "/f",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        log.warning("Failed to add registry run key: %s", result.stderr)
    else:
        log.info("Registry run key added (backup persistence)")

    # --- 3. Start the agent through the task that will keep it alive ---
    # Running the task rather than spawning the process ourselves keeps ONE start
    # mechanism: it proves the task works at install time, and the watchdog is what
    # restarts the agent later (S216).
    log.info("Starting the agent through the scheduled task...")
    started = False
    if _agent_running():
        log.info("Agent already running — not starting a second instance")
        started = True
    else:
        run_result = subprocess.run(
            ["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True, text=True
        )
        if run_result.returncode == 0:
            # schtasks reports success even when the scheduler executes nothing
            # (FRANKENSTEIN: "Last Result: 0" with no process, and even a trivial
            # `cmd /c echo` task wrote no file). Belief the process, not the exit code.
            for _ in range(10):
                time.sleep(1)
                if _agent_running():
                    log.info("Scheduled task started the agent")
                    started = True
                    break
            if not started:
                log.warning(
                    "The task reported success but no agent appeared — this machine's "
                    "Task Scheduler may be non-functional; launching directly"
                )
        else:
            log.warning("Could not run the task (%s) — launching directly", run_result.stderr)

    # Repeat the task every 5 minutes as well: ONSTART alone means nothing restarts
    # the agent until a reboot. Failure here is not fatal (the agent has its own
    # adaptive polling), so it is only logged.
    repeat = subprocess.run(
        ["schtasks", "/Change", "/TN", TASK_NAME, "/RI", "5", "/DU", "24:00"],
        capture_output=True,
        text=True,
    )
    if repeat.returncode == 0:
        log.info("Task repeats every 5 minutes")
    else:
        log.warning("Could not add the 5-minute repetition: %s", repeat.stderr)

    try:
        # Write a VBS launcher and execute it via wscript.exe.
        # wscript.exe runs in its own session, so the agent survives
        # even if the installer/parent process is killed or the terminal
        # is closed. This is the most reliable detachment method on Windows.
        # Was `Path(agent_cmd.split('"')[1]).parent`, which assumed the command began
        # with a quoted path and raised IndexError when it did not (a python.exe with
        # no spaces in its path) — S216.
        install_dir = _install_dir()
        install_dir.mkdir(parents=True, exist_ok=True)
        vbs_path = install_dir / "launch_agent.vbs"
        vbs_content = f'Set sh = CreateObject("WScript.Shell")\nsh.Run "{agent_cmd}", 0, False\n'
        if not started:
            vbs_path.write_text(vbs_content, encoding="utf-8")
            subprocess.Popen(
                ["wscript.exe", str(vbs_path)],
                creationflags=_CREATE_NO_WINDOW,
                close_fds=True,
            )
            log.info("Launched the agent directly (task run failed)")
    except (FileNotFoundError, OSError) as e:
        log.error("Failed to launch agent: %s", e)
        # Don't return False — the scheduled task is installed and will
        # start the agent on next reboot or 5-min trigger

    # --- 4. Apply tamper protection (file ACLs + registry DENY ACEs) ---
    if _HAS_TAMPER_PROTECTION:
        log.info("Applying tamper protection (file ACLs + registry protection)...")
        agent_path = _get_agent_path()
        config_path = _get_config_path()
        state_dir = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
        # Try to find watchdog binary
        watchdog_path = None
        if getattr(sys, "frozen", False):
            wd_candidate = Path(sys.executable).parent / "lockdown-watchdog.exe"
            if wd_candidate.exists():
                watchdog_path = wd_candidate
        try:
            apply_all_protection(agent_path, config_path, state_dir, watchdog_path)
            log.info("Tamper protection applied — agent binary and config protected from deletion")
        except (subprocess.SubprocessError, OSError, RuntimeError, FileNotFoundError) as e:
            log.warning("Tamper protection partially failed: %s", e)
    else:
        log.warning("tamper_protection module not available — skipping ACL hardening")

    log.info("Installation complete — agent is running and will auto-restart if killed")
    return True


def uninstall(
    uninstall_token: str | None = None,
    server_url: str | None = None,
    api_key: str | None = None,
    device_id: str | None = None,
) -> bool:
    """Remove the service (or the scheduled task and Run key).

    Requires a server-issued uninstall token when tamper protection is active.
    Without a valid token, the tamper protection (file ACLs, registry DENY
    ACEs) stays in place and the agent cannot be fully removed.

    Args:
        uninstall_token: Server-issued token authorizing this uninstall
        server_url: Server URL for token verification
        api_key: Agent API key for token verification
        device_id: Device ID for token verification

    Returns True if uninstallation succeeded.
    """
    if not _is_windows():
        log.error("Service installer is Windows-only")
        return False

    if not _is_admin():
        log.error("Service uninstallation requires admin privileges")
        return False

    remove_service()

    # --- 0. Remove tamper protection (requires server token) ---
    if _HAS_TAMPER_PROTECTION:
        agent_path = _get_agent_path()
        config_path = _get_config_path()
        state_dir = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
        watchdog_path = None
        if getattr(sys, "frozen", False):
            wd_candidate = Path(sys.executable).parent / "lockdown-watchdog.exe"
            if wd_candidate.exists():
                watchdog_path = wd_candidate

        if uninstall_token and server_url and api_key:
            # Verify token with server, then remove protection
            result = remove_all_protection(
                agent_path,
                config_path,
                state_dir,
                watchdog_path,
                uninstall_token=uninstall_token,
                server_url=server_url,
                api_key=api_key,
                device_id=device_id,
            )
            if not result.get("protection_removed", False):
                log.error("Uninstall token verification failed — tamper protection NOT removed")
                log.error("The server must authorize this uninstall. Run with --token <TOKEN>")
                return False
            log.info("Tamper protection removed (server-authorized)")
        else:
            # No token provided — try to remove protection without server verification
            # (for backward compat / dev mode). In production with tamper protection
            # active, this will fail because the DENY ACEs block deletion.
            log.warning("No uninstall token provided — attempting removal without server auth")
            try:
                remove_all_protection(agent_path, config_path, state_dir, watchdog_path)
            except (subprocess.SubprocessError, OSError, RuntimeError, FileNotFoundError) as e:
                log.warning("Could not remove tamper protection: %s", e)
                log.warning(
                    "The agent may be protected by DENY ACLs. Use --token for authorized uninstall."
                )

    # --- 1. Delete the scheduled task ---
    result = subprocess.run(
        ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        log.info("Scheduled task '%s' deleted", TASK_NAME)
    else:
        log.warning("Could not delete scheduled task: %s", result.stderr)

    # --- 2. Remove registry run key ---
    result = subprocess.run(
        ["reg", "delete", REG_RUN_KEY, "/v", REG_VALUE_NAME, "/f"],
        capture_output=True,
        text=True,
    )

    if result.returncode == 0:
        log.info("Registry run key removed")
    else:
        log.warning("Could not remove registry run key: %s", result.stderr)

    # --- 3. Kill the running agent ---
    subprocess.run(
        ["taskkill", "/F", "/IM", "lockdown-agent.exe"],
        capture_output=True,
        text=True,
    )
    # Also kill python running agent.py
    subprocess.run(
        ["taskkill", "/F", "/IM", "python.exe", "/FI", "WINDOWTITLE eq *agent.py*"],
        capture_output=True,
        text=True,
    )

    log.info("Uninstallation complete — agent stopped and persistence removed")
    return True


def status() -> dict:
    """Check the installation status.

    Returns a dict with:
        - scheduled_task: bool — True if the scheduled task exists
        - registry_key: bool — True if the registry run key exists
        - agent_running: bool — True if the agent process is running
    """
    if not _is_windows():
        return {
            "error": "Windows-only",
            "scheduled_task": False,
            "registry_key": False,
            "agent_running": False,
        }

    # Check scheduled task
    result = subprocess.run(
        ["schtasks", "/Query", "/TN", TASK_NAME],
        capture_output=True,
        text=True,
    )
    task_exists = result.returncode == 0

    # Check registry key
    result = subprocess.run(
        ["reg", "query", REG_RUN_KEY, "/v", REG_VALUE_NAME],
        capture_output=True,
        text=True,
    )
    reg_exists = result.returncode == 0

    # Check if agent is running
    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq lockdown-agent.exe"],
        capture_output=True,
        text=True,
    )
    agent_running = "lockdown-agent.exe" in result.stdout

    return {
        "scheduled_task": task_exists,
        "registry_key": reg_exists,
        "agent_running": agent_running,
    }


def main():
    """CLI entry point for the service installer."""
    import argparse

    parser = argparse.ArgumentParser(description="Lockdown Agent Service Installer")
    parser.add_argument(
        "action", choices=["install", "uninstall", "status"], help="Action to perform"
    )
    parser.add_argument(
        "--token",
        dest="uninstall_token",
        default=None,
        help="Server-issued uninstall authorization token",
    )
    parser.add_argument(
        "--server-url",
        dest="server_url",
        default=None,
        help="Server URL for uninstall token verification",
    )
    parser.add_argument(
        "--api-key",
        dest="api_key",
        default=None,
        help="Agent API key for uninstall token verification",
    )
    parser.add_argument(
        "--device-id",
        dest="device_id",
        default=None,
        help="Device ID for uninstall token verification",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if args.action == "install":
        success = install()
        sys.exit(0 if success else 1)
    elif args.action == "uninstall":
        success = uninstall(
            uninstall_token=args.uninstall_token,
            server_url=args.server_url,
            api_key=args.api_key,
            device_id=args.device_id,
        )
        sys.exit(0 if success else 1)
    elif args.action == "status":
        s = status()
        print(f"Scheduled task: {'INSTALLED' if s.get('scheduled_task') else 'NOT INSTALLED'}")
        print(f"Registry key:   {'INSTALLED' if s.get('registry_key') else 'NOT INSTALLED'}")
        print(f"Agent running:  {'YES' if s.get('agent_running') else 'NO'}")
        if "error" in s:
            print(f"Error: {s['error']}")


if __name__ == "__main__":
    main()
