# register-test-startup.ps1
# Register a Task Scheduler "At log on" trigger for safe dry-run testing
# of the agent's startup-trigger behavior.
#
# This does NOT use NSSM (the production service path). It creates a simple
# Task Scheduler entry that launches the agent with LOCKDOWN_DRY_RUN=1 and
# --startup, so all lock actions are logged but never executed.
#
# USAGE:
#   Right-click PowerShell -> Run as Administrator
#   .\register-test-startup.ps1
#
# TEARDOWN:
#   .\unregister-test-startup.ps1

#Requires -Version 5.1

param(
    [string]$TaskName    = "LockdownAgent-DryRun-Test",
    [string]$AgentDir    = "",      # defaults to two levels up (agent source root)
    [string]$PythonExe   = (Get-Command python -ErrorAction SilentlyContinue).Source,
    [string]$LogDir      = "C:\ProgramData\LockdownAgent",
    [string]$LogFile     = "C:\ProgramData\LockdownAgent\startup-test.log"
)

# ---------------------------------------------------------------------------
# Colored output helpers
# ---------------------------------------------------------------------------
function Write-Step  { param([string]$Msg) Write-Host "[register] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[register][OK] $Msg" -ForegroundColor Green }
function Write-Warn2 { param([string]$Msg) Write-Host "[register][WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail  { param([string]$Msg) Write-Host "[register][ERROR] $Msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
if (-not $AgentDir) {
    $AgentDir = Resolve-Path (Join-Path $PSScriptRoot "..\..").Path
}

$ConfigPath = Join-Path $AgentDir "config.test-startup.json"
$AgentScript = Join-Path $AgentDir "agent.py"

if (-not (Test-Path $AgentScript)) {
    Write-Fail "agent.py not found at: $AgentScript"
    exit 1
}

if (-not (Test-Path $ConfigPath)) {
    Write-Fail "config.test-startup.json not found at: $ConfigPath"
    exit 1
}

if (-not $PythonExe) {
    Write-Fail "Python not found in PATH. Install Python 3.12+ first."
    exit 1
}

Write-Step "Agent dir:   $AgentDir"
Write-Step "Config:      $ConfigPath"
Write-Step "Python:      $PythonExe"
Write-Step "Log file:    $LogFile"

# ---------------------------------------------------------------------------
# Create log directory
# ---------------------------------------------------------------------------
if (-not (Test-Path $LogDir)) {
    Write-Step "Creating log directory: $LogDir"
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# ---------------------------------------------------------------------------
# Remove existing task if present
# ---------------------------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Warn2 "Task '$TaskName' already exists — removing old task."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ---------------------------------------------------------------------------
# Create wrapper batch file
# ---------------------------------------------------------------------------
# Task Scheduler doesn't directly support setting env vars for the task
# process. The "cmd.exe /c set X=1 && python ..." approach doesn't reliably
# propagate the env var to the Python child process. Instead, we write a
# wrapper .bat file that sets the env var and launches Python with output
# redirection. This is the proven working approach.
$wrapperPath = Join-Path $LogDir "run-dry-run.bat"
$wrapperContent = @"
@echo off
set LOCKDOWN_DRY_RUN=1
cd /d "$AgentDir"
"$PythonExe" agent.py --config "$ConfigPath" --startup > "$LogFile" 2>&1
"@
Set-Content -Path $wrapperPath -Value $wrapperContent -Encoding ASCII
Write-Step "Wrapper batch file: $wrapperPath"

# ---------------------------------------------------------------------------
# Build the scheduled task
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction -Execute $wrapperPath

# "At log on" trigger for the current user
$trigger = New-ScheduledTaskTrigger -AtLogOn

# Task settings
$envSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Register the task as the current user (NOT SYSTEM — this is for testing)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $envSettings `
    -Principal $principal `
    -Description "Dry-run test of agent startup-trigger behavior. Safe — no real lock actions." `
    -Force | Out-Null

Write-Ok "Task '$TaskName' registered successfully."
Write-Ok "Trigger: At log on (user: $currentUser)"
Write-Ok "The agent will launch with LOCKDOWN_DRY_RUN=1 on next logon."
Write-Ok "Log output will be written to: $LogFile"
Write-Step ""
Write-Step "To test: log off and log back on (or reboot), then check the log file."
Write-Step "To teardown: run .\unregister-test-startup.ps1"
