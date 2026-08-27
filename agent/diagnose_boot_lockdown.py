"""Diagnostic script for HP EliteBook 840 G7 — run on the target machine.

This script gathers all the information needed to diagnose why BCD lockdown
and HP UEFI lockdown failed in the prior test. It makes NO changes — purely
read-only diagnostics.

Usage (run as Administrator in PowerShell or cmd):
    python diagnose_boot_lockdown.py

Or if running the PyInstaller bundle:
    lockdown-diagnose.exe

The script will output a JSON report that you can share back for analysis.
"""

import ctypes
import json
import platform
import subprocess
from datetime import UTC, datetime
from pathlib import Path


def run_cmd(cmd: list[str], timeout: int = 10) -> dict:
    """Run a command and return result dict."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return {
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except Exception as e:
        return {"returncode": -1, "stdout": "", "stderr": str(e)}


def run_powershell(script: str, timeout: int = 15) -> dict:
    """Run a PowerShell command and return result dict."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "returncode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except Exception as e:
        return {"returncode": -1, "stdout": "", "stderr": str(e)}


def check_admin() -> bool:
    """Check if running as admin."""
    if platform.system() != "Windows":
        return False
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def check_admin_net_session() -> dict:
    """Check admin via net session (same method as bcd_lockdown.py)."""
    return run_cmd(["net", "session"], timeout=5)


def check_bitlocker() -> dict:
    """Check BitLocker status on C:."""
    result = run_cmd(["manage-bde", "-status", "C:"], timeout=15)
    info = {
        "raw_output": result["stdout"],
        "raw_error": result["stderr"],
        "returncode": result["returncode"],
        "protection_on": False,
        "encryption_percentage": None,
    }
    for line in result["stdout"].split("\n"):
        line_lower = line.lower().strip()
        if "protection status" in line_lower and "on" in line_lower:
            info["protection_on"] = True
        if "percentage encrypted" in line_lower:
            try:
                pct = line_lower.split(":")[-1].strip().replace("%", "")
                info["encryption_percentage"] = pct
            except Exception:  # noqa: S110
                pass
    return info


def check_hp_wmi() -> dict:
    """Check if HP WMI BIOS namespace is available."""
    # Check namespace existence
    ps_script = """
try {
    $ns = "root\\hp\\InstrumentedBIOS"
    $settings = Get-WmiObject -Namespace $ns -Class HP_BIOSSetting -ErrorAction Stop
    $count = ($settings | Measure-Object).Count
    Write-Output "HP_WMI_AVAILABLE: true"
    Write-Output "HP_BIOSSetting_COUNT: $count"
} catch {
    Write-Output "HP_WMI_AVAILABLE: false"
    Write-Output "HP_WMI_ERROR: $_"
}
"""
    return run_powershell(ps_script, timeout=15)


def get_hp_model() -> dict:
    """Get HP model name."""
    ps_script = "(Get-WmiObject -Class Win32_ComputerSystem).Model"
    return run_powershell(ps_script, timeout=10)


def list_hp_bios_settings() -> dict:
    """List all HP BIOS enumeration settings with current values."""
    ps_script = """
try {
    $ns = "root\\hp\\InstrumentedBIOS"
    $settings = Get-WmiObject -Namespace $ns -Class HP_BIOSEnumeration -ErrorAction Stop
    foreach ($s in $settings) {
        $current = if ($s.CurrentValue) { $s.CurrentValue } else { "(null)" }
        Write-Output "$($s.Name) = $current"
    }
} catch {
    Write-Output "ERROR: $_"
}
"""
    result = run_powershell(ps_script, timeout=30)
    settings = {}
    for line in result["stdout"].split("\n"):
        if " = " in line and not line.startswith("ERROR"):
            parts = line.split(" = ", 1)
            if len(parts) == 2:
                settings[parts[0].strip()] = parts[1].strip()
    return {
        "raw_output": result["stdout"],
        "settings": settings,
        "count": len(settings),
    }


def check_sure_admin() -> dict:
    """Check for Sure Admin / EBAM settings."""
    ps_script = """
try {
    $ns = "root\\hp\\InstrumentedBIOS"
    $all = Get-WmiObject -Namespace $ns -Class HP_BIOSEnumeration -ErrorAction Stop
    $sureNames = @(
        "Enhanced BIOS Authentication Mode (EBAM)",
        "Enhanced BIOS Authentication Mode",
        "EBAM", "Sure Admin", "HP Sure Admin",
        "HP Sure Start",
        "Sure Start BIOS Settings Protection"
    )
    foreach ($name in $sureNames) {
        $match = $all | Where-Object { $_.Name -like "*$name*" }
        foreach ($m in $match) {
            Write-Output "FOUND: $($m.Name) = $($m.CurrentValue)"
        }
    }
    $service = Get-Service -Name "HPSureRun" -ErrorAction SilentlyContinue
    if ($service) {
        Write-Output "SERVICE: HPSureRun = $($service.Status)"
    }
} catch {
    Write-Output "ERROR: $_"
}
"""
    return run_powershell(ps_script, timeout=20)


