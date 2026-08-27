============================================================
  Remote Lockdown System - USB Deployment Kit
  Version 2 (2026-08-22)
============================================================

CONTENTS
-------

D:\install.bat              <- Double-click this (as Admin!) to install
D:\lockdown-agent\          <- Agent deployment files
    lockdown-agent.exe      (15.6 MB) The agent (PyInstaller, standalone)
    service-installer.exe   (7.4 MB)  Watchdog installer (standalone)
    config.json             Agent config (server URL, API key, poll interval)
    hp_model_overrides.json HP-specific BIOS settings
    run-agent.bat           Manual run script (for testing)
    README.txt              Original deployment readme
    service_installer.py    Python source (reference only, exe is standalone)
D:\UEFI\                    <- UEFI apps for firmware-level lockdown
    SimpleLoader.efi        UEFI boot loader (chainloads other apps)
    AntiTheftAgent.efi      Firmware-level check-in agent
    SetLockdown.efi         UEFI lockdown setter
    Shell.efi               UEFI Shell (for manual loading)

E:\                         <- Rufus boot partition (read-only, full)
    EFI\Boot\bootx64.efi    Rufus UEFI:NTFS boot manager


QUICK START (Windows agent install)
-----------------------------------

1. Insert this USB into the target Windows machine
2. Open File Explorer, navigate to D:\
3. Right-click install.bat -> "Run as administrator"
4. The script will:
   - Copy the agent to C:\ProgramData\LockdownAgent\
   - Create test folders at C:\LockdownTest\SecureData\
   - Install the watchdog (scheduled task + registry run key)
   - Launch the agent immediately
   - Verify everything is running
5. The agent checks in with the server every 10 seconds
6. Use the dashboard to "Flag as Stolen" to trigger lockdown

That's it. The agent is now installed and will:
   - Auto-start on boot (scheduled task)
   - Auto-restart if killed (watchdog every 5 minutes)
   - Start at logon (registry run key backup)
   - Encrypt its state file with DPAPI (LDS1 magic header)


UEFI FIRMWARE LOCKDOWN (optional, advanced)
-------------------------------------------

For firmware-level lockdown (survives disk wipe/OS reinstall):

1. Boot the machine into UEFI Shell (from BIOS boot menu, or use
   a separate FAT32 USB with Shell.efi as EFI\Boot\BootX64.efi)
2. From the UEFI Shell, load the apps from the USB:
   Shell> fs0:
   fs0:\> cd UEFI
   fs0:\UEFI> SimpleLoader.efi

SimpleLoader will chainload:
   - AntiTheftAgent.efi  (firmware check-in to server)
   - SetLockdown.efi     (set UEFI lockdown variables in NVRAM)

Note: E: on this USB is too small to hold the UEFI apps.
To boot directly, copy D:\UEFI\* to a separate small FAT32 USB
as EFI\Boot\BootX64.efi (rename SimpleLoader.efi to BootX64.efi).


VERIFYING INSTALLATION
----------------------

After running install.bat, verify:

1. Agent is running:
   tasklist /FI "IMAGENAME eq lockdown-agent.exe"

2. Watchdog scheduled task exists:
   schtasks /Query /TN "SystemHealthMonitor"

3. Registry run key exists:
   reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v SystemHealthMonitor

4. Deadman file is encrypted (LDS1 magic header):
   powershell -Command "Get-Content C:\ProgramData\LockdownAgent\.deadman -Encoding Byte -TotalCount 4"
   (Should show: 76 68 83 49 = "LDS1")

5. Fail-secure test (optional, triggers lockdown!):
   - Delete the sentinel: del C:\ProgramData\LockdownAgent\.locked
   - The agent should re-assert the lock on next check-in


UNINSTALL
---------

Run: C:\ProgramData\LockdownAgent\service-installer.exe uninstall

This removes:
   - The scheduled task
   - The registry run key
   - Kills the running agent

Manual cleanup:
   rmdir /s /q C:\ProgramData\LockdownAgent
   rmdir /s /q C:\LockdownTest


TROUBLESHOOTING
---------------

Q: "Cannot reach server" error
A: Ensure the server machine is on and both machines are on the same
   network. Check config.json for the correct server_url.

Q: Agent not running after install
A: Check Task Scheduler for "SystemHealthMonitor". The watchdog runs
   every 5 minutes and will relaunch the agent. Or reboot.

Q: "Access denied" error
A: You must run install.bat as Administrator. Right-click -> Run as admin.

Q: BCD / UEFI lockdown failed
A: The agent must run as admin for BCD lockdown. For HP UEFI lockdown,
   check if the HP WMI BIOS interface is available:
   PowerShell: Get-WmiObject -Namespace root\HP -Class HP_BIOSSetting

Q: Deadman file not encrypted
A: The agent encrypts on first write. If the file is still plaintext,
   the agent may be running in fallback mode (non-Windows or DPAPI
   unavailable). Check the agent logs.


FILES INSTALLED ON TARGET MACHINE
---------------------------------

C:\ProgramData\LockdownAgent\
    lockdown-agent.exe        The agent
    config.json               Configuration
    hp_model_overrides.json   HP BIOS overrides
    .deadman                  Encrypted state file (LDS1 header)
    .locked                   Lock sentinel file

C:\LockdownTest\SecureData\   Test files for encryption

Scheduled Task: SystemHealthMonitor (runs every 5 min as SYSTEM)
Registry Key: HKLM\...\Run\SystemHealthMonitor (backup at logon)
