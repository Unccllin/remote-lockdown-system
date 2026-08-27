# uninstall_service.ps1
# Run as Administrator to remove the lockdown agent Windows service.
#
# Tamper protection: If the agent was installed with tamper protection
# (file ACLs + registry DENY ACEs), you must provide a server-issued
# uninstall token. Without it, the DENY ACLs will block file deletion.
#
# Usage:
#   .\uninstall_service.ps1 -UninstallToken "TOKEN" -ServerUrl "https://..." -ApiKey "..."
#
# To get a token, run this on the device (or from the dashboard):
#   curl -X POST https://your-server/api/agent/uninstall-auth \
#     -H "X-API-Key: YOUR_AGENT_KEY"

param(
    [string]$ServiceName    = "LockdownAgent",
    [string]$NSSMPath       = "$env:ProgramFiles\nssm\nssm.exe",
    [string]$UninstallToken = "",
    [string]$ServerUrl      = "",
    [string]$ApiKey         = "",
    [string]$DeviceId       = ""
)

# --- Admin check ---
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

# --- Tamper protection: verify uninstall token with server ---
if ($UninstallToken -and $ServerUrl -and $ApiKey) {
    Write-Host "Verifying uninstall token with server..."
    $verifyBody = @{ uninstall_token = $UninstallToken; device_id = $DeviceId } | ConvertTo-Json
    try {
        $response = Invoke-RestMethod -Uri "$ServerUrl/api/agent/uninstall-auth/verify" `
            -Method Post `
            -Headers @{ "X-API-Key" = $ApiKey; "Content-Type" = "application/json" } `
            -Body $verifyBody `
            -TimeoutSec 10
        if (-not $response.authorized) {
            Write-Error "Uninstall token rejected by server. The token may be expired or invalid."
            Write-Error "Request a new token from the server and try again."
            exit 1
        }
        Write-Host "Uninstall token verified." -ForegroundColor Green
    } catch {
        Write-Error "Failed to verify uninstall token: $_"
        Write-Error "Cannot proceed without server authorization."
        exit 1
    }
} elseif ($UninstallToken -eq "") {
    Write-Warning "No uninstall token provided."
    Write-Warning "If tamper protection is active, file deletion will fail."
    Write-Warning "To get a token, run:"
    Write-Warning "  curl -X POST $ServerUrl/api/agent/uninstall-auth -H 'X-API-Key: YOUR_KEY'"
    Write-Host ""
    Write-Host "Proceeding anyway (may fail if ACLs are active)..." -ForegroundColor Yellow
    Write-Host ""
}

# --- Remove tamper protection ACLs (reset to default) ---
$agentPath = "$env:PROGRAMDATA\LockdownAgent\lockdown-agent.exe"
$configPath = "$env:PROGRAMDATA\LockdownAgent\config.json"
$watchdogPath = "$env:PROGRAMDATA\LockdownAgent\lockdown-watchdog.exe"
$stateDir = "$env:PROGRAMDATA\LockdownAgent"

$filesToReset = @($agentPath, $configPath, $watchdogPath)
foreach ($f in $filesToReset) {
    if (Test-Path $f) {
        Write-Host "Resetting ACLs on $f..."
        try {
            icacls $f /reset /q 2>$null | Out-Null
            Write-Host "  ACLs reset." -ForegroundColor Green
        } catch {
            Write-Warning "  Could not reset ACLs on $f (may need manual removal)"
        }
    }
}

# Reset ACLs on state files
$stateFiles = @(".deadman", ".locked", ".heartbeat", ".pending_ack")
foreach ($sf in $stateFiles) {
    $fullPath = Join-Path $stateDir $sf
    if (Test-Path $fullPath) {
        try {
            icacls $fullPath /reset /q 2>$null | Out-Null
        } catch {}
    }
}

# Reset registry DENY ACEs
$regKeys = @(
    "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName",
    "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Schedule\TaskCache\Tree\SystemHealthMonitor"
)
foreach ($key in $regKeys) {
    if (Test-Path $key) {
        try {
            $acl = Get-Acl -Path $key
            $denyRules = $acl.Access | Where-Object {
                $_.AccessControlType -eq "Deny" -and $_.IdentityReference.Value -eq "Everyone"
            }
            foreach ($rule in $denyRules) {
                $acl.RemoveAccessRule($rule) | Out-Null
            }
            Set-Acl -Path $key -AclObject $acl
            Write-Host "Registry DENY ACE removed: $key" -ForegroundColor Green
        } catch {
            Write-Warning "Could not reset registry ACL on $key"
        }
    }
}

# --- Stop and remove NSSM service ---
if (-not (Test-Path $NSSMPath)) {
    Write-Warning "NSSM not found at $NSSMPath — skipping service removal"
} else {
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "Service '$ServiceName' is not installed."
    } else {
        Write-Host "Stopping service..."
        & $NSSMPath stop $ServiceName confirm
        Write-Host "Removing service..."
        & $NSSMPath remove $ServiceName confirm
    }
}

# --- Remove scheduled task ---
$taskName = "SystemHealthMonitor"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "Removing scheduled task '$taskName'..."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Scheduled task removed." -ForegroundColor Green
}

# --- Remove registry run key ---
$runKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
try {
    Remove-ItemProperty -Path $runKey -Name "SystemHealthMonitor" -ErrorAction SilentlyContinue
    Write-Host "Registry run key removed." -ForegroundColor Green
} catch {}

# --- Remove SafeBoot registry entries ---
$safeBootMinimal = "HKLM:\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal\$ServiceName"
$safeBootNetwork  = "HKLM:\SYSTEM\CurrentControlSet\Control\SafeBoot\Network\$ServiceName"
foreach ($key in @($safeBootMinimal, $safeBootNetwork)) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Kill agent process ---
Write-Host "Killing agent process..."
Stop-Process -Name "lockdown-agent" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "lockdown-watchdog" -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Uninstallation complete." -ForegroundColor Green
Write-Host "Service '$ServiceName' removed. Tamper protection ACLs reset."
