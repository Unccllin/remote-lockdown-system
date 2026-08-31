"""
lock_screen.py — Fullscreen lock screen overlay for Windows.

Creates a topmost, fullscreen, input-blocking window that covers the entire
desktop. The window:
  - Covers all monitors (virtual screen bounds)
  - Always stays on top (HWND_TOPMOST)
  - Blocks Alt+Tab (via RegisterHotKey for all modifier combos)
  - Disables Task Manager (via registry)
  - Shows a "THIS DEVICE HAS BEEN REPORTED STOLEN" banner
  - Cannot be closed by the user (no close button, intercepts Alt+F4)
  - Re-asserts itself if focus is lost

The lock screen runs in a separate process (not a thread) so it can't be
killed by terminating the agent's main process. The agent's lock guardian
relaunches it if it's killed.

Usage:
    lock_screen.exe               # Show lock screen (standalone)
    lock_screen.exe --unlock      # Remove lock screen
    lock_screen.exe --test        # Test mode (press ESC to close)

Build:
    pyinstaller lock_screen.spec --noconfirm
"""

import argparse
import ctypes
import ctypes.wintypes
import os
import platform
import subprocess
import sys
import threading
import time
from pathlib import Path

# Win32 constants
HWND_TOPMOST = -1
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_SHOWWINDOW = 0x0040
SWP_NOACTIVATE = 0x0010
WS_EX_TOPMOST = 0x00000008
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_SYSMENU = 0x00080000
CS_HREDRAW = 0x0002
CS_VREDRAW = 0x0001
WM_DESTROY = 0x0002
WM_PAINT = 0x000F
WM_CLOSE = 0x0010
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_SYSKEYDOWN = 0x0104
VK_ESCAPE = 0x1B
VK_TAB = 0x09
VK_MENU = 0x12  # Alt
VK_CONTROL = 0x11
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_DELETE = 0x2E
COLOR_WINDOW = 5
WHITE_BRUSH = 0
BLACK_BRUSH = 4

# Registry key to disable Task Manager
TASKMGR_KEY = r"Software\Microsoft\Windows\CurrentVersion\Policies\System"
TASKMGR_VALUE = "DisableTaskMgr"

# Lock file — agent checks this to know if lock screen is running
LOCK_FILE = (
    Path(os.environ.get("PROGRAMDATA", "C:\\ProgramData")) / "LockdownAgent" / ".lock_screen_active"
)


def _is_windows() -> bool:
    return platform.system() == "Windows"


def _disable_task_manager(disable: bool) -> None:
    """Enable or disable Task Manager via registry."""
    if not _is_windows():
        return
    try:
        import winreg

        key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, TASKMGR_KEY)
        winreg.SetValueEx(key, TASKMGR_VALUE, 0, winreg.REG_DWORD, 1 if disable else 0)
        winreg.CloseKey(key)
    except (OSError, PermissionError) as e:
        print(f"Warning: Could not modify Task Manager registry: {e}", file=sys.stderr)


def _block_keys() -> None:
    """Register hotkeys to block Alt+Tab, Win+Tab, Win+D, etc."""
    if not _is_windows():
        return
    # Block common escape combos
    combos = [
        (0x0001, 0x09),  # Alt+Tab
        (0x0001, 0x1B),  # Alt+Esc
        (0x0002, 0x1B),  # Ctrl+Esc
        (0x0008, 0x73),  # Win+F4 (Shift+Win)
        (0x000C, 0x09),  # Ctrl+Win+Tab
    ]
    for mod, vk in combos:
        try:
            ctypes.windll.user32.RegisterHotKey(None, 0, mod, vk)
        except (OSError, ctypes.WinError):
            pass


