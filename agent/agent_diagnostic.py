r"""
agent_diagnostic.py — Diagnostic tool for lockdown agent issues.

Run this on the target machine to diagnose why the agent isn't working.
No dependencies beyond standard library + requests.

Usage:
    python agent_diagnostic.py
    python agent_diagnostic.py --agent "C:\ProgramData\LockdownAgent\lockdown-agent.exe"
"""

import json
import os
import platform
import subprocess
import sys
from pathlib import Path


# Colors for console output
def green(s):
    return f"\033[32m{s}\033[0m"


def red(s):
    return f"\033[31m{s}\033[0m"


def yellow(s):
    return f"\033[33m{s}\033[0m"


def cyan(s):
    return f"\033[36m{s}\033[0m"


def bold(s):
    return f"\033[1m{s}\033[0m"


def section(title):
    print(f"\n{bold(cyan('=' * 60))}")
    print(bold(cyan(f"  {title}")))
    print(bold(cyan("=" * 60)))


def check(label, condition, detail=""):
    status = green("PASS") if condition else red("FAIL")
    print(f"  [{status}] {label}")
    if detail and not condition:
        print(f"         {yellow(detail)}")
    return condition


def main():
    section("SYSTEM INFO")
    print(f"  OS: {platform.system()} {platform.release()}")
    print(f"  Python: {sys.version}")
    print(f"  Platform: {platform.machine()}")
    print(f"  Hostname: {platform.node()}")

    # Admin check
    try:
        import ctypes

        is_admin = ctypes.windll.shell32.IsUserAnAdmin()
    except (OSError, AttributeError):
        is_admin = False
    check("Running as admin", is_admin, "Agent needs admin for scheduled tasks")

    INSTALL_DIR = Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent"
    CONFIG_FILE = INSTALL_DIR / "config.json"
    AGENT_EXE = INSTALL_DIR / "lockdown-agent.exe"
    LOCKSCREEN_EXE = INSTALL_DIR / "lockdown-lockscreen.exe"
    SENTINEL = INSTALL_DIR / ".locked"
    DEADMAN = INSTALL_DIR / ".deadman"
    LOG_FILE = INSTALL_DIR / "agent.log"

    section("INSTALL DIRECTORY")
    check(f"Install dir exists: {INSTALL_DIR}", INSTALL_DIR.exists())
    if INSTALL_DIR.exists():
        print("  Contents:")
        for f in INSTALL_DIR.iterdir():
            size = f.stat().st_size if f.is_file() else 0
            print(f"    {f.name:40s} {size:>10,} bytes")

    section("CONFIG FILE")
    check(f"Config exists: {CONFIG_FILE}", CONFIG_FILE.exists())
    if CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text())
            print("  Config contents:")
            for k, v in config.items():
                if k == "api_key":
                    print(f"    {k}: {str(v)[:8]}...{str(v)[-4:]} (len={len(str(v))})")
                else:
                    print(f"    {k}: {v}")

            # Validate required fields
            check("  server_url present", "server_url" in config or "serverless_url" in config)
            check("  api_key present", bool(config.get("api_key")))
            check("  device_id present", bool(config.get("device_id")))
            check("  hostname present", bool(config.get("hostname")))

            # Check API key format (base64, may contain +, /, =)
            api_key = config.get("api_key", "")
            if api_key:
                print(f"  API key length: {len(api_key)}")
                has_special = any(c in api_key for c in "+/=")
                print(f"  API key has special chars: {has_special}")
        except json.JSONDecodeError as e:
            print(red(f"  CONFIG IS INVALID JSON: {e}"))
            print(f"  Raw content: {CONFIG_FILE.read_text()[:200]}")
    else:
        print(red(f"  No config file at {CONFIG_FILE}"))
        print(yellow("  The agent cannot run without a config file."))

    section("AGENT BINARY")
    check(f"Agent exe exists: {AGENT_EXE}", AGENT_EXE.exists())
    if AGENT_EXE.exists():
        size = AGENT_EXE.stat().st_size
        check(f"Agent exe size > 1MB ({size:,} bytes)", size > 1_000_000)
        # Try running --version
        try:
            result = subprocess.run(
                [str(AGENT_EXE), "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            print(f"  --version stdout: '{result.stdout.strip()}'")
            print(f"  --version stderr: '{result.stderr.strip()}'")
            print(f"  --version exit code: {result.returncode}")
            check("Agent --version works", result.returncode == 0 and result.stdout.strip())
        except subprocess.TimeoutExpired:
            print(red("  --version timed out (10s)"))
        except (subprocess.SubprocessError, OSError) as e:
            print(red(f"  --version failed: {e}"))

        # Try running with --debug flag if available
        try:
            result = subprocess.run(
                [str(AGENT_EXE), "--version", "--debug"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.stderr:
                print(f"  --debug stderr: '{result.stderr.strip()[:500]}'")
        except (subprocess.TimeoutExpired, subprocess.SubprocessError, OSError):
            pass

    section("LOCK SCREEN BINARY")
    check(f"Lockscreen exe exists: {LOCKSCREEN_EXE}", LOCKSCREEN_EXE.exists())
    if LOCKSCREEN_EXE.exists():
        size = LOCKSCREEN_EXE.stat().st_size
        check(f"Lockscreen exe size > 1MB ({size:,} bytes)", size > 1_000_000)

    section("LOCKDOWN STATE")
    check(
        f"Sentinel (.locked) exists: {SENTINEL}",
        not SENTINEL.exists(),
        "Sentinel exists — agent will re-assert lockdown on every startup!",
    )
    if SENTINEL.exists():
        try:
            content = SENTINEL.read_text()
            print(f"  Sentinel content: {content}")
        except OSError:
            pass

    check(
        f"Deadman file exists: {DEADMAN}",
        not DEADMAN.exists(),
        "Deadman file exists — agent may re-lock if it says 'stolen'",
    )
    if DEADMAN.exists():
        try:
            content = DEADMAN.read_text()
            print(f"  Deadman content: {content[:200]}")
        except OSError:
            pass

    section("AGENT LOG")
    check(f"Log file exists: {LOG_FILE}", LOG_FILE.exists())
    if LOG_FILE.exists():
        try:
            content = LOG_FILE.read_text()
            lines = content.strip().split("\n")
            print(f"  Log has {len(lines)} lines")
            print("  Last 20 lines:")
            for line in lines[-20:]:
                print(f"    {line}")
        except OSError as e:
            print(red(f"  Could not read log: {e}"))
    else:
        print(yellow("  No log file — agent may never have started successfully"))

    section("PROCESSES")
    try:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq lockdown-agent.exe"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        print(f"  {result.stdout.strip()}")
    except (subprocess.SubprocessError, OSError) as e:
        print(red(f"  tasklist failed: {e}"))

    section("SCHEDULED TASK")
    try:
        result = subprocess.run(
            ["schtasks", "/query", "/tn", "SystemHealthMonitor"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            print(green("  Scheduled task exists"))
            print(f"  {result.stdout.strip()}")
        else:
            print(red(f"  Scheduled task NOT found: {result.stderr.strip()}"))
    except (subprocess.SubprocessError, OSError) as e:
        print(red(f"  schtasks query failed: {e}"))

    section("REGISTRY RUN KEY")
    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
        )
        try:
            value, _ = winreg.QueryValueEx(key, "SystemHealthMonitor")
            print(green(f"  Registry run key exists: {value}"))
        except FileNotFoundError:
            print(red("  Registry run key NOT found"))
        winreg.CloseKey(key)
    except (OSError, ImportError) as e:
        print(red(f"  Registry check failed: {e}"))

    section("DEFENDER EXCLUSIONS")
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-MpPreference | Select-Object -ExpandProperty ExclusionPath",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        exclusions = result.stdout.strip()
        if "LockdownAgent" in exclusions:
            print(green("  Defender exclusion for LockdownAgent found"))
        else:
            print(yellow("  No Defender exclusion for LockdownAgent"))
        if exclusions:
            print(f"  Current exclusions:\n    {exclusions.replace(chr(10), chr(10) + '    ')}")
    except (subprocess.SubprocessError, OSError) as e:
        print(red(f"  Defender check failed: {e}"))

    section("NETWORK CONNECTIVITY")
    try:
        import urllib.request

        # Test connection to Worker
        req = urllib.request.Request(
            "https://lockdown-serverless.mainacollins196.workers.dev/api/health"
        )
        with urllib.request.urlopen(req, timeout=10) as resp:  # noqa: S310
            data = json.loads(resp.read())
            check("Worker reachable", data.get("status") == "ok", f"Response: {data}")
    except Exception as e:
        print(red(f"  Worker unreachable: {e}"))

    section("PYINSTALLER TEMP DIR")
    temp_dir = Path(os.environ.get("TEMP", "C:\\Users\\Public"))
    mei_dirs = list(temp_dir.glob("_MEI*"))
    if mei_dirs:
        print(yellow(f"  Found {len(mei_dirs)} _MEI* directories (stale PyInstaller temp dirs):"))
        for d in mei_dirs[:5]:
            print(f"    {d}")
    else:
        print("  No stale _MEI* directories")

    section("DIAGNOSIS")
    issues = []
    if not CONFIG_FILE.exists():
        issues.append("Config file missing — agent cannot start")
    elif CONFIG_FILE.exists():
        try:
            config = json.loads(CONFIG_FILE.read_text())
            if not config.get("api_key"):
                issues.append("Config has no api_key — agent cannot authenticate")
            if not config.get("server_url") and not config.get("serverless_url"):
                issues.append("Config has no server_url — agent doesn't know where to connect")
        except json.JSONDecodeError:
            issues.append("Config file is invalid JSON — agent cannot parse it")

    if SENTINEL.exists():
        issues.append(
            "Sentinel file exists — agent will re-assert lockdown on startup (crash loop)"
        )

    if AGENT_EXE.exists():
        try:
            result = subprocess.run(
                [str(AGENT_EXE), "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode != 0 or not result.stdout.strip():
                issues.append(
                    "Agent --version produces no output — possible PyInstaller bootstrap failure"
                )
        except (subprocess.TimeoutExpired, subprocess.SubprocessError, OSError):
            issues.append(
                "Agent exe cannot be launched — possible corruption or Defender quarantine"
            )

    if not AGENT_EXE.exists():
        issues.append("Agent exe not found in install directory")

    if issues:
        print(red(f"  Found {len(issues)} issue(s):"))
        for i, issue in enumerate(issues, 1):
            print(f"    {i}. {red(issue)}")
    else:
        print(green("  No issues found — agent should be working"))

    print(f"\n{bold(cyan('=' * 60))}")
    print(bold(cyan("  Diagnostic complete")))
    print(bold(cyan("=" * 60)))


if __name__ == "__main__":
    main()
