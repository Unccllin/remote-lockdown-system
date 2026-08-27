<#
.SYNOPSIS
    Test UEFI variable read/write from Windows via PowerShell P/Invoke.

.DESCRIPTION
    This script tests that Windows can read and write UEFI NVRAM variables
    using the Win32 firmware environment variable API (via P/Invoke).

    It reads/writes the same variable created by AntiTheftHello.efi:
      Name:       "AgentState"
      GUID:       {A1B2C3D4-E5F6-4789-ABCD-EF0123456789}
      Attributes: NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS (0x07)
      Data:       1-byte UINT8 (0 = dormant, 1 = activated)

.PARAMETER Action
    read      - Read the current AgentState value (default)
    write     - Write a value (requires -Value parameter)
    delete    - Delete the AgentState variable
    test      - Full round-trip test: write, read, verify, restore

.PARAMETER Value
    Value to write (0-255). Used with -Action write or -Action test.

.EXAMPLE
    .\UefiVarTest.ps1
    Reads the current AgentState UEFI variable.

.EXAMPLE
    .\UefiVarTest.ps1 -Action write -Value 1
    Writes value 1 (activated) to the AgentState UEFI variable.

.EXAMPLE
    .\UefiVarTest.ps1 -Action test
    Runs a full round-trip test: writes a test value, reads it back,
    verifies it matches, then restores the original value.

.EXAMPLE
    .\UefiVarTest.ps1 -Action delete
    Deletes the AgentState UEFI variable.

.NOTES
    Must be run as Administrator (or SYSTEM).
    System must be booted in UEFI mode (not legacy BIOS).
#>

param(
    [ValidateSet('read','write','delete','test')]
    [string]$Action = 'read',

    [ValidateRange(0,255)]
    [int]$Value = 0
)

# Win32 API constants
$SE_SYSTEM_ENVIRONMENT_NAME = "SeSystemEnvironmentPrivilege"
$VAR_NON_VOLATILE = 0x00000001
$VAR_BOOTSERVICE_ACCESS = 0x00000002
$VAR_RUNTIME_ACCESS = 0x00000004
$VAR_DEFAULT_ATTRS = $VAR_NON_VOLATILE -bor $VAR_BOOTSERVICE_ACCESS -bor $VAR_RUNTIME_ACCESS

$VarName = "AgentState"
$VarGuid = "{A1B2C3D4-E5F6-4789-ABCD-EF0123456789}"

# P/Invoke definitions
$Signature = @"
using System;
using System.Runtime.InteropServices;