class LockScreenWindow:
    """Fullscreen topmost window using Win32 API directly."""

    def __init__(self, test_mode: bool = False):
        self.test_mode = test_mode
        self.hwnd = None
        self.hinstance = ctypes.windll.kernel32.GetModuleHandleW(None)
        self._running = False

    def _wnd_proc(self, hwnd, msg, wparam, lparam):
        """Window procedure — handles messages."""
        if msg == WM_PAINT:
            self._paint(hwnd)
            return 0
        elif msg == WM_KEYDOWN or msg == WM_SYSKEYDOWN:
            # Block all keys except ESC in test mode
            if self.test_mode and wparam == VK_ESCAPE:
                ctypes.windll.user32.PostQuitMessage(0)
                return 0
            # Block Alt+Tab, Win+Tab, Ctrl+Esc, Alt+F4
            if wparam in (VK_TAB, VK_MENU, VK_LWIN, VK_RWIN, VK_DELETE):
                return 0
            return 0
        elif msg == WM_CLOSE:
            # Refuse to close (except in test mode)
            if not self.test_mode:
                return 0
            ctypes.windll.user32.PostQuitMessage(0)
            return 0
        elif msg == WM_DESTROY:
            ctypes.windll.user32.PostQuitMessage(0)
            return 0
        return ctypes.windll.user32.DefWindowProcW(hwnd, msg, wparam, lparam)

    def _paint(self, hwnd: int) -> None:
        """Paint the stolen banner on the window."""
        ps = ctypes.wintypes.PAINTSTRUCT()
        hdc = ctypes.windll.user32.BeginPaint(hwnd, ctypes.byref(ps))

        # Get client rect
        rect = ctypes.wintypes.RECT()
        ctypes.windll.user32.GetClientRect(hwnd, ctypes.byref(rect))
        width = rect.right - rect.left
        height = rect.bottom - rect.top

        # Fill background with dark blue
        brush = ctypes.windll.gdi32.CreateSolidBrush(0x00993300)  # dark blue (BGR)
        ctypes.windll.user32.FillRect(hdc, ctypes.byref(rect), brush)
        ctypes.windll.gdi32.DeleteObject(brush)

        # Draw banner text
        font = ctypes.windll.gdi32.CreateFontW(
            48,  # height
            0,
            0,
            0,
            700,  # bold
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            34,  # DEFAULT_CHARSET
            "Arial",
        )
        old_font = ctypes.windll.gdi32.SelectObject(hdc, font)

        # Set text color to white, background transparent
        ctypes.windll.gdi32.SetTextColor(hdc, 0x00FFFFFF)  # white (BGR)
        ctypes.windll.gdi32.SetBkMode(hdc, 1)  # TRANSPARENT

        lines = [
            "THIS DEVICE HAS BEEN REPORTED STOLEN",
            "",
            "Contact your administrator immediately.",
            "",
            "All data has been encrypted.",
        ]

        y = height // 2 - 120
        for line in lines:
            ctypes.windll.user32.DrawTextW(
                hdc,
                line,
                -1,
                ctypes.byref(ctypes.wintypes.RECT(0, y, width, y + 60)),
                0x00000001 | 0x00000004,  # DT_CENTER | DT_VCENTER
            )
            y += 60

        ctypes.windll.gdi32.SelectObject(hdc, old_font)
        ctypes.windll.gdi32.DeleteObject(font)
        ctypes.windll.user32.EndPaint(hwnd, ctypes.byref(ps))

    def create(self) -> bool:
        """Create the fullscreen topmost window."""
        if not _is_windows():
            print("Lock screen is Windows-only", file=sys.stderr)
            return False

        # Register window class
        wc = ctypes.wintypes.WNDCLASS()
        wc.lpfnWndProc = ctypes.WNDPROC(self._wnd_proc)
        wc.hInstance = self.hinstance
        wc.lpszClassName = "LockdownLockScreen"
        wc.style = CS_HREDRAW | CS_VREDRAW
        wc.hCursor = ctypes.windll.user32.LoadCursorW(None, 32512)  # IDC_ARROW
        wc.hbrBackground = ctypes.windll.gdi32.GetStockObject(BLACK_BRUSH)

        if not ctypes.windll.user32.RegisterClassW(ctypes.byref(wc)):
            err = ctypes.windll.kernel32.GetLastError()
            if err != 1410:  # ERROR_CLASS_ALREADY_EXISTS
                print(f"RegisterClass failed: {err}", file=sys.stderr)
                return False

        # Get virtual screen bounds (all monitors)
        x = ctypes.windll.user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        y = ctypes.windll.user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
        width = ctypes.windll.user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
        height = ctypes.windll.user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN

        # Create fullscreen topmost window
        self.hwnd = ctypes.windll.user32.CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,  # topmost, no taskbar
            "LockdownLockScreen",
            "Lockdown",
            WS_POPUP | WS_VISIBLE,
            x,
            y,
            width,
            height,
            None,
            None,
            self.hinstance,
            None,
        )

        if not self.hwnd:
            err = ctypes.windll.kernel32.GetLastError()
            print(f"CreateWindowEx failed: {err}", file=sys.stderr)
            return False

        # Force topmost
        ctypes.windll.user32.SetWindowPos(
            self.hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        )

        # Show and activate
        ctypes.windll.user32.ShowWindow(self.hwnd, 3)  # SW_SHOWMAXIMIZED
        ctypes.windll.user32.SetForegroundWindow(self.hwnd)

        # Block keys
        _block_keys()

        # Disable Task Manager
        _disable_task_manager(True)

        # Write lock file
        try:
            LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
            LOCK_FILE.write_text(str(os.getpid()))
        except OSError:
            pass

        return True

    def run(self) -> None:
        """Message loop — runs until window is destroyed."""
        if not self.create():
            return

        self._running = True

        # Re-assert topmost every 2 seconds in a background thread
        def _reassert():
            while self._running:
                try:
                    ctypes.windll.user32.SetWindowPos(
                        self.hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    )
                    ctypes.windll.user32.SetForegroundWindow(self.hwnd)
                except (OSError, ctypes.WinError):
                    pass
                time.sleep(2)

        t = threading.Thread(target=_reassert, daemon=True)
        t.start()

        # Message loop
        msg = ctypes.wintypes.MSG()
        while ctypes.windll.user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            ctypes.windll.user32.TranslateMessage(ctypes.byref(msg))
            ctypes.windll.user32.DispatchMessageW(ctypes.byref(msg))

        self._running = False

        # Cleanup
        _disable_task_manager(False)
        try:
            LOCK_FILE.unlink(missing_ok=True)
        except OSError:
            pass


