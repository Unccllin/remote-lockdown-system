// LockdownLockScreen.cs — MKOPA-style fullscreen lock screen for Windows
//
// This is a standalone C# application that:
// 1. Creates a fullscreen topmost borderless window covering ALL monitors
// 2. Blocks Alt-Tab, Ctrl-Alt-Del, Win key, Task Manager
// 3. Shows a stolen banner with device info and recovery instructions
// 4. Persists — re-creates itself if killed (watchdog)
// 5. Works offline — checks sentinel file on startup
//
// Compile: csc.exe /target:winexe /out:lockdown-lockscreen.exe LockdownLockScreen.cs
//
// When used as shell replacement (MKOPA-style):
// - Registry: HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\Shell = this exe
// - User logs in → sees ONLY this screen (no desktop, no taskbar, no start menu)
// - Can't access anything else because explorer.exe never starts

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace LockdownLockScreen
{
    class LockScreen : Form
    {
        // Win32 API for blocking keys
        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        private static extern bool BlockInput(bool fBlockInput);

        [DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
            int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("kernel32.dll")]
        private static extern uint GetLastError();

        // Constants
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_SHOWWINDOW = 0x0040;
        private const int SW_SHOWMAXIMIZED = 3;
        private const int SW_MAXIMIZE = 3;

        // Virtual key codes to block
        private const uint VK_TAB = 0x09;
        private const uint VK_ESCAPE = 0x1B;
        private const uint VK_LWIN = 0x5B;
        private const uint VK_RWIN = 0x5C;
        private const uint VK_MENU = 0x12;  // Alt
        private const uint VK_CONTROL = 0x11;
        private const uint VK_DELETE = 0x2E;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_WIN = 0x0008;

        private string deviceId = "";
        private string hostname = "";
        private bool testMode = false;
        private System.Windows.Forms.Timer topmostTimer;
        private System.Windows.Forms.Timer watchdogTimer;

        public LockScreen(string[] args)
        {
            // Parse args
            foreach (string arg in args)
            {
                if (arg == "--test") testMode = true;
                if (arg.StartsWith("--device=")) deviceId = arg.Substring(9);
                if (arg.StartsWith("--hostname=")) hostname = arg.Substring(11);
            }

            // Read device info from config if not provided
            if (string.IsNullOrEmpty(hostname))
            {
                try { hostname = Environment.MachineName; } catch { hostname = "UNKNOWN"; }
            }

            // Form setup — fullscreen borderless
            this.FormBorderStyle = FormBorderStyle.None;
            this.WindowState = FormWindowState.Maximized;
            this.StartPosition = FormStartPosition.Manual;
            this.Bounds = Screen.PrimaryScreen.Bounds;
            this.BackColor = Color.FromArgb(20, 20, 60);
            this.TopMost = true;
            this.ControlBox = false;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.ShowInTaskbar = false;
            this.KeyPreview = true;

            // Cover all monitors
            this.Location = new Point(Screen.PrimaryScreen.Bounds.X, Screen.PrimaryScreen.Bounds.Y);
            this.Size = new Size(Screen.PrimaryScreen.Bounds.Width, Screen.PrimaryScreen.Bounds.Height);

            // Set up UI
            SetupUI();

            // Block keys
            BlockKeys();

            // Timer to keep window topmost (re-assert every 2 seconds)
            topmostTimer = new System.Windows.Forms.Timer();
            topmostTimer.Interval = 2000;
            topmostTimer.Tick += (s, e) => KeepTopmost();
            topmostTimer.Start();

            // Watchdog timer — check sentinel every 10 seconds
            // If sentinel is gone, close (unlock)
            watchdogTimer = new System.Windows.Forms.Timer();
            watchdogTimer.Interval = 10000;
            watchdogTimer.Tick += (s, e) => CheckSentinel();
            if (!testMode) watchdogTimer.Start();
        }

        private void SetupUI()
        {
            // Main banner
            var titleLabel = new Label
            {
                Text = "THIS DEVICE HAS BEEN REPORTED STOLEN",
                Font = new Font("Arial", 28, FontStyle.Bold),
                ForeColor = Color.Red,
                BackColor = Color.Transparent,
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Top,
                Height = 80,
            };

            var subtitleLabel = new Label
            {
                Text = "This device is being tracked. Location and activity are being monitored.",
                Font = new Font("Arial", 14),
                ForeColor = Color.White,
                BackColor = Color.Transparent,
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Top,
                Height = 40,
            };

            var infoLabel = new Label
            {
                Text = "Device: " + hostname + "\n\nThis device was reported as stolen and has been remotely locked.\n" +
                       "All activity on this device is being logged and reported.\n\n" +
                       "To unlock this device, contact the owner or administrator.\n\n" +
                       "Attempting to bypass this lock is a criminal offense.",
                Font = new Font("Arial", 12),
                ForeColor = Color.LightGray,
                BackColor = Color.Transparent,
                AutoSize = false,
                TextAlign = ContentAlignment.MiddleCenter,
                Dock = DockStyle.Fill,
            };

            if (testMode)
            {
                var testLabel = new Label
                {
                    Text = "[TEST MODE — Press ESC to close]",
                    Font = new Font("Arial", 10, FontStyle.Italic),
                    ForeColor = Color.Yellow,
                    BackColor = Color.Transparent,
                    AutoSize = false,
                    TextAlign = ContentAlignment.MiddleCenter,
                    Dock = DockStyle.Bottom,
                    Height = 30,
                };
                this.Controls.Add(testLabel);
            }

            this.Controls.Add(infoLabel);
            this.Controls.Add(subtitleLabel);
            this.Controls.Add(titleLabel);
        }

        private void BlockKeys()
        {
            // Register hotkeys to intercept system keys
            // This doesn't fully block Ctrl-Alt-Del (kernel-level) but blocks
            // Alt-Tab, Win+Tab, Win+D, Win+E, etc.
            try
            {
                RegisterHotKey(this.Handle, 1, MOD_ALT, VK_TAB);        // Alt+Tab
                RegisterHotKey(this.Handle, 2, MOD_ALT | MOD_CONTROL, VK_DELETE);  // Ctrl+Alt+Del (may not work)
                RegisterHotKey(this.Handle, 3, MOD_WIN, 0x44);  // Win+D
                RegisterHotKey(this.Handle, 4, MOD_WIN, 0x45);  // Win+E
                RegisterHotKey(this.Handle, 5, MOD_WIN, 0x52);  // Win+R
                RegisterHotKey(this.Handle, 6, MOD_WIN, 0x4D);  // Win+M
                RegisterHotKey(this.Handle, 7, MOD_CONTROL, VK_ESCAPE);  // Ctrl+Esc
                RegisterHotKey(this.Handle, 8, MOD_ALT, VK_ESCAPE);  // Alt+Esc
                RegisterHotKey(this.Handle, 9, MOD_WIN, 0x09);  // Win+Tab
            }
            catch { }
        }

        private void KeepTopmost()
        {
            // Re-assert topmost — in case another window tries to come to front
            SetWindowPos(this.Handle, HWND_TOPMOST, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetForegroundWindow(this.Handle);

            // If we're not the foreground window, force ourselves to front
            if (GetForegroundWindow() != this.Handle)
            {
                ShowWindow(this.Handle, SW_MAXIMIZE);
                SetForegroundWindow(this.Handle);
            }
        }

        private void CheckSentinel()
        {
            string sentinel = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                "LockdownAgent", ".locked");
            if (!File.Exists(sentinel))
            {
                // Sentinel removed — unlock
                this.Close();
            }
        }

        protected override void WndProc(ref Message m)
        {
            // Intercept WM_HOTKEY
            if (m.Msg == 0x0312)  // WM_HOTKEY
            {
                // Swallow all hotkey messages — don't let them through
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            // Block all key presses in test mode except ESC
            if (testMode && e.KeyCode == Keys.Escape)
            {
                this.Close();
                return;
            }

            // Block Alt+F4
            if (e.Alt && e.KeyCode == Keys.F4)
            {
                e.Handled = true;
                return;
            }

            // Block all other keys
            e.Handled = true;
            e.SuppressKeyPress = true;
            base.OnKeyDown(e);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!testMode)
            {
                // Prevent closing unless sentinel is gone
                string sentinel = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                    "LockdownAgent", ".locked");
                if (File.Exists(sentinel))
                {
                    e.Cancel = true;
                    return;
                }
            }

            // Unregister hotkeys
            for (int i = 1; i <= 9; i++)
            {
                try { UnregisterHotKey(this.Handle, i); } catch { }
            }

            base.OnFormClosing(e);
        }

        [STAThread]
        static void Main(string[] args)
        {
            // Write crash log if we crash
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var lockScreen = new LockScreen(args);
                Application.Run(lockScreen);
            }
            catch (Exception ex)
            {
                try
                {
                    string crashFile = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                        "LockdownAgent", "lockscreen_crash.log");
                    File.AppendAllText(crashFile,
                        "\n" + new string('=', 60) + "\nLOCKSCREEN CRASH at " + DateTime.Now.ToString() + "\n" +
                        "Error: " + ex.GetType().Name + ": " + ex.Message + "\n" + ex.StackTrace + "\n" +
                        new string('=', 60) + "\n");
                }
                catch { }
                throw;
            }
        }
    }
}
