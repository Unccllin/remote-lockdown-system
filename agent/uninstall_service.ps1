# uninstall_service.ps1
# Run as Administrator to remove the lockdown agent Windows service.

param(
    [string]$ServiceName = "LockdownAgent",
    [string]$NSSMPath    = "$env:ProgramFiles\nssm\nssm.exe"
)

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

if (-not (Test-Path $NSSMPath)) {
    Write-Error "NSSM not found at $NSSMPath"
    exit 1
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Service '$ServiceName' is not installed."
    exit 0
}

Write-Host "Stopping service..."
& $NSSMPath stop $ServiceName confirm

Write-Host "Removing service..."
& $NSSMPath remove $ServiceName confirm

# Remove SafeBoot registry entries (T1: cleanup from install)
$safeBootMinimal = "HKLM:\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\$ServiceName"
$safeBootNetwork  = "HKLM:\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\$ServiceName"
foreach ($key in @($safeBootMinimal, $safeBootNetwork)) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Service '$ServiceName' removed." -ForegroundColor Green
