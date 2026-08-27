# UEFI Capsule Update — Hardware Test Instructions

## Overview

This document describes how to test the UEFI capsule update on a real target
machine (HP laptop or other UEFI-based PC). The capsule delivers the Anti-Theft
DXE driver into the firmware volume, where it runs on every boot before the OS.

## What the capsule does

```
Windows OS                    UEFI Firmware                 SPI Flash
─────────────                 ──────────────                ─────────
1. Run CapsuleUpdater
   with AntiTheft.cap
                ────────────▶
                              2. Store capsule in
                                 NVRAM/variable
                ────────────▶
                              3. On next reboot:
                                 Parse capsule
                                 Verify signature
                                 Flash DXE driver ────────▶ 4. Write to
                                                              firmware volume
                                                              (persists forever)
                              5. Continue boot
                                 DXE driver runs ◀────────  6. Load from
                                    │                         flash on every
                                    ▼                         boot
                              7. Set NVRAM vars:
                                 AgentInstalled=1
                                 AgentState=DORMANT
                              8. OS boots normally
```

## Prerequisites

1. **Target machine**: UEFI-based PC (HP, Dell, Lenovo, etc.)
   - Must boot in UEFI mode (not Legacy/CSM)
   - Must support UEFI capsule updates (most 2015+ machines do)
2. **Windows**: Windows 8 or later (for SetFirmwareEnvironmentVariableExW API)
3. **Administrator privileges**: Required for firmware variable access
4. **Capsule signing key**: For production, the key must be enrolled in the
   target's BIOS. For testing, use the unsigned capsule or enroll the
   self-signed test key.

## Files to transfer to the target machine

From this project, copy these files to a USB drive:

```
capsule-output/
├── AntiTheft.cap              # Signed capsule (18,968 bytes)
├── AntiTheft_unsigned.cap     # Unsigned capsule (16,496 bytes)
├── capsule_signer.crt         # Signing certificate (for key enrollment)
└── trusted_public_cert.pem    # Trusted cert (for key enrollment)

windows-test/
├── CapsuleUpdater.c           # C source (build with MSVC or MinGW)
└── CapsuleUpdater.ps1         # PowerShell script (no compiler needed)
```

## Step-by-step: Testing with PowerShell (easiest)

### Step 1: Copy files to target machine

