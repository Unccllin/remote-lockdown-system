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
# Auto-update support (Phase 4)
# ---------------------------------------------------------------------------
#
# The agent downloads a new binary and writes .update_pending + .update_downloaded.
# The watchdog detects this, stops the agent, replaces the binary, and restarts.

UPDATE_PENDING_FILE = _STATE_DIR / '.update_pending'
UPDATE_DOWNLOAD_FILE = _STATE_DIR / '.update_downloaded'


def check_and_apply_update() -> bool:
    """Check if an update is pending and apply it.

    Returns True if an update was applied (agent was stopped and restarted).
    """
    if not UPDATE_PENDING_FILE.exists():
        return False

    import json
    try:
        signal = json.loads(UPDATE_PENDING_FILE.read_text())
    except Exception as e:
        log.error("Failed to read update signal: %s — removing", e)
        UPDATE_PENDING_FILE.unlink(missing_ok=True)
        return False

    download_path = signal.get('download_path', str(UPDATE_DOWNLOAD_FILE))
    version = signal.get('version', 'unknown')

    log.info("Update pending: version %s, binary at %s", version, download_path)

    if not Path(download_path).exists():
        log.error("Update binary not found at %s — clearing signal", download_path)
        UPDATE_PENDING_FILE.unlink(missing_ok=True)
        return False

    # Stop the current agent
    log.info("Stopping agent for update...")
    stop_agent(_agent_proc)

    # Replace the agent binary
    try:
        # On Windows, we can't overwrite a running .exe, but we already
        # stopped the process above. On Linux, this is straightforward.
        import shutil
        target = AGENT_SCRIPT
        backup = AGENT_SCRIPT.with_suffix('.bak')

        # Back up the current binary
        if target.exists():
            shutil.copy2(str(target), str(backup))

        # Move the new binary into place
        shutil.move(str(download_path), str(target))

        # Make it executable (Linux/macOS)
        if sys.platform != 'win32':
            import os
            os.chmod(str(target), 0o755)

        log.info("Agent binary updated to version %s", version)

    except Exception as e:
        log.error("Failed to apply update: %s — restoring backup", e)
        # Try to restore the backup
        backup = AGENT_SCRIPT.with_suffix('.bak')
        if backup.exists():
            import shutil
            shutil.move(str(backup), str(AGENT_SCRIPT))
        UPDATE_PENDING_FILE.unlink(missing_ok=True)
        _agent_proc = start_agent()
        return False

    # Clean up signal and backup
    UPDATE_PENDING_FILE.unlink(missing_ok=True)
    backup = AGENT_SCRIPT.with_suffix('.bak')
    if backup.exists():
        backup.unlink(missing_ok=True)

    log.info("Update applied successfully — starting new agent")
    return True

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

        # Phase 4: Check for pending agent update (before other checks)
        if check_and_apply_update():
            _agent_proc = start_agent()
            continue

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
