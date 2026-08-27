<#
.SYNOPSIS
    AntiTheft Windows Service — UEFI variable bridge.

.DESCRIPTION
    This is a skeleton Windows service that periodically reads the
    AntiTheft UEFI NVRAM variable and reports to the check-in server.

    It demonstrates the production pattern:
    1. Enable SeSystemEnvironmentPrivilege
    2. Read AgentState from UEFI NVRAM
    3. Report to server via HTTP
    4. Write updated state back to UEFI NVRAM (for firmware to read on next boot)

    In production, this would be compiled as a C++ service or implemented
    with NSSM (Non-Sucking Service Manager) wrapping a Python/Node script.

.PARAMETER CheckinUrl
    URL of the check-in server (default: http://localhost:8080/checkin)

.PARAMETER Interval
    Check-in interval in seconds (default: 300 = 5 minutes)

.EXAMPLE
    .\AntiTheftService.ps1 -CheckinUrl "https://server.example.com/checkin" -Interval 60
#>

param(
    [string]$CheckinUrl = "http://localhost:8080/checkin",
    [int]$Interval = 300
)

$VAR_NAME = "AgentState"
$VAR_GUID = "{A1B2C3D4-E5F6-4789-ABCD-EF0123456789}"
$VAR_DEFAULT_ATTRS = 0x07  # NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS

# P/Invoke (same as UefiVarTest.ps1)
$Signature = @"
using System;
using System.Runtime.InteropServices;

public class UefiVars {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint GetFirmwareEnvironmentVariableW(
        string lpName, string lpGuid, byte[] pBuffer, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SetFirmwareEnvironmentVariableExW(
        string lpName, string lpGuid, byte[] pValue, uint nSize, uint dwAttributes);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool LookupPrivilegeValueW(string s, string n, ref long l);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool AdjustTokenPrivileges(IntPtr t, bool d,
        ref TP n, uint b, IntPtr p, IntPtr r);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct TP { public uint c; public LA a; }

    [StructLayout(LayoutKind.Sequential)]
    public struct LA { public long l; public uint a; }
}
"@

Add-Type -TypeDefinition $Signature -Language CSharp

function Enable-Privilege {
    $t = [IntPtr]::Zero
    [void][UefiVars]::OpenProcessToken([UefiVars]::GetCurrentProcess(), 0x28, [ref]$t)
    $l = 0
    [void][UefiVars]::LookupPrivilegeValueW($null, "SeSystemEnvironmentPrivilege", [ref]$l)
    $tp = New-Object UefiVars+TP
    $tp.c = 1
    $tp.a.l = $l
    $tp.a.a = 2  # SE_PRIVILEGE_ENABLED
    [void][UefiVars]::AdjustTokenPrivileges($t, $false, [ref]$tp,
        [Runtime.InteropServices.Marshal]::SizeOf($tp), [IntPtr]::Zero, [IntPtr]::Zero)
    [void][UefiVars]::CloseHandle($t)
}

function Read-UefiVar {
    $buf = New-Object byte[] 1
    $r = [UefiVars]::GetFirmwareEnvironmentVariableW($VAR_NAME, $VAR_GUID, $buf, 1)
    if ($r -eq 0) { return $null }
    return $buf[0]
}

function Write-UefiVar {
    param([byte]$Val)
    $buf = New-Object byte[] 1
    $buf[0] = $Val
    return [UefiVars]::SetFirmwareEnvironmentVariableExW(
        $VAR_NAME, $VAR_GUID, $buf, 1, $VAR_DEFAULT_ATTRS)
}

# === Main loop ===

Enable-Privilege
Write-Host "[AntiTheft] Service started. Check-in URL: $CheckinUrl"
Write-Host "[AntiTheft] Interval: ${Interval}s"

while ($true) {
    try {
        # Read current state from UEFI NVRAM
        $state = Read-UefiVar

        if ($null -eq $state) {
            Write-Host "[AntiTheft] UEFI variable not found — first run"
            $state = 0
            Write-UefiVar -Val 0 | Out-Null
        }

        $stateStr = if ($state -eq 0) { "dormant" } elseif ($state -eq 1) { "activated" } else { "unknown:$state" }
        Write-Host "[AntiTheft] Current state: $stateStr (UEFI NVRAM)"

        # Check in with server
        $body = @{ device_id = $env:COMPUTERNAME; state = $state } | ConvertTo-Json
        try {
            $response = Invoke-RestMethod -Uri $CheckinUrl -Method Post `
                -Body $body -ContentType "application/json" -TimeoutSec 10
            Write-Host "[AntiTheft] Check-in OK: $($response | ConvertTo-Json -Compress)"

            # If server says to activate, write to UEFI NVRAM
            if ($response.action -eq "activate" -and $state -ne 1) {
                Write-UefiVar -Val 1 | Out-Null
                Write-Host "[AntiTheft] Activated — wrote state=1 to UEFI NVRAM"
            }
        } catch {
            Write-Host "[AntiTheft] Check-in failed: $_"
        }
    } catch {
        Write-Host "[AntiTheft] Error: $_"
    }

    Start-Sleep -Seconds $Interval
}
