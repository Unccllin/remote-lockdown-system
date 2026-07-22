"""
Lockdown Agent Watchdog
-----------------------
Monitors agent.py and restarts it if it crashes or becomes unresponsive.

Runs as a SEPARATE process/service alongside the agent.
Uses a heartbeat file that agent.py must update every poll cycle.
If the heartbeat goes stale, the watchdog kills and restarts the agent.

USAGE:
  python watchdog.py                  # Run from source
  lockdown-watchdog                   # Run as PyInstaller-bundled executable

INSTALL AS SERVICE:
  Use install_watchdog_service.ps1 (run as Administrator)
"""

import os
import sys
import time
import logging
import subprocess
import signal
from pathlib import Path

# ---------------------------------------------------------------------------
# Frozen-mode detection (PyInstaller bundle)
# ---------------------------------------------------------------------------
def _is_frozen():
    """Check if the watchdog is running as a PyInstaller bundle."""
    return getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# When frozen, the agent binary lives next to the watchdog binary.
# When running from source, we launch agent.py via the Python interpreter.
if _is_frozen():
    _EXE_DIR = Path(sys.executable).parent
    AGENT_BIN = _EXE_DIR / ('lockdown-agent.exe' if sys.platform == 'win32' else 'lockdown-agent')
    AGENT_SCRIPT = AGENT_BIN  # Unified name (binary path either way)
    LAUNCH_VIA_PYTHON = False
else:
    AGENT_SCRIPT = Path(__file__).parent / "agent.py"
    LAUNCH_VIA_PYTHON = True

# Heartbeat file: must match the path used by agent.py.
# agent.py uses _STATE_DIR (platform-specific system dir when frozen,
# script dir when running from source). We replicate that logic here.
if _is_frozen():
    if sys.platform == 'win32':
        _STATE_DIR = Path(os.environ.get('PROGRAMDATA', 'C:\\ProgramData')) / 'LockdownAgent'
    else:
        _STATE_DIR = Path('/var/lib/lockdown-agent')
else:
    _STATE_DIR = Path(__file__).parent
HEARTBEAT_FILE = _STATE_DIR / ".heartbeat"

HEARTBEAT_MAX_AGE_SEC = 120   # Restart agent if no heartbeat for 2 minutes
CHECK_INTERVAL_SEC    = 30    # How often watchdog checks the heartbeat
PYTHON_EXE      = sys.executable

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [WATCHDOG] %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("watchdog")

# ---------------------------------------------------------------------------
# Agent process management
# ---------------------------------------------------------------------------
_agent_proc: subprocess.Popen | None = None

def start_agent() -> subprocess.Popen:
    if LAUNCH_VIA_PYTHON:
        log.info("Starting agent: %s %s", PYTHON_EXE, AGENT_SCRIPT)
        proc = subprocess.Popen(
            [PYTHON_EXE, str(AGENT_SCRIPT)],
            cwd=str(AGENT_SCRIPT.parent),
        )
    else:
        log.info("Starting agent: %s", AGENT_SCRIPT)
        proc = subprocess.Popen(
            [str(AGENT_SCRIPT)],
            cwd=str(AGENT_SCRIPT.parent),
        )
    log.info("Agent started — PID %d", proc.pid)
    return proc

def stop_agent(proc: subprocess.Popen) -> None:
    if proc and proc.poll() is None:
        log.warning("Stopping agent PID %d", proc.pid)
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            log.warning("Agent killed (did not terminate gracefully)")

def is_heartbeat_stale() -> bool:
    if not HEARTBEAT_FILE.exists():
        return False  # Agent hasn't written one yet (just started)
    age = time.time() - HEARTBEAT_FILE.stat().st_mtime
    return age > HEARTBEAT_MAX_AGE_SEC

# ---------------------------------------------------------------------------
# Main watchdog loop
# ---------------------------------------------------------------------------

def main() -> None:
    global _agent_proc

    log.info("Watchdog starting — monitoring %s", AGENT_SCRIPT)
    log.info("Heartbeat timeout: %ds | Check interval: %ds",
             HEARTBEAT_MAX_AGE_SEC, CHECK_INTERVAL_SEC)

    if not AGENT_SCRIPT.exists():
        log.error("Agent not found at %s — exiting", AGENT_SCRIPT)
        sys.exit(1)

    # Handle SIGTERM gracefully
    def _shutdown(signum, frame):
        log.info("Watchdog shutting down...")
        stop_agent(_agent_proc)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    if hasattr(signal, "SIGBREAK"):  # Windows
        signal.signal(signal.SIGBREAK, _shutdown)

    _agent_proc = start_agent()

    while True:
        time.sleep(CHECK_INTERVAL_SEC)

        # Check if agent process died
        if _agent_proc.poll() is not None:
            exit_code = _agent_proc.returncode
            log.warning("Agent exited with code %d — restarting...", exit_code)
            _agent_proc = start_agent()
            continue

        # Check if agent is frozen (heartbeat stale)
        if is_heartbeat_stale():
            age = time.time() - HEARTBEAT_FILE.stat().st_mtime
            log.warning("Heartbeat stale (%.0fs old) — agent may be frozen, restarting...", age)
            stop_agent(_agent_proc)
            _agent_proc = start_agent()
            continue

        log.info("Agent healthy — PID %d", _agent_proc.pid)

if __name__ == "__main__":
    main()