Copy `CapsuleUpdater.ps1` and `AntiTheft.cap` (or `AntiTheft_unsigned.cap`)
to the target machine (e.g., `C:\AntiTheft\`).

### Step 2: Open PowerShell as Administrator

```powershell
# Right-click Start → "Windows PowerShell (Admin)"
# Or:
Start-Process powershell -Verb RunAs
```

### Step 3: Run the capsule updater

```powershell
cd C:\AntiTheft

# For unsigned capsule (testing — no signature verification needed):
.\CapsuleUpdater.ps1 -CapsuleFile AntiTheft_unsigned.cap

# For signed capsule (requires key enrollment in BIOS):
.\CapsuleUpdater.ps1 -CapsuleFile AntiTheft.cap

# To auto-reboot after submitting:
.\CapsuleUpdater.ps1 -CapsuleFile AntiTheft.cap -Reboot
```

Expected output:
```
========================================
  UEFI Capsule Updater
  Anti-Theft Firmware Agent Delivery
========================================

[1] Enabling SeSystemEnvironmentPrivilege...
    [OK] Privilege enabled

[2] Reading capsule file: AntiTheft.cap
    [OK] Read 18968 bytes

[3] Submitting capsule to UEFI firmware...
    Capsule GUID: {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A}
    [OK] Capsule submitted to firmware!
    The capsule will be processed on the next reboot.

[4] Reboot required to process capsule.
    Run: shutdown /r /t 0
    Or reboot manually.

========================================
  Capsule Update Complete
========================================
```

### Step 4: Reboot

```powershell
shutdown /r /t 0
```

### Step 5: Observe boot process

During boot (before Windows loads), you should see:

```
========================================
  Anti-Theft Firmware Agent
  Version: 0.1.0
  Delivered via: UEFI Capsule Update
========================================

[OK] AgentInstalled variable set in NVRAM
[OK] AgentVersion variable set in NVRAM
[INFO] AgentState not found — creating as DORMANT
[OK] AgentState created: DORMANT (0)

[OK] Agent installation verified in NVRAM
     The agent will run on every boot.
     It survives OS reinstalls and disk replacements.

========================================
  Anti-Theft Agent initialization complete
========================================
```

Note: On many laptops, UEFI output is not visible on the screen. Check
the capsule result by reading UEFI variables from Windows (see Step 6).

### Step 6: Verify from Windows

After boot, run this PowerShell to check if the agent was installed:

```powershell
# Read UEFI variables set by the anti-theft agent
$Guid = [Guid]"A1B2C3D4-E5F6-4789-ABCD-EF0123456789"

# Check AgentInstalled
$installed = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\SecureBoot\State" -ErrorAction SilentlyContinue
# Or use the firmware variable API (see ModifyNvram.ps1 for example)

Write-Host "AgentInstalled: $installed"
```

Alternatively, check the Windows Event Log for capsule update events:
```powershell
Get-WinEvent -LogName "Microsoft-Windows-Kernel-PnP/Configuration" |
    Where-Object { $_.Message -like "*capsule*" -or $_.Message -like "*firmware*" } |
    Select-Object -First 5 TimeCreated, Message
```

## Step-by-step: Testing with C tool (if you have a compiler)

### Build CapsuleUpdater.exe

```cmd
REM With MSVC:
cl CapsuleUpdater.c /Fe:CapsuleUpdater.exe

REM With MinGW:
gcc CapsuleUpdater.c -o CapsuleUpdater.exe -lkernel32
```

### Run

```cmd
CapsuleUpdater.exe AntiTheft.cap --reboot
```

## Troubleshooting

### "SeSystemEnvironmentPrivilege not held"
- Run PowerShell as Administrator
- On some systems, this privilege is only held by SYSTEM account.
  Use `PsExec -s` to run as SYSTEM: `psexec -s powershell`

### "System does not support UEFI firmware variables"
- Ensure the system boots in UEFI mode (not Legacy/CSM)
- Check in BIOS: disable CSM, enable UEFI
- Run `bcdedit /enum {current}` and verify `path` points to `.efi`

### Capsule rejected by firmware (signed capsule)
- The signing key must be enrolled in the BIOS
- For HP: use HP BIOS Configuration Utility to enroll the key
- For testing: use the unsigned capsule (AntiTheft_unsigned.cap)
- Note: Some firmware requires signed capsules and will reject unsigned ones

### Capsule processed but agent doesn't appear
- Check if the firmware supports FMP (Firmware Management Protocol)
- Some OEMs only accept capsules through their own update tools
- Try using the OEM's BIOS update utility to deliver the capsule

### How to enroll the signing key

For HP machines:
1. Boot into BIOS (F10 on startup)
2. Security → Secure Boot Configuration → Key Management
3. Import the signing certificate (capsule_signer.crt)
4. Save and reboot

For other OEMs, the process varies. Check the manufacturer's documentation
for "Secure Boot key enrollment" or "Platform Key replacement".

## QEMU Test (for development)

To test without real hardware, run the build script:

```bash
cd firmware
bash build-capsule-test.sh
```

This builds everything and boots QEMU/OVMF to verify the capsule format,
payload extraction, and DXE driver execution.

## File Summary

| File | Purpose | Size |
|------|---------|------|
| `AntiTheftFmpDxe.efi` | DXE driver (capsule payload) | 16,384 bytes |
| `AntiTheft.cap` | Signed capsule | 18,968 bytes |
| `AntiTheft_unsigned.cap` | Unsigned capsule | 16,496 bytes |
| `CapsuleLoader.efi` | UEFI app to process capsule | 20,480 bytes |
| `CapsuleUpdater.ps1` | Windows PowerShell updater | ~5 KB |
| `CapsuleUpdater.c` | Windows C updater source | ~8 KB |
| `capsule_signer.key` | Private signing key | 1,704 bytes |
| `capsule_signer.crt` | Signing certificate | 1,245 bytes |
