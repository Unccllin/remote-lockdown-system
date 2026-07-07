# install_watchdog_service.ps1
# Run as Administrator — installs the watchdog as a Windows service.
# The watchdog monitors the agent and restarts it if it freezes or crashes.
# Install AFTER install_service.ps1.

param(
    [string]$ServiceName  = "LockdownWatchdog",
    [string]$DisplayName  = "Remote Device Lockdown Watchdog",
    [string]$Description  = "Monitors the Lockdown Agent and restarts it if unresponsive.",
    [string]$NSSMPath     = "$env:ProgramFiles\nssm\nssm.exe",
    [string]$AgentDir     = $PSScriptRoot,
    [string]$PythonExe    = (Get-Command python -ErrorAction SilentlyContinue).Source
)

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Must be run as Administrator."
    exit 1
}

if (-not (Test-Path $NSSMPath)) {
    Write-Error "NSSM not found. Run install_service.ps1 first."
    exit 1
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    & $NSSMPath stop $ServiceName confirm 2>$null
    & $NSSMPath remove $ServiceName confirm
    Start-Sleep -Seconds 2
}

$WatchdogScript = Join-Path $AgentDir "watchdog.py"
$LogDir = Join-Path $AgentDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

& $NSSMPath install $ServiceName $PythonExe $WatchdogScript
& $NSSMPath set $ServiceName DisplayName  $DisplayName
& $NSSMPath set $ServiceName Description  $Description
& $NSSMPath set $ServiceName AppDirectory $AgentDir
& $NSSMPath set $ServiceName Start        SERVICE_AUTO_START
& $NSSMPath set $ServiceName ObjectName   LocalSystem
& $NSSMPath set $ServiceName AppRestartDelay 5000
& $NSSMPath set $ServiceName AppExit      Default Restart

# Make watchdog depend on the agent service so it starts after
& $NSSMPath set $ServiceName DependOnService LockdownAgent

& $NSSMPath set $ServiceName AppStdout (Join-Path $LogDir "watchdog.log")
& $NSSMPath set $ServiceName AppStderr (Join-Path $LogDir "watchdog_error.log")
& $NSSMPath set $ServiceName AppRotateFiles    1
& $NSSMPath set $ServiceName AppRotateSeconds  86400

& $NSSMPath start $ServiceName

Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "SUCCESS: Watchdog service is running." -ForegroundColor Green
} else {
    Write-Warning "Watchdog installed but may not be running. Check $LogDir"
}
