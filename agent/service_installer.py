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
from pathlib import Path

log = logging.getLogger("lockdown-agent")

# Tamper protection — applied after service install to harden against deletion
try:
    from tamper_protection import apply_all_protection, remove_all_protection

    _HAS_TAMPER_PROTECTION = True
except ImportError:
    _HAS_TAMPER_PROTECTION = False

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


def _build_agent_command() -> str:
    """Build the command string to launch the agent."""
    agent_path = _get_agent_path()
    config_path = _get_config_path()

    if getattr(sys, "frozen", False):
        # PyInstaller exe — run directly
        cmd = f'"{agent_path}" --silent'
    else:
        # Python script — run with Python
        python_path = _get_python_path()
        cmd = f'"{python_path}" "{agent_path}" --silent'

    if config_path:
        cmd += f' --config "{config_path}"'

    return cmd


def _build_watchdog_command() -> str:
    """Build the watchdog PowerShell command that checks and restarts the agent."""
    agent_cmd = _build_agent_command()

    # PowerShell script that:
    # 1. Checks if the agent process is running
    # 2. If not, launches it
    # 3. Runs silently (no window)
    ps_script = f"""
$ErrorActionPreference = 'SilentlyContinue'
$agentProcess = Get-Process -Name 'lockdown-agent' -ErrorAction SilentlyContinue
if (-not $agentProcess) {{
    # Also check for python running agent.py
    $pythonProcs = Get-WmiObject Win32_Process `
        -Filter "Name='python.exe' OR Name='python3.exe'" `
        | Where-Object {{ $_.CommandLine -like '*agent.py*' }}
    if (-not $pythonProcs) {{
        Start-Process -FilePath 'cmd.exe' `
            -ArgumentList '/c {agent_cmd}' `
            -WindowStyle Hidden -CreateNoWindow
    }}
}}
""".strip()

    # Encode for schtasks (use base64 to avoid quoting issues)
    import base64

    encoded = base64.b64encode(ps_script.encode("utf-16LE")).decode("ascii")
    return f"powershell.exe -NoProfile -EncodedCommand {encoded}"


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

    watchdog_cmd = _build_watchdog_command()
    agent_cmd = _build_agent_command()

    # --- 1. Create the scheduled task ---
    # Delete existing task if it exists
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

    # Create the startup trigger
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

    # --- 3. Launch the agent immediately ---
    log.info("Launching agent immediately...")
    subprocess.Popen(
        ["cmd", "/c", agent_cmd],
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        close_fds=True,
    )

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
    """Remove the scheduled task and registry run key.

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
