# unregister-test-startup.ps1
# Teardown script for the dry-run startup-trigger test.
# Removes the Task Scheduler entry and log file.
#
# USAGE:
#   .\unregister-test-startup.ps1

#Requires -Version 5.1

param(
    [string]$TaskName = "LockdownAgent-DryRun-Test",
    [string]$LogFile  = "C:\ProgramData\LockdownAgent\startup-test.log"
)

function Write-Step  { param([string]$Msg) Write-Host "[teardown] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[teardown][OK] $Msg" -ForegroundColor Green }
function Write-Warn2 { param([string]$Msg) Write-Host "[teardown][WARN] $Msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# Remove the scheduled task
# ---------------------------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Removing scheduled task: $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok "Task removed."
} else {
    Write-Warn2 "Task '$TaskName' not found — nothing to remove."
}

# ---------------------------------------------------------------------------
# Remove the log file
# ---------------------------------------------------------------------------
if (Test-Path $LogFile) {
    Write-Step "Removing log file: $LogFile"
    Remove-Item $LogFile -Force
    Write-Ok "Log file removed."
} else {
    Write-Warn2 "Log file not found: $LogFile"
}

# ---------------------------------------------------------------------------
# Remove the test sentinel if it was created
# ---------------------------------------------------------------------------
$sentinel = "C:\ProgramData\LockdownAgent\.locked"
if (Test-Path $sentinel) {
    Write-Step "Removing test sentinel: $sentinel"
    Remove-Item $sentinel -Force
    Write-Ok "Sentinel removed."
}

Write-Ok "Teardown complete."
