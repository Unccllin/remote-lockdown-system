# Test Plan: UEFI Variable Round-Trip (Firmware ↔ Windows)

> **Goal**: Verify that a UEFI variable written by `AntiTheftHello.efi` in firmware
> can be read by a Windows SYSTEM service, and that a variable written by Windows
> can be read by the UEFI firmware on next boot.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SPI Flash (NVRAM)                            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  UEFI Variable: "AgentState"                                 │   │
│  │  GUID: {A1B2C3D4-E5F6-4789-ABCD-EF0123456789}              │   │
│  │  Attributes: NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME    │   │
│  │  Data: 1 byte (0=dormant, 1=activated)                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────────┬──────────────────────┘
               │                              │
     UEFI Runtime Services          UEFI Runtime Services
     (gRT->GetVariable)             (GetFirmwareEnvironmentVariableW)
               │                              │
               ▼                              ▼
   ┌───────────────────┐          ┌──────────────────────────┐
   │ AntiTheftHello.efi │          │ UefiVarTest.exe / .ps1   │
   │ (UEFI DXE app)     │          │ (Windows SYSTEM service) │
   │ Runs at boot       │          │ Runs after OS boot       │
   └───────────────────┘          └──────────────────────────┘
```

---

## Variable Specification

| Field | Value |
|-------|-------|
| Name | `AgentState` |
| GUID | `{A1B2C3D4-E5F6-4789-ABCD-EF0123456789}` |
| Attributes | `0x07` (NON_VOLATILE \| BOOTSERVICE_ACCESS \| RUNTIME_ACCESS) |
| Data size | 1 byte |
| Data values | 0 = dormant, 1 = activated |

---

## Test Cases

### Test 1: QEMU — UEFI Variable Creation and Persistence (VERIFIED)

**Status**: PASS (verified 2026-08-14)

1. Boot QEMU with `AntiTheftHello.efi` as BOOTX64.EFI
2. First boot: variable not found → created with value 0
3. Second boot (same OVMF_VARS.fd): variable found, value 0, all attributes present
4. Raw NVRAM dump confirms variable at offset 0x1990 in OVMF_VARS.fd

**QEMU command**:
```bash
qemu-system-x86_64 \
  -drive if=pflash,format=raw,readonly=on,file=OVMF_CODE.fd \
  -drive if=pflash,format=raw,file=OVMF_VARS.fd \
  -drive format=raw,file=disk.img \
  -nographic -serial mon:stdio -display none -m 256M -nic none
```

**Output** (boot 1):
```
[INFO] AgentState variable not found — first run
       Creating it now with NON_VOLATILE | RUNTIME_ACCESS...
[OK] AgentState variable created successfully
```

**Output** (boot 2):
```
[OK] AgentState variable found: 0
     - NON_VOLATILE (persists across reboots)
     - BOOTSERVICE_ACCESS (accessible pre-OS)
     - RUNTIME_ACCESS (accessible from OS)
```

### Test 2: Windows — Read UEFI Variable (REQUIRES WINDOWS HARDWARE)

**Prerequisites**:
- Windows 10/11 booted in UEFI mode
- Administrator account or SYSTEM service
- `AntiTheftHello.efi` has been run at least once (or variable created by Windows)

**Steps**:
1. Copy `UefiVarTest.ps1` to the Windows machine
2. Open PowerShell as Administrator
3. Run: `.\UefiVarTest.ps1 -Action read`
4. Verify output shows `[OK] AgentState variable read successfully`

**Expected output**:
```
[OK] System is in UEFI mode
[OK] SeSystemEnvironmentPrivilege enabled
[OK] AgentState variable read successfully
     Value: 0 (dormant)
     Size: 1 bytes
     GUID: {A1B2C3D4-E5F6-4789-ABCD-EF0123456789}
