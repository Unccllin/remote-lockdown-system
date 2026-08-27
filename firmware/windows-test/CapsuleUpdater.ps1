<#
.SYNOPSIS
    UEFI Capsule Updater — submits a capsule file to the firmware for processing on next reboot.

.DESCRIPTION
    This script reads a UEFI capsule file (.cap) and submits it to the firmware
    via the SetFirmwareEnvironmentVariableExW API. On the next reboot, the
    firmware processes the capsule and flashes the payload.

    Used to deliver the Anti-Theft DXE driver to the firmware volume.

.PARAMETER CapsuleFile
    Path to the UEFI capsule file (.cap)

.PARAMETER Reboot
    If specified, triggers a system reboot after submitting the capsule.

.EXAMPLE
    .\CapsuleUpdater.ps1 -CapsuleFile AntiTheft.cap
    .\CapsuleUpdater.ps1 -CapsuleFile AntiTheft.cap -Reboot

.REQUIREMENTS
    - Windows 8+ with UEFI firmware
    - Administrator privileges (SeSystemEnvironmentPrivilege)
    - System must boot in UEFI mode (not Legacy/CSM)
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$CapsuleFile,

    [switch]$Reboot
)

# --- UEFI Capsule GUID: {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A} ---
$CapsuleGuid = [Guid]"6DCBD5ED-E82D-4C44-BDA1-7194199AD92A"

# --- P/Invoke signatures ---
$Signature = @"
using System;
using System.Runtime.InteropServices;