def check_bios_password() -> dict:
    """Check if BIOS Setup Password is set."""
    ps_script = """
try {
    $ns = "root\\hp\\InstrumentedBIOS"
    $pw = Get-WmiObject -Namespace $ns -Class HP_BIOSPassword -ErrorAction Stop
    foreach ($p in $pw) {
        Write-Output "$($p.Name): IsSet=$($p.IsSet)"
    }
} catch {
    Write-Output "ERROR: $_"
}
"""
    return run_powershell(ps_script, timeout=15)


def check_bcd_settings() -> dict:
    """Check current BCD settings that lockdown would modify."""
    settings = {}
    cmds = [
        ("recoveryenabled", ["bcdedit", "/query", "{default}", "recoveryenabled"]),
        ("displaybootmenu", ["bcdedit", "/query", "{bootmgr}", "displaybootmenu"]),
        ("bootsequence", ["bcdedit", "/query", "{bootmgr}", "bootsequence"]),
        ("timeout", ["bcdedit", "/query", "{bootmgr}", "timeout"]),
    ]
    for name, cmd in cmds:
        result = run_cmd(cmd, timeout=10)
        settings[name] = {
            "returncode": result["returncode"],
            "stdout": result["stdout"],
            "stderr": result["stderr"],
        }
    return settings


def check_winre() -> dict:
    """Check WinRE status."""
    result = run_cmd(["reagentc", "/info"], timeout=10)
    info = {
        "raw_output": result["stdout"],
        "raw_error": result["stderr"],
        "returncode": result["returncode"],
        "enabled": "Enabled" in result["stdout"],
    }
    return info


def check_existing_state_files() -> dict:
    """Check for existing state files from prior lockdown attempts."""
    agent_dir = Path(__file__).parent
    files = {}
    for fname in [
        ".bcd_state",
        ".boot_state",
        ".pending_ack",
        ".deadman",
        ".locked",
        ".heartbeat",
        ".watchdog_heartbeat",
    ]:
        fpath = agent_dir / fname
        files[fname] = {
            "exists": fpath.exists(),
            "path": str(fpath),
        }
        if fpath.exists():
            try:
                content = fpath.read_text()
                files[fname]["content"] = content[:500]  # First 500 chars
            except Exception as e:
                files[fname]["content"] = f"(error reading: {e})"
    return files


def check_agent_process() -> dict:
    """Check if agent/watchdog processes are running."""
    result = run_cmd(["tasklist", "/FI", "IMAGENAME eq lockdown-agent.exe"], timeout=5)
    wd_result = run_cmd(["tasklist", "/FI", "IMAGENAME eq lockdown-watchdog.exe"], timeout=5)
    return {
        "agent_running": "lockdown-agent.exe" in result["stdout"],
        "watchdog_running": "lockdown-watchdog.exe" in wd_result["stdout"],
        "agent_tasklist": result["stdout"],
        "watchdog_tasklist": wd_result["stdout"],
    }


def check_scheduled_task() -> dict:
    """Check if the scheduled task exists."""
    result = run_cmd(["schtasks", "/Query", "/TN", "SystemHealthMonitor"], timeout=5)
    return {
        "exists": result["returncode"] == 0,
        "raw_output": result["stdout"],
        "raw_error": result["stderr"],
    }


