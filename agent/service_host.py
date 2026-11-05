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

import os
import subprocess
import sys
import time
from pathlib import Path

SERVICE_NAME = "LockdownAgent"
SERVICE_DISPLAY_NAME = "Lockdown Agent"
SERVICE_DESCRIPTION = "Remote lockdown agent (device policy, EFS, tracking, recovery)."

# Seconds between restart attempts; the last value repeats.
_RESTART_DELAYS = (5, 10, 30, 60)


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


def run_supervisor(stop_event=None) -> int:
    """Start the agent and restart it when it exits, until asked to stop.

    ``stop_event`` is anything with ``is_set()`` (the SCM stop event in service mode,
    or a threading.Event in debug mode).
    """
    attempt = 0
    child: subprocess.Popen | None = None

    while True:
        if stop_event is not None and stop_event.is_set():
            break

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
            while child.poll() is None:
                if stop_event is not None and stop_event.is_set():
                    log_line("stop requested — terminating the agent")
                    child.terminate()
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        child.kill()
                    return 0
                time.sleep(2)
            log_line(f"agent exited with code {child.returncode}")

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

try:  # pragma: no cover - exercised only on Windows
    import servicemanager
    import win32event
    import win32service
    import win32serviceutil

    PYWIN32_AVAILABLE = True
except ImportError:  # pragma: no cover
    PYWIN32_AVAILABLE = False
    # Bind the names anyway: the flag guards every use, but leaving them unbound makes
    # the guard the only thing between a missing dependency and a NameError, and static
    # analysis cannot see that relationship.
    servicemanager = None  # type: ignore[assignment]
    win32event = None  # type: ignore[assignment]
    win32service = None  # type: ignore[assignment]
    win32serviceutil = None  # type: ignore[assignment]


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
            try:
                run_supervisor(_StopHandle(self.hWaitStop))
            finally:
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

    if args and args[0] == "--service":
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