public class UefiFirmware
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LUID
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID_AND_ATTRIBUTES
    {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_PRIVILEGES
    {
        public uint PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges, ref TOKEN_PRIVILEGES NewState, uint Zero, IntPtr Null1, IntPtr Null2);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SetFirmwareEnvironmentVariableExW(
        string lpName,
        Guid lpGuid,
        byte[] pBuffer,
        uint nSize,
        uint dwAttributes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ExitWindowsEx(uint uFlags, uint dwReason);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    public const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    public const string SE_SYSTEM_ENVIRONMENT_NAME = "SeSystemEnvironmentPrivilege";
    public const string SE_SHUTDOWN_NAME = "SeShutdownName";
    public const uint EWX_REBOOT = 0x00000002;
    public const uint EWX_FORCE = 0x00000004;
    public const uint EFI_VARIABLE_NON_VOLATILE = 0x01;
    public const uint EFI_VARIABLE_BOOTSERVICE_ACCESS = 0x02;
    public const uint EFI_VARIABLE_RUNTIME_ACCESS = 0x04;
}
"@

Add-Type -TypeDefinition $Signature

function Enable-Privilege {
    param([string]$PrivilegeName)

    $luid = New-Object UefiFirmware+LUID
    $tkp = New-Object UefiFirmware+TOKEN_PRIVILEGES

    $hToken = [IntPtr]::Zero
    if (-not [UefiFirmware]::OpenProcessToken(
        [UefiFirmware]::GetCurrentProcess(),
        [UefiFirmware]::TOKEN_ADJUST_PRIVILEGES -bor [UefiFirmware]::TOKEN_QUERY,
        [ref]$hToken)) {
        Write-Host "[ERROR] OpenProcessToken failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" -ForegroundColor Red
        return $false
    }

    if (-not [UefiFirmware]::LookupPrivilegeValue($null, $PrivilegeName, [ref]$luid)) {
        Write-Host "[ERROR] LookupPrivilegeValue failed for $PrivilegeName" -ForegroundColor Red
        [UefiFirmware]::CloseHandle($hToken) | Out-Null
        return $false
    }

    $tkp.PrivilegeCount = 1
    $tkp.Privileges.Luid = $luid
    $tkp.Privileges.Attributes = [UefiFirmware]::SE_PRIVILEGE_ENABLED

    $result = [UefiFirmware]::AdjustTokenPrivileges($hToken, $false, [ref]$tkp, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [UefiFirmware]::CloseHandle($hToken) | Out-Null

    if (-not $result) {
        Write-Host "[ERROR] AdjustTokenPrivileges failed: $err" -ForegroundColor Red
        return $false
    }

    if ($err -eq 1300) {  # ERROR_NOT_ALL_ASSIGNED
        Write-Host "[ERROR] $PrivilegeName not held. Run as Administrator." -ForegroundColor Red
        return $false
    }

    return $true
}

# --- Main ---

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  UEFI Capsule Updater" -ForegroundColor Cyan
Write-Host "  Anti-Theft Firmware Agent Delivery" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Enable privileges
Write-Host "[1] Enabling SeSystemEnvironmentPrivilege..." -ForegroundColor Yellow
if (-not (Enable-Privilege "SeSystemEnvironmentPrivilege")) {
    Write-Host "`n[FAIL] Cannot enable required privilege." -ForegroundColor Red
    exit 1
}
Write-Host "    [OK] Privilege enabled" -ForegroundColor Green
Write-Host ""

# Step 2: Read capsule file
Write-Host "[2] Reading capsule file: $CapsuleFile" -ForegroundColor Yellow
if (-not (Test-Path $CapsuleFile)) {
    Write-Host "`n[FAIL] File not found: $CapsuleFile" -ForegroundColor Red
    exit 1
}
$capsuleData = [System.IO.File]::ReadAllBytes($CapsuleFile)
Write-Host "    [OK] Read $($capsuleData.Length) bytes" -ForegroundColor Green
Write-Host ""

# Step 3: Submit capsule
Write-Host "[3] Submitting capsule to UEFI firmware..." -ForegroundColor Yellow
Write-Host "    Capsule GUID: {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A}" -ForegroundColor Gray

$attributes = [UefiFirmware]::EFI_VARIABLE_NON_VOLATILE -bor [UefiFirmware]::EFI_VARIABLE_BOOTSERVICE_ACCESS -bor [UefiFirmware]::EFI_VARIABLE_RUNTIME_ACCESS

$result = [UefiFirmware]::SetFirmwareEnvironmentVariableExW(
    "CapsuleUpdateData",
    $CapsuleGuid,
    $capsuleData,
    $capsuleData.Length,
    $attributes)

if (-not $result) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "`n[ERROR] SetFirmwareEnvironmentVariableExW failed: $err" -ForegroundColor Red
    switch ($err) {
        1314 { Write-Host "        SeSystemEnvironmentPrivilege not held. Run as Administrator." -ForegroundColor Gray }
        120 { Write-Host "        System does not support UEFI firmware variables." -ForegroundColor Gray; Write-Host "        Ensure the system boots in UEFI mode (not Legacy/CSM)." -ForegroundColor Gray }
        122 { Write-Host "        Capsule too large for NVRAM." -ForegroundColor Gray }
        default { Write-Host "        Error code: $err" -ForegroundColor Gray }
    }
    exit 1
}

Write-Host "    [OK] Capsule submitted to firmware!" -ForegroundColor Green
Write-Host "    The capsule will be processed on the next reboot." -ForegroundColor Green
Write-Host ""

# Step 4: Reboot
if ($Reboot) {
    Write-Host "[4] Rebooting system..." -ForegroundColor Yellow
    if (-not (Enable-Privilege "SeShutdownName")) {
        Write-Host "    [WARN] Cannot enable shutdown privilege. Reboot manually." -ForegroundColor Yellow
    } else {
        [UefiFirmware]::ExitWindowsEx([UefiFirmware]::EWX_REBOOT -bor [UefiFirmware]::EWX_FORCE, 0) | Out-Null
    }
} else {
    Write-Host "[4] Reboot required to process capsule." -ForegroundColor Yellow
    Write-Host "    Run: shutdown /r /t 0" -ForegroundColor Gray
    Write-Host "    Or reboot manually." -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Capsule Update Complete" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