```

### Test 3: Windows — Write UEFI Variable (REQUIRES WINDOWS HARDWARE)

**Steps**:
1. Run: `.\UefiVarTest.ps1 -Action write -Value 1`
2. Verify output shows `[OK] AgentState variable written successfully`
3. Reboot the machine
4. Run: `.\UefiVarTest.ps1 -Action read`
5. Verify value is still 1 (persisted across reboot)

### Test 4: Windows — Full Round-Trip Test (REQUIRES WINDOWS HARDWARE)

**Steps**:
1. Run: `.\UefiVarTest.ps1 -Action test`
2. Script will: read original → write test value → read back → verify → restore
3. Verify output shows `[PASS] Round-trip verified`

### Test 5: Cross-Environment — UEFI Writes, Windows Reads (REQUIRES WINDOWS HARDWARE)

**Steps**:
1. Boot machine with USB containing `AntiTheftHello.efi` as `\EFI\BOOT\BOOTX64.EFI`
2. UEFI app creates `AgentState` variable with value 0
3. Boot into Windows
4. Run: `.\UefiVarTest.ps1 -Action read`
5. Verify Windows can read the value 0 written by UEFI

### Test 6: Cross-Environment — Windows Writes, UEFI Reads (REQUIRES WINDOWS HARDWARE)

**Steps**:
1. In Windows: `.\UefiVarTest.ps1 -Action write -Value 1`
2. Reboot machine from USB with `AntiTheftHello.efi`
3. Verify UEFI app reads value 1 (activated)
4. Expected output:
```
[OK] AgentState variable found: 1
     - NON_VOLATILE (persists across reboots)
     - BOOTSERVICE_ACCESS (accessible pre-OS)
     - RUNTIME_ACCESS (accessible from OS)
```

### Test 7: Persistence Across OS Reinstall (REQUIRES WINDOWS HARDWARE + TIME)

**Steps**:
1. Write value 1 from Windows: `.\UefiVarTest.ps1 -Action write -Value 1`
2. Reinstall Windows (full wipe, not reset)
3. Run `UefiVarTest.ps1 -Action read` on fresh Windows install
4. Verify value is still 1 (variable is in SPI flash, not disk)

### Test 8: C Program Build (REQUIRES WINDOWS + MSVC OR MINGW)

**Steps (MSVC)**:
1. Open "x64 Native Tools Command Prompt for VS"
2. `cl /W4 /Fe:UefiVarTest.exe UefiVarTest.c /link advapi32.lib`
3. `UefiVarTest.exe` — should read the variable
4. `UefiVarTest.exe write 1` — should write value 1
5. `UefiVarTest.exe` — should read back value 1

**Steps (MinGW)**:
1. `x86_64-w64-mingw32-gcc -Wall -Wextra -o UefiVarTest.exe UefiVarTest.c -ladvapi32`
2. Same test commands as above

---

## Files

| File | Purpose | Runs on |
|------|---------|---------|
| `firmware/AntiTheftHello/AntiTheftHello.c` | UEFI app: creates/reads AgentState variable | UEFI firmware (QEMU/real HW) |
| `firmware/windows-test/UefiVarTest.c` | C program: reads/writes UEFI variable from Windows | Windows (MSVC/MinGW) |
| `firmware/windows-test/UefiVarTest.ps1` | PowerShell script: same as above, no compiler needed | Windows (PowerShell 5.1+) |
| `firmware/build-uefi.sh` | Build + test script for QEMU side | Linux (build host) |

---

## Known Limitations

1. **Windows doesn't expose `GetNextVariableName()`** to user-mode applications.
   Only known variables (by name + GUID) can be read. Enumeration requires
   a kernel-mode driver or the Chipsec tool.

2. **UEFI variable size limits**: NVRAM has limited space (64KB-256KB total,
   shared with all variables). Keep variable data small.

3. **Secure Boot**: If Secure Boot is enabled, unsigned UEFI applications
   (like `AntiTheftHello.efi`) will not run. The app must be signed with
   a key in the db database, or Secure Boot must be temporarily disabled
   for testing.

4. **Legacy BIOS**: The Win32 firmware variable API returns
   `ERROR_INVALID_FUNCTION` on legacy BIOS systems. The system must be
   booted in UEFI mode.

5. **Privilege**: `SeSystemEnvironmentPrivilege` is required. A service
   running as LocalSystem has this by default. An interactive admin
   process must enable it via `AdjustTokenPrivileges()`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERROR_INVALID_FUNCTION` (1) | Legacy BIOS mode | Boot in UEFI mode |
| `ERROR_PRIVILEGE_NOT_HELD` (1314) | Not admin / privilege not enabled | Run as Admin; script enables privilege automatically |
| `ERROR_FILE_NOT_FOUND` (2) | Variable doesn't exist | Boot `AntiTheftHello.efi` first, or use `write` command |
| `ERROR_NOT_ALL_ASSIGNED` (1300) | Account doesn't have the privilege | Use an account in Administrators group, or SYSTEM |
| Variable not found after reboot | Attributes missing NON_VOLATILE | Ensure attributes = 0x07 (NV \| BS \| RT) |
