"""Windows service host for the lockdown agent.

Why this exists
---------------
The agent has to run unattended, at boot, on a machine nobody is logged into. The two
mechanisms shipped before this both failed on a real machine (S216–S219):

* the **scheduled task** — that machine's Task Scheduler executed nothing while
  reporting ``Last Result: 0`` (a control ``cmd /c echo`` task wrote no file), and
* the **Run key** — it launches non-elevated at logon, and the install directory grants
  ``BUILTIN\\Users`` only ``(RX)``, so the agent started, could not write its log or
  state, and exited without a trace.

A service runs as SYSTEM before any logon, needs neither the scheduler nor a user, and
makes the agent's own tamper check truthful: it reports ``service_missing=True`` on
every task-based install, so every healthy machine currently looks tampered with.

This host supervises the agent as a child process (start, restart on exit with
backoff, stop on service stop) so the agent binary keeps its simple console contract.
It is also the natural place for the SCM interface, which a frozen console exe cannot
provide on its own.

Usage (development / lab)::

    python service_host.py debug     # run in the foreground
    python service_host.py install   # register (needs admin)
    python service_host.py start | stop | remove
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

SERVICE_NAME = "LockdownAgent"
SERVICE_DISPLAY_NAME = "Lockdown Agent"
SERVICE_DESCRIPTION = "Remote lockdown agent (device policy, EFS, tracking, recovery)."

# Seconds between restart attempts; the last value repeats.
_RESTART_DELAYS = (5, 10, 30, 60)

# A running agent that has not had a check-in ANSWERED for this long is not supervising
# the device any more, even though its process exists. On MOLE the process lived for ~14
# hours past its last check-in while this host logged "agent already running" every 30 s
# (S270) — process existence is not evidence of anything.
CHECKIN_STALL_SEC = 900
# A freshly started agent has not reported yet; do not judge it during this window.
STARTUP_GRACE_SEC = 180
HEALTH_TIMEOUT_SEC = 5


def install_dir() -> Path:
    return Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "LockdownAgent"


def agent_command() -> list[str]:
    """Command that runs the agent, preferring the installed binary."""
    directory = install_dir()
    exe = directory / "lockdown-agent.exe"
    config = directory / "config.json"

    if exe.exists():
        cmd = [str(exe), "--silent"]
    else:
        # Running from source (development): use this interpreter.
        cmd = [sys.executable, str(directory / "agent.py"), "--silent"]

    if config.exists():
        cmd += ["--config", str(config)]
    return cmd


def log_line(message: str) -> None:
    """Append to the agent log so service lifecycles are visible where operators look."""
    path = install_dir() / "agent.log"
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} [SERVICE] {message}\n")
    except OSError:
        # Never let logging take the service down.
        pass


def _tasklist() -> str:
    try:
        return (
            subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq lockdown-agent.exe", "/NH"],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout
            or ""
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return ""


def agent_pids() -> list[int]:
    """PIDs of running lockdown-agent processes (parent bootloader + child included)."""
    pids: list[int] = []
    for line in _tasklist().splitlines():
        parts = line.split()
        # "lockdown-agent.exe  7540 Services  0  6,716 K"
        if parts and parts[0].lower() == "lockdown-agent.exe":
            try:
                pids.append(int(parts[1]))
            except (IndexError, ValueError):
                continue
    return pids


def agent_is_running() -> bool:
    """True when a lockdown-agent process exists (regardless of whether it works)."""
    return bool(agent_pids()) or "lockdown-agent.exe" in _tasklist().lower()


def marker_age(path: Path, now: float | None = None) -> float | None:
    """Seconds since `path` was last written, or None when it does not exist."""
    try:
        return (now if now is not None else time.time()) - path.stat().st_mtime
    except OSError:
        return None


def last_checkin_age(now: float | None = None) -> float | None:
    """Seconds since the SERVER last answered a check-in (None if never, for this build).

    The heartbeat file is deliberately NOT used for this: it proves the loop ticked, and on
    MOLE it kept ticking while no check-in arrived for 14 hours (S270). "Alive" and
    "supervising the device" are different questions.
    """
    return marker_age(install_dir() / ".last_checkin_ok", now)


def agent_liveness(
    running: bool,
    checkin_age: float | None,
    uptime: float | None = None,
) -> str:
    """Classify a running agent: absent | starting | healthy | stalled | unjudged.

    Pure so the decision can be tested without a Windows machine or a real process.

    * absent   — nothing is running
    * starting — younger than STARTUP_GRACE_SEC; it has not had a chance to report
    * healthy  — a check-in was answered within CHECKIN_STALL_SEC
    * stalled  — running, older than the grace window, no answered check-in in evidence
    * unjudged — running, but no `.last_checkin_ok` marker at all (a build from before the
                 marker existed). Killing on absence of evidence is how a supervisor ends
                 up in a restart loop, so it reports and waits instead.
    """
    if not running:
        return "absent"
    if checkin_age is not None and checkin_age <= CHECKIN_STALL_SEC:
        return "healthy"
    if uptime is not None and uptime <= STARTUP_GRACE_SEC:
        return "starting"
    if checkin_age is None:
        return "unjudged"
    return "stalled"


def terminate_agent_processes() -> int:
    """Force-kill every lockdown-agent process. Returns how many were signalled.

    `taskkill /F /PID` rather than Popen.terminate(): the process we need to remove is
    usually not our child (it survived a previous host instance), which is exactly the
    MOLE case — `Restart-Service` could not clear it (S270).
    """
    killed = 0
    for pid in agent_pids():
        try:
            subprocess.run(
                ["taskkill", "/F", "/PID", str(pid)],
                capture_output=True,
                text=True,
                timeout=15,
            )
            killed += 1
        except (FileNotFoundError, subprocess.SubprocessError):
            continue
    return killed


def _config() -> dict:
    """The agent's config.json, or {} when it cannot be read."""
    try:
        return json.loads((install_dir() / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def server_reachable(timeout: float = HEALTH_TIMEOUT_SEC) -> bool:
    """Is the configured server answering /api/health right now?

    Needed before restarting a "stalled" agent: an offline laptop also has no answered
    check-ins, and killing the agent every 15 minutes while it queues commands offline
    would be worse than leaving it alone. The distinction is not available from the
    device's own state — it requires asking the server.
    """
    import ssl
    import urllib.error
    import urllib.request

    cfg = _config()
    base = str(cfg.get("server_url") or "").rstrip("/")
    if not base.startswith(("http://", "https://")):
        return False
    context = None
    if base.startswith("https://") and cfg.get("verify_tls") is False:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(  # noqa: S310 - scheme checked above
            f"{base}/api/health", timeout=timeout, context=context
        ) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


# SetThreadExecutionState flags (kernel32). Held for the life of the service so the
# machine cannot idle into sleep/hibernate and drop out of reach — an operator can
# change the powercfg policy, but not this.
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


def acquire_keep_awake() -> bool:
    """Ask Windows not to sleep or hibernate while the service runs."""
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
        log_line("keep-awake acquired (ES_SYSTEM_REQUIRED|ES_CONTINUOUS)")
        return True
    except (AttributeError, OSError) as exc:
        log_line(f"keep-awake unavailable: {exc}")
        return False


def release_keep_awake() -> None:
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        kernel32.SetThreadExecutionState(ES_CONTINUOUS)
        log_line("keep-awake released")
    except (AttributeError, OSError):
        pass


def _age_text(age: float | None) -> str:
    return "never" if age is None else f"{age:.0f}s ago"


def _wait_or_stop(stop_event, seconds: float) -> bool:
    """Sleep in slices, returning True when a stop was requested."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if stop_event is not None and stop_event.is_set():
            return True
        time.sleep(1)
    return False


# ---------------------------------------------------------------------------
# Applying a verified update (S298)
# ---------------------------------------------------------------------------
# The agent downloads a new binary, checks its SHA-256 and its detached Ed25519 signature,
# then writes `.update_pending` + `.update_downloaded` for a supervisor to consume.
# `agent/watchdog.py` is the other consumer, and installs that use THIS service host have
# no watchdog — so on MOLE the update was downloaded and signature-verified and then sat
# there, while the agent's log promised "watchdog will apply on next check" (S297). A
# verified update that is never applied is worse than no update channel at all: it looks
# like success from both ends.
#
# The signature was checked by the agent; this function re-checks the SHA-256 against the
# hash recorded in the signal, because a supervisor's job is to refuse a swap whose bytes
# are not the bytes that were signed.
UPDATE_PENDING_FILE = ".update_pending"
UPDATE_DOWNLOAD_FILE = ".update_downloaded"
# A swapped-in binary that dies inside this window is treated as a bad update.
UPDATE_ROLLBACK_SEC = 60


def apply_pending_update(root: Path | None = None) -> str:
    """Swap in the downloaded update. Returns ``none`` | ``applied`` | ``corrupt`` | ``failed``.

    "corrupt" covers every case where the signal or the bytes cannot be trusted (unreadable
    signal, missing download, hash mismatch): the signal is cleared so the supervisor does
    not retry it forever, and the bad download is deleted rather than left to be swapped by
    something less careful.
    """
    base = root or install_dir()
    pending = base / UPDATE_PENDING_FILE
    if not pending.exists():
        return "none"

    try:
        signal = json.loads(pending.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pending.unlink(missing_ok=True)
        return "corrupt"

    download = Path(signal.get("download_path") or str(base / UPDATE_DOWNLOAD_FILE))
    target = base / "lockdown-agent.exe"
    if not download.exists():
        pending.unlink(missing_ok=True)
        return "corrupt"

    expected = str(signal.get("sha256") or "").lower()
    if expected:
        try:
            actual = hashlib.sha256(download.read_bytes()).hexdigest()
        except OSError:
            pending.unlink(missing_ok=True)
            return "corrupt"
        if actual != expected:
            pending.unlink(missing_ok=True)
            download.unlink(missing_ok=True)
            return "corrupt"

    try:
        if target.exists():
            shutil.copy2(str(target), str(target.with_suffix(".bak")))
        shutil.move(str(download), str(target))
        if sys.platform != "win32":
            os.chmod(str(target), 0o755)  # noqa: S103 — an executable must be executable
    except (OSError, PermissionError):
        restore_backup(base)
        pending.unlink(missing_ok=True)
        return "failed"

    pending.unlink(missing_ok=True)
    return "applied"


def restore_backup(root: Path | None = None) -> bool:
    """Put the previous binary back if the swap left one. True when it was restored."""
    base = root or install_dir()
    target = base / "lockdown-agent.exe"
    backup = target.with_suffix(".bak")
    if not backup.exists():
        return False
    try:
        shutil.move(str(backup), str(target))
    except (OSError, PermissionError):
        return False
    return True


def _apply_update_if_pending(stop_event) -> bool:
    """Apply a pending update before supervision continues. True when one was applied."""
    if not (install_dir() / UPDATE_PENDING_FILE).exists():
        return False
    if agent_is_running():
        # On Windows the running image holds the file open.
        log_line("update pending — stopping the agent to apply it")
        terminate_agent_processes()
        _wait_or_stop(stop_event, 3)
    outcome = apply_pending_update()
    log_line(f"pending update: {outcome}")
    return outcome == "applied"


def run_supervisor(stop_event=None) -> int:
    """Start the agent and restart it when it exits, until asked to stop.

    ``stop_event`` is anything with ``is_set()`` (the SCM stop event in service mode,
    or a threading.Event in debug mode).
    """
    attempt = 0
    child: subprocess.Popen | None = None
    started_at: float | None = None
    swapped_at: float | None = None

    while True:
        if stop_event is not None and stop_event.is_set():
            break

        # A verified update waiting on disk outranks every other decision.
        if _apply_update_if_pending(stop_event):
            swapped_at = time.time()
            started_at = None

        if agent_is_running():
            age = last_checkin_age()
            uptime = (time.time() - started_at) if started_at is not None else None
            verdict = agent_liveness(True, age, uptime)
            if verdict == "stalled":
                # The process exists and is not doing its job. Only restart when the
                # SERVER is answering: an offline device also has no answered check-ins,
                # and killing the agent every 15 minutes while it queues commands offline
                # would be worse than leaving it alone.
                if server_reachable():
                    log_line(f"agent stalled — no answered check-in for {age:.0f}s; terminating it")
                    terminate_agent_processes()
                    started_at = None
                    # fall through and start a fresh one
                else:
                    log_line(
                        f"agent has no answered check-in for {age:.0f}s, but the server is "
                        "unreachable — leaving it running (it may be offline, not wedged)"
                    )
                    if _wait_or_stop(stop_event, 30):
                        return 0
                    continue
            else:
                # healthy / starting / unjudged: nothing to do, and a second poller for one
                # device is the bug this guard exists for (S220).
                log_line(
                    f"agent {verdict} (last answered check-in {_age_text(age)}, "
                    f"heartbeat {_age_text(marker_age(install_dir() / '.heartbeat'))})"
                )
                if _wait_or_stop(stop_event, 30):
                    return 0
                continue

        cmd = agent_command()
        log_line(f"starting agent: {' '.join(cmd)}")
        try:
            child = subprocess.Popen(
                cmd,
                cwd=str(install_dir()),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            log_line(f"could not start agent: {exc}")
            child = None
        if child is not None:
            started_at = time.time()

        if child is not None:
            intentional_swap = False
            while child.poll() is None:
                if stop_event is not None and stop_event.is_set():
                    log_line("stop requested — terminating the agent")
                    child.terminate()
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        child.kill()
                    return 0
                # The update check belongs HERE, inside the wait for a live child: the outer
                # loop only comes round when the agent has already exited, so a check placed
                # there cannot see an update on a healthy device — which is exactly the case
                # that matters (measured on MOLE, S298: .update_pending sat for 45 s with a
                # healthy agent and a service host that never looked).
                if _apply_update_if_pending(stop_event):
                    swapped_at = time.time()
                    intentional_swap = True
                    break
                time.sleep(2)

            if intentional_swap:
                log_line("agent stopped to apply its update — starting the new binary")
                attempt = 0
                continue

            log_line(f"agent exited with code {child.returncode}")
            # A freshly swapped binary that dies quickly is a bad update, not a crash loop:
            # roll back once, and the restart below brings the previous version up.
            if swapped_at is not None and time.time() - swapped_at < UPDATE_ROLLBACK_SEC:
                restored = restore_backup()
                log_line(
                    "new binary exited within the update grace window — "
                    + ("restored the previous binary" if restored else "no backup to restore")
                )
                swapped_at = None

        delay = _RESTART_DELAYS[min(attempt, len(_RESTART_DELAYS) - 1)]
        attempt += 1
        log_line(f"restarting in {delay}s")
        deadline = time.time() + delay
        while time.time() < deadline:
            if stop_event is not None and stop_event.is_set():
                return 0
            time.sleep(1)

    return 0


# --- SCM integration ------------------------------------------------------------
# Imported lazily so this module can be imported (and unit tested) off Windows.

PYWIN32_AVAILABLE = False

if TYPE_CHECKING:  # pragma: no cover - type checkers only
    # Analysed with the real modules so every pywin32 attribute below is known;
    # the runtime branch below is what actually imports them.
    import servicemanager  # noqa: F401
    import win32event  # noqa: F401
    import win32service  # noqa: F401
    import win32serviceutil  # noqa: F401

    PYWIN32_AVAILABLE = True
else:  # pragma: no cover - exercised only on Windows
    try:
        import servicemanager
        import win32event
        import win32service
        import win32serviceutil

        PYWIN32_AVAILABLE = True
    except ImportError:
        # Bound to None so a missing dependency is a flag check, not a NameError.
        servicemanager = None
        win32event = None
        win32service = None
        win32serviceutil = None


class _StopHandle:
    """Adapt a Win32 event handle to the ``is_set()`` protocol.

    `run_supervisor` was written for `threading.Event`; the SCM hands us a raw handle
    from `win32event.CreateEvent`, which has no `is_set()`. Calling it directly raised
    AttributeError inside `SvcDoRun`, so the service logged "starting" and "stopped"
    in the same second and reported error 0x20000001 (S220).
    """

    def __init__(self, handle):
        self._handle = handle

    def is_set(self) -> bool:
        return win32event.WaitForSingleObject(self._handle, 0) == win32event.WAIT_OBJECT_0


if PYWIN32_AVAILABLE:  # pragma: no cover

    class LockdownAgentService(win32serviceutil.ServiceFramework):
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = SERVICE_DISPLAY_NAME
        _svc_description_ = SERVICE_DESCRIPTION

        def __init__(self, args):
            win32serviceutil.ServiceFramework.__init__(self, args)
            self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            log_line("service stop requested")
            win32event.SetEvent(self.hWaitStop)

        def SvcDoRun(self):
            servicemanager.LogInfoMsg(f"{SERVICE_NAME}: starting")
            log_line("service starting")
            acquire_keep_awake()
            try:
                run_supervisor(_StopHandle(self.hWaitStop))
            finally:
                release_keep_awake()
                log_line("service stopped")
                servicemanager.LogInfoMsg(f"{SERVICE_NAME}: stopped")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    if args and args[0] == "debug":
        import threading

        stop = threading.Event()
        try:
            run_supervisor(stop)
        except KeyboardInterrupt:
            stop.set()
        return 0

    if not PYWIN32_AVAILABLE:
        print(
            "pywin32 is required to run as a Windows service (pip install pywin32). "
            "Use 'service_host.py debug' to run in the foreground.",
            file=sys.stderr,
        )
        return 2

    # The SCM starts the executable with no arguments at all, so a frozen build must
    # treat the empty case as service mode. (Run `debug` by hand for a foreground
    # session; a source checkout with no arguments prints usage instead of pretending.)
    if (not args and getattr(sys, "frozen", False)) or (args and args[0] == "--service"):
        # What the SCM launches. `python.exe script.py` does not speak to the Service
        # Control Manager by itself — pythonservice.exe normally does this — so the
        # dispatcher must be started here or `sc start` fails with a service that
        # immediately stops (S220).
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(LockdownAgentService)
        servicemanager.StartServiceCtrlDispatcher()
        return 0

    win32serviceutil.HandleCommandLine(LockdownAgentService)  # pragma: no cover
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