def main():
    print("=" * 70)
    print("HP EliteBook 840 G7 — Boot Lockdown Diagnostic")
    print(f"Timestamp: {datetime.now(UTC).isoformat()}")
    print(f"Platform: {platform.system()} {platform.release()}")
    print(f"Machine: {platform.machine()}")
    print("=" * 70)
    print()

    report = {
        "timestamp": datetime.now(UTC).isoformat(),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor(),
    }

    # 1. Admin check
    print("[1/12] Checking admin privileges...")
    report["is_admin_ctypes"] = check_admin()
    report["is_admin_net_session"] = check_admin_net_session()
    print(f"  ctypes.IsUserAnAdmin(): {report['is_admin_ctypes']}")
    print(f"  net session returncode: {report['is_admin_net_session']['returncode']}")
    print()

    # 2. HP model
    print("[2/12] Detecting HP model...")
    report["hp_model"] = get_hp_model()
    print(f"  Model: {report['hp_model']['stdout']}")
    print()

    # 3. HP WMI
    print("[3/12] Checking HP WMI BIOS namespace...")
    report["hp_wmi"] = check_hp_wmi()
    for line in report["hp_wmi"]["stdout"].split("\n"):
        if line.strip():
            print(f"  {line}")
    print()

    # 4. BIOS settings list
    print("[4/12] Listing HP BIOS settings...")
    report["hp_bios_settings"] = list_hp_bios_settings()
    print(f"  Found {report['hp_bios_settings']['count']} settings")
    for name, value in list(report["hp_bios_settings"]["settings"].items())[:20]:
        print(f"  {name} = {value}")
    if report["hp_bios_settings"]["count"] > 20:
        print(f"  ... and {report['hp_bios_settings']['count'] - 20} more")
    print()

    # 5. Sure Admin
    print("[5/12] Checking for Sure Admin / EBAM...")
    report["sure_admin"] = check_sure_admin()
    for line in report["sure_admin"]["stdout"].split("\n"):
        if line.strip():
            print(f"  {line}")
    if not report["sure_admin"]["stdout"].strip():
        print("  (none found)")
    print()

    # 6. BIOS password
    print("[6/12] Checking BIOS password status...")
    report["bios_password"] = check_bios_password()
    for line in report["bios_password"]["stdout"].split("\n"):
        if line.strip():
            print(f"  {line}")
    print()

    # 7. BitLocker
    print("[7/12] Checking BitLocker status...")
    report["bitlocker"] = check_bitlocker()
    print(f"  Protection On: {report['bitlocker']['protection_on']}")
    print(f"  Encryption: {report['bitlocker']['encryption_percentage']}%")
    print()

    # 8. BCD settings
    print("[8/12] Checking current BCD settings...")
    report["bcd_settings"] = check_bcd_settings()
    for name, info in report["bcd_settings"].items():
        status = "OK" if info["returncode"] == 0 else f"FAIL (rc={info['returncode']})"
        print(f"  {name}: {status}")
        if info["stderr"]:
            print(f"    stderr: {info['stderr']}")
    print()

    # 9. WinRE
    print("[9/12] Checking WinRE status...")
    report["winre"] = check_winre()
    print(f"  Enabled: {report['winre']['enabled']}")
    print()

    # 10. State files
    print("[10/12] Checking for existing state files...")
    report["state_files"] = check_existing_state_files()
    for fname, info in report["state_files"].items():
        exists = "EXISTS" if info["exists"] else "missing"
        print(f"  {fname}: {exists}")
    print()

    # 11. Agent process
    print("[11/12] Checking agent/watchdog processes...")
    report["processes"] = check_agent_process()
    print(f"  Agent running: {report['processes']['agent_running']}")
    print(f"  Watchdog running: {report['processes']['watchdog_running']}")
    print()

    # 12. Scheduled task
    print("[12/12] Checking scheduled task...")
    report["scheduled_task"] = check_scheduled_task()
    print(f"  Task exists: {report['scheduled_task']['exists']}")
    print()

    # Write report
    report_path = Path(__file__).parent / "diagnostic_report.json"
    report_path.write_text(json.dumps(report, indent=2, default=str))
    print("=" * 70)
    print(f"Diagnostic report written to: {report_path}")
    print()
    print("SUMMARY:")
    print(f"  Admin (ctypes):        {report['is_admin_ctypes']}")
    print(f"  Admin (net session):   {report['is_admin_net_session']['returncode'] == 0}")
    print(f"  HP model:              {report['hp_model']['stdout']}")
    print(f"  HP WMI available:      {'true' in report['hp_wmi']['stdout'].lower()}")
    print(f"  BIOS settings found:   {report['hp_bios_settings']['count']}")
    print(f"  Sure Admin detected:   {bool(report['sure_admin']['stdout'].strip())}")
    print(f"  BIOS password set:     {'IsSet=True' in report['bios_password']['stdout']}")
    print(f"  BitLocker protection:  {report['bitlocker']['protection_on']}")
    print(f"  WinRE enabled:         {report['winre']['enabled']}")
    print(f"  Agent running:         {report['processes']['agent_running']}")
    print()
    print("Please share the diagnostic_report.json file back for analysis.")
    print("=" * 70)


if __name__ == "__main__":
    main()