def is_running() -> bool:
    """Check if the lock screen process is running."""
    if not _is_windows():
        return False
    try:
        if LOCK_FILE.exists():
            pid = int(LOCK_FILE.read_text().strip())
            # Check if process is alive
            import ctypes

            handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # SYNCHRONIZE
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
    except (OSError, ValueError, TypeError):
        pass
    return False


def launch(test_mode: bool = False) -> None:
    """Launch the lock screen as a separate process.

    When the agent (frozen as lockdown-agent.exe) calls this, it looks for
    the standalone lockdown-lockscreen.exe in the same directory. If that's
    not found (e.g. running from source), it relaunches itself.
    """
    if not _is_windows():
        print("Lock screen is Windows-only", file=sys.stderr)
        return

    if getattr(sys, "frozen", False):
        # We're inside a frozen exe. Check if we ARE the lockscreen exe
        # or the agent exe looking for the lockscreen exe.
        our_name = Path(sys.executable).name.lower()
        if our_name == "lockdown-lockscreen.exe":
            # We are the standalone lockscreen — relaunch ourselves
            exe = Path(sys.executable)
            cmd = [str(exe)]
            if test_mode:
                cmd.append("--test")
        else:
            # We are the agent — look for standalone lockscreen exe
            exe_dir = Path(sys.executable).parent
            lockscreen_exe = exe_dir / "lockdown-lockscreen.exe"
            if lockscreen_exe.exists():
                exe = lockscreen_exe
                cmd = [str(exe)]
                if test_mode:
                    cmd.append("--test")
            else:
                # No standalone exe — relaunch the agent with --lockscreen flag
                # The agent exe includes lock_screen as a hidden import.
                exe = Path(sys.executable)
                cmd = [str(exe), "--lockscreen"]
                if test_mode:
                    cmd.append("--lockscreen-test")

        subprocess.Popen(
            cmd,
            creationflags=subprocess.CREATE_NO_WINDOW
            if hasattr(subprocess, "CREATE_NO_WINDOW")
            else 0,
            close_fds=True,
        )
    else:
        # Running as script — launch ourselves in a new process
        subprocess.Popen(
            [sys.executable, __file__] + (["--test"] if test_mode else []),
            close_fds=True,
        )


def remove() -> None:
    """Kill any running lock screen process and clean up."""
    if not _is_windows():
        return

    # Re-enable Task Manager
    _disable_task_manager(False)

    # Kill lock screen processes
    try:
        subprocess.run(
            ["taskkill", "/F", "/IM", "lockdown-lockscreen.exe"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        pass

    # Also try killing by PID from lock file
    try:
        if LOCK_FILE.exists():
            pid = int(LOCK_FILE.read_text().strip())
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=5)
            LOCK_FILE.unlink(missing_ok=True)
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Lockdown Lock Screen")
    parser.add_argument("--test", action="store_true", help="Test mode (ESC to close)")
    parser.add_argument("--unlock", action="store_true", help="Remove lock screen")
    args = parser.parse_args()

    if args.unlock:
        remove()
        print("Lock screen removed.")
        return

    if not _is_windows():
        print("Lock screen is Windows-only", file=sys.stderr)
        sys.exit(1)

    # If already running, don't launch another
    if is_running() and not args.test:
        print("Lock screen is already running.", file=sys.stderr)
        return

    win = LockScreenWindow(test_mode=args.test)
    win.run()


if __name__ == "__main__":
    main()