public class UefiVars {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint GetFirmwareEnvironmentVariableW(
        string lpName,
        string lpGuid,
        byte[] pBuffer,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SetFirmwareEnvironmentVariableExW(
        string lpName,
        string lpGuid,
        byte[] pValue,
        uint nSize,
        uint dwAttributes);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(
        IntPtr ProcessHandle,
        uint DesiredAccess,
        out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool LookupPrivilegeValueW(
        string lpSystemName,
        string lpName,
        ref long lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(
        IntPtr TokenHandle,
        bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState,
        uint BufferLength,
        IntPtr PreviousState,
        IntPtr ReturnLength);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID_AND_ATTRIBUTES {
        public LUID Luid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_PRIVILEGES {
        public uint PrivilegeCount;
        public LUID_AND_ATTRIBUTES Privileges;
    }

    public const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    public const uint TOKEN_QUERY = 0x0008;
    public const uint SE_PRIVILEGE_ENABLED = 0x00000002;
    public const uint ERROR_NOT_ALL_ASSIGNED = 1300;
    public const uint ERROR_FILE_NOT_FOUND = 2;
    public const uint ERROR_INVALID_FUNCTION = 1;
    public const uint ERROR_PRIVILEGE_NOT_HELD = 1314;
}
"@

Add-Type -TypeDefinition $Signature -Language CSharp

function Enable-SystemEnvironmentPrivilege {
    <#
    .SYNOPSIS
        Enables SeSystemEnvironmentPrivilege in the current process token.
    #>
    $hToken = [IntPtr]::Zero
    $success = [UefiVars]::OpenProcessToken(
        [UefiVars]::GetCurrentProcess(),
        [UefiVars]::TOKEN_ADJUST_PRIVILEGES -bor [UefiVars]::TOKEN_QUERY,
        [ref]$hToken)

    if (-not $success) {
        Write-Host "[ERROR] OpenProcessToken failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" -ForegroundColor Red
        return $false
    }

    $luid = New-Object UefiVars+LUID
    $success = [UefiVars]::LookupPrivilegeValueW($null, $SE_SYSTEM_ENVIRONMENT_NAME, [ref]$luid)
    if (-not $success) {
        Write-Host "[ERROR] LookupPrivilegeValue failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" -ForegroundColor Red
        [UefiVars]::CloseHandle($hToken) | Out-Null
        return $false
    }

    $tp = New-Object UefiVars+TOKEN_PRIVILEGES
    $tp.PrivilegeCount = 1
    $tp.Privileges.Luid = $luid
    $tp.Privileges.Attributes = [UefiVars]::SE_PRIVILEGE_ENABLED

    $success = [UefiVars]::AdjustTokenPrivileges($hToken, $false, [ref]$tp, [Runtime.InteropServices.Marshal]::SizeOf($tp), [IntPtr]::Zero, [IntPtr]::Zero)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [UefiVars]::CloseHandle($hToken) | Out-Null

    if (-not $success) {
        Write-Host "[ERROR] AdjustTokenPrivileges failed: $err" -ForegroundColor Red
        return $false
    }

    if ($err -eq [UefiVars]::ERROR_NOT_ALL_ASSIGNED) {
        Write-Host "[ERROR] SeSystemEnvironmentPrivilege not held. Run as Administrator." -ForegroundColor Red
        return $false
    }

    Write-Host "[OK] SeSystemEnvironmentPrivilege enabled" -ForegroundColor Green
    return $true
}

function Test-UefiSystem {
    <#
    .SYNOPSIS
        Checks if the system is running in UEFI mode.
    #>
    $buf = New-Object byte[] 4
    $result = [UefiVars]::GetFirmwareEnvironmentVariableW(
        "", "{00000000-0000-0000-0000-000000000000}", $buf, 4)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

    if ($err -eq [UefiVars]::ERROR_INVALID_FUNCTION) {
        return $false
    }
    return $true
}

function Read-AgentState {
    <#
    .SYNOPSIS
        Reads the AgentState UEFI variable.
    #>
    $buf = New-Object byte[] 1
    $result = [UefiVars]::GetFirmwareEnvironmentVariableW($VarName, $VarGuid, $buf, 1)
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

    if ($result -eq 0) {
        if ($err -eq [UefiVars]::ERROR_FILE_NOT_FOUND) {
            Write-Host "[INFO] AgentState variable not found." -ForegroundColor Yellow
            Write-Host "       Boot AntiTheftHello.efi first to create it, or use -Action write."
            return $null
        }
        Write-Host "[ERROR] GetFirmwareEnvironmentVariable failed: $err" -ForegroundColor Red
        return $null
    }

    $value = $buf[0]
    $stateStr = if ($value -eq 0) { "dormant" } elseif ($value -eq 1) { "activated" } else { "unknown" }
    Write-Host "[OK] AgentState variable read successfully" -ForegroundColor Green
    Write-Host "     Value: $value ($stateStr)"
    Write-Host "     Size: $result bytes"
    Write-Host "     GUID: $VarGuid"
    return $value
}

function Write-AgentState {
    param([byte]$Value)

    $buf = New-Object byte[] 1
    $buf[0] = $Value

    $success = [UefiVars]::SetFirmwareEnvironmentVariableExW(
        $VarName, $VarGuid, $buf, 1, $VAR_DEFAULT_ATTRS)

    if (-not $success) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Host "[ERROR] SetFirmwareEnvironmentVariableEx failed: $err" -ForegroundColor Red
        if ($err -eq [UefiVars]::ERROR_PRIVILEGE_NOT_HELD) {
            Write-Host "       SeSystemEnvironmentPrivilege not held. Run as Administrator." -ForegroundColor Yellow
        }
        return $false
    }

    $stateStr = if ($Value -eq 0) { "dormant" } elseif ($Value -eq 1) { "activated" } else { "unknown" }
    Write-Host "[OK] AgentState variable written successfully" -ForegroundColor Green
    Write-Host "     Value: $Value ($stateStr)"
    Write-Host "     Attributes: 0x$($VAR_DEFAULT_ATTRS.ToString('X2')) (NV|BS|RT)"
    Write-Host "     This variable will persist across reboots and OS reinstalls."
    return $true
}

function Delete-AgentState {
    $success = [UefiVars]::SetFirmwareEnvironmentVariableExW(
        $VarName, $VarGuid, $null, 0, $VAR_DEFAULT_ATTRS)

    if (-not $success) {
        $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Host "[ERROR] Delete failed: $err" -ForegroundColor Red
        return $false
    }

    Write-Host "[OK] AgentState variable deleted" -ForegroundColor Green
    return $true
}

function Invoke-RoundTripTest {
    <#
    .SYNOPSIS
        Full round-trip test: save original, write test value, read back,
        verify, restore original.
    #>
    Write-Host "`n=== Round-Trip Test ===" -ForegroundColor Cyan

    # Step 1: Read original value
    Write-Host "`n[1] Reading original value..." -ForegroundColor Cyan
    $original = Read-AgentState

    # Step 2: Write test value (flip the bit)
    $testValue = if ($null -eq $original) { 1 } else { if ($original -eq 0) { 1 } else { 0 } }
    $stateStr = if ($testValue -eq 0) { "dormant" } else { "activated" }
    Write-Host "`n[2] Writing test value: $testValue ($stateStr)..." -ForegroundColor Cyan
    if (-not (Write-AgentState -Value $testValue)) {
        Write-Host "[FAIL] Round-trip test failed at write step" -ForegroundColor Red
        return $false
    }

    # Step 3: Read back and verify
    Write-Host "`n[3] Reading back to verify..." -ForegroundColor Cyan
    $readBack = Read-AgentState
    if ($null -eq $readBack) {
        Write-Host "[FAIL] Could not read back the variable" -ForegroundColor Red
        return $false
    }

    if ($readBack -ne $testValue) {
        Write-Host "[FAIL] Value mismatch! Wrote $testValue, read $readBack" -ForegroundColor Red
        return $false
    }

    Write-Host "[PASS] Round-trip verified: wrote $testValue, read $readBack" -ForegroundColor Green

    # Step 4: Restore original
    if ($null -ne $original) {
        Write-Host "`n[4] Restoring original value: $original..." -ForegroundColor Cyan
        Write-AgentState -Value $original | Out-Null
        Write-Host "[OK] Original value restored" -ForegroundColor Green
    } else {
        Write-Host "`n[4] Deleting test variable (no original to restore)..." -ForegroundColor Cyan
        Delete-AgentState | Out-Null
    }

    Write-Host "`n=== Round-Trip Test: PASS ===" -ForegroundColor Green
    return $true
}

# === Main ===

Write-Host "=== UEFI Variable Test (Windows PowerShell) ===" -ForegroundColor Cyan
Write-Host ""

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[WARN] Not running as Administrator. Privilege enable may fail." -ForegroundColor Yellow
}

# Check UEFI mode
if (-not (Test-UefiSystem)) {
    Write-Host "[ERROR] System is not in UEFI mode (legacy BIOS detected)." -ForegroundColor Red
    Write-Host "        UEFI variable access requires UEFI boot."
    exit 1
}
Write-Host "[OK] System is in UEFI mode" -ForegroundColor Green

# Enable privilege
if (-not (Enable-SystemEnvironmentPrivilege)) {
    exit 1
}

Write-Host ""

# Execute action
switch ($Action) {
    'read' {
        $result = Read-AgentState
        if ($null -eq $result) { exit 1 }
    }
    'write' {
        $result = Write-AgentState -Value $Value
        if (-not $result) { exit 1 }
    }
    'delete' {
        $result = Delete-AgentState
        if (-not $result) { exit 1 }
    }
    'test' {
        $result = Invoke-RoundTripTest
        if (-not $result) { exit 1 }
    }
}
