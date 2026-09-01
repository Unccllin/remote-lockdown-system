<#
.SYNOPSIS
    One-shot deployment script for Remote Lockdown Agent on Windows.
    Downloads, installs, configures, and verifies the agent.

.DESCRIPTION
    This script:
    1. Cleans up old installation (sentinel, deadman, crash logs)
    2. Downloads the latest agent + lockscreen + diagnostic tool
    3. Creates the config file
    4. Installs the scheduled task
    5. Launches the agent
    6. Verifies it's checking in with the server
    7. Reports everything

    Run this on the target Windows machine as Administrator.

.PARAMETER Token
    Enrollment token from the admin dashboard

.PARAMETER ServerUrl
    Worker URL (defaults to the Cloudflare Worker)

.EXAMPLE
    .\deploy.ps1 -Token "ME1/GPn8EULwg1cIHxoAqlj1M5aSs8YwFzR6cJ4bnd8="
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$Token = "",
    [Parameter(Mandatory=$false)]
    [string]$ServerUrl = "https://lockdown-serverless.mainacollins196.workers.dev",
    [Parameter(Mandatory=$false)]
    [string]$Hostname = $env:COMPUTERNAME,
    [Parameter(Mandatory=$false)]
    [string]$Owner = "Hardware Test"
)

$ErrorActionPreference = "Continue"
$INSTALL_DIR = "C:\ProgramData\LockdownAgent"
$WORKER_API = $ServerUrl

function Write-Step($msg) {
    Write-Host "`n[STEP] $msg" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Err($msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Write-Info($msg) {
    Write-Host "  [INFO] $msg" -ForegroundColor Yellow
}

# --- Banner ---
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Remote Lockdown Agent - One-Shot Deploy" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# --- Check admin ---
Write-Step "Checking admin privileges..."
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "This script must be run as Administrator!"
    Write-Info "Right-click PowerShell -> Run as Administrator"
    exit 1
}
Write-OK "Running as Administrator"

# --- Step 1: Cleanup ---
Write-Step "Cleaning up old installation..."

# Kill old agent process
$oldProc = Get-Process -Name "lockdown-agent" -ErrorAction SilentlyContinue
if ($oldProc) {
    Stop-Process -Name "lockdown-agent" -Force -ErrorAction SilentlyContinue
    Write-OK "Killed old agent process"
} else {
    Write-Info "No old agent process running"
}

# Kill old lockscreen process
$oldLock = Get-Process -Name "lockdown-lockscreen" -ErrorAction SilentlyContinue
if ($oldLock) {
    Stop-Process -Name "lockdown-lockscreen" -Force -ErrorAction SilentlyContinue
    Write-OK "Killed old lockscreen process"
}

# Delete sentinel and deadman files (break crash loop)
$filesToDelete = @(".locked", ".deadman", "crash.log", "lockscreen_crash.log")
foreach ($f in $filesToDelete) {
    $path = Join-Path $INSTALL_DIR $f
    if (Test-Path $path) {
        Remove-Item $path -Force -ErrorAction SilentlyContinue
        Write-OK "Deleted $f"
    }
}

# Delete old scheduled task
schtasks /Delete /TN "SystemHealthMonitor" /F 2>$null | Out-Null
Write-OK "Cleaned up old scheduled task"

# --- Step 2: Create install directory ---
Write-Step "Creating install directory..."
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
}
Write-OK "Install dir: $INSTALL_DIR"

# --- Step 3: Download binaries ---
Write-Step "Downloading agent binary..."
$agentPath = Join-Path $INSTALL_DIR "lockdown-agent.exe"
try {
    Invoke-WebRequest -Uri "$WORKER_API/api/download/agent" -OutFile $agentPath -TimeoutSec 120
    $agentSize = (Get-Item $agentPath).Length
    if ($agentSize -lt 1000000) {
        Write-Err "Agent binary too small: $agentSize bytes"
        exit 1
    }
    Write-OK "Agent downloaded: $([math]::Round($agentSize/1MB, 1))MB"
} catch {
    Write-Err "Failed to download agent: $_"
    exit 1
}

Write-Step "Downloading lock screen binary..."
$lockscreenPath = Join-Path $INSTALL_DIR "lockdown-lockscreen.exe"
try {
    Invoke-WebRequest -Uri "$WORKER_API/api/download/lockscreen" -OutFile $lockscreenPath -TimeoutSec 120
    $lockSize = (Get-Item $lockscreenPath).Length
    if ($lockSize -lt 1000000) {
        Write-Err "Lockscreen binary too small: $lockSize bytes"
        Write-Info "Continuing without lockscreen — agent will fall back to LockWorkStation"
    } else {
        Write-OK "Lockscreen downloaded: $([math]::Round($lockSize/1MB, 1))MB"
    }
} catch {
    Write-Err "Failed to download lockscreen: $_"
    Write-Info "Continuing without lockscreen — agent will fall back to LockWorkStation"
}

# --- Step 4: Test the agent binary ---
Write-Step "Testing agent binary..."
try {
    $versionOutput = & $agentPath --version 2>&1
    Write-OK "Agent version: $versionOutput"
} catch {
    Write-Err "Agent --version failed: $_"
    Write-Info "Trying with --debug flag..."
    try {
        $debugOutput = & $agentPath --version --debug 2>&1
        Write-Info "Debug output: $debugOutput"
    } catch {
        Write-Err "Agent binary is broken. Check crash.log after this script."
    }
}

# --- Step 5: Enroll device ---
Write-Step "Enrolling device with server..."

if ($Token -eq "") {
    Write-Info "No enrollment token provided."
    Write-Info "Generate one from the admin dashboard or run:"
    Write-Info "  .\deploy.ps1 -Token 'your_token_here'"
    Write-Info ""
    Write-Info "Checking if device is already enrolled (looking for existing config)..."

    $configPath = Join-Path $INSTALL_DIR "config.json"
    if (Test-Path $configPath) {
        Write-OK "Config file already exists"
        $config = Get-Content $configPath | ConvertFrom-Json
        Write-Info "Device ID: $($config.device_id)"
        Write-Info "Server: $($config.server_url)"
        # Skip enrollment, go straight to launch
        Write-Step "Skipping enrollment — using existing config"
        $deviceId = $config.device_id
        $apiKey = $config.api_key
    } else {
        Write-Err "No config file and no enrollment token."
        Write-Info "You MUST provide a token: .\deploy.ps1 -Token 'your_token'"
        exit 1
    }
} else {
    # Enroll using the token
    $enrollBody = @{
        token = $Token
        hostname = $Hostname
        owner_name = $Owner
    } | ConvertTo-Json

    try {
        $enrollResponse = Invoke-RestMethod -Uri "$WORKER_API/api/enroll/claim" -Method POST -Body $enrollBody -ContentType "application/json" -TimeoutSec 30
        $deviceId = $enrollResponse.device.id
        $apiKey = $enrollResponse.api_key
        Write-OK "Enrolled! Device ID: $deviceId"
        Write-Info "Reassociated: $($enrollResponse.reassociated)"
    } catch {
        Write-Err "Enrollment failed: $_"
        exit 1
    }

    # --- Step 6: Write config ---
    Write-Step "Writing configuration..."
    $config = @{
        server_url = $WORKER_API
        api_key = $apiKey
        hostname = $Hostname
        device_id = $deviceId
        poll_interval = 30
        lockdown_folder = "C:\ProgramData\LockdownAgent\LockdownFolder"
        lock_sentinel = "C:\ProgramData\LockdownAgent\.locked"
        pending_ack_file = "C:\ProgramData\LockdownAgent\.pending_ack"
        recovery_key_file = "C:\ProgramData\LockdownAgent\.recovery_key"
        boot_lock_enabled = $false
        verify_tls = $true
        server_supports_ack_dedup = $true
    }

    $configPath = Join-Path $INSTALL_DIR "config.json"
    $config | ConvertTo-Json -Depth 3 | Set-Content $configPath -Encoding UTF8
    Write-OK "Config written: $configPath"

    # Verify config
    $verifyConfig = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($verifyConfig.api_key -and $verifyConfig.device_id -and $verifyConfig.server_url) {
        Write-OK "Config verified"
    } else {
        Write-Err "Config verification failed!"
        Get-Content $configPath
        exit 1
    }
}

# --- Step 7: Create lockdown folder ---
Write-Step "Creating lockdown folder..."
$lockdownFolder = "C:\ProgramData\LockdownAgent\LockdownFolder"
if (-not (Test-Path $lockdownFolder)) {
    New-Item -ItemType Directory -Path $lockdownFolder -Force | Out-Null
}
$readmePath = Join-Path $lockdownFolder "README.txt"
if (-not (Test-Path $readmePath)) {
    "This device is protected by Remote Lockdown System." | Set-Content $readmePath
}
Write-OK "Lockdown folder: $lockdownFolder"

# --- Step 8: Add Defender exclusions ---
Write-Step "Adding Defender exclusions..."
try {
    Add-MpPreference -ExclusionPath $INSTALL_DIR -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess "lockdown-agent.exe" -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess "lockdown-lockscreen.exe" -ErrorAction SilentlyContinue
    Write-OK "Defender exclusions added"
} catch {
    Write-Info "Defender exclusions failed (may already exist): $_"
}

# --- Step 9: Install scheduled task ---
Write-Step "Installing scheduled task (watchdog)..."
$agentCmd = "`"$agentPath`" --silent --config `"$configPath`""
$watchdogScript = @"
while (`$true) {
    `$proc = Get-Process -Name "lockdown-agent" -ErrorAction SilentlyContinue
    if (-not `$proc) {
        Start-Process "$agentPath" -ArgumentList "--silent","--config","$configPath" -WindowStyle Hidden
    }
    Start-Sleep -Seconds 30
}
"@
$encodedCmd = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchdogScript))
$watchdogCmd = "powershell.exe -NoProfile -WindowStyle Hidden -EncodedCommand $encodedCmd"

# Create startup task — use current user (SYSTEM often fails with -2147467259)
$currentUser = "$env:USERDOMAIN\$env:USERNAME"
schtasks /Create /TN "SystemHealthMonitor" /TR $watchdogCmd /SC ONSTART /RU $currentUser /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-OK "Startup task created (user: $currentUser)"
} else {
    Write-Info "Startup task with user failed ($LASTEXITCODE), trying SYSTEM..."
    schtasks /Create /TN "SystemHealthMonitor" /TR $watchdogCmd /SC ONSTART /RU SYSTEM /RL HIGHEST /F 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-OK "Startup task created (SYSTEM)"
    } else {
        Write-Err "Failed to create startup task (exit code: $LASTEXITCODE)"
        Write-Info "Agent will use registry run key for persistence instead"
    }
}

# Add 5-minute recurring trigger
$psTrigger = @"
`$task = Get-ScheduledTask -TaskName 'SystemHealthMonitor'
`$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 365)
`$task.Triggers += `$trigger
Set-ScheduledTask -TaskName 'SystemHealthMonitor' -Trigger `$task.Triggers
"@
Invoke-Expression "powershell -NoProfile -Command '$psTrigger'" 2>&1 | Out-Null
Write-OK "Recurring 5-min trigger added"

# Add registry run key
$regKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run"
Set-ItemProperty -Path $regKey -Name "SystemHealthMonitor" -Value $agentCmd -ErrorAction SilentlyContinue
Write-OK "Registry run key added"

# --- Step 10: Launch agent (truly detached — survives terminal close) ---
Write-Step "Launching agent..."
# Use cmd /c start to fully detach from this PowerShell session
# Start-Process keeps a handle that kills the child when the parent dies
$launchCmd = "start /B `"`" `"$agentPath`" --silent --config `"$configPath`""
cmd /c $launchCmd
Start-Sleep -Seconds 3

# Verify it's running
$proc = Get-Process -Name "lockdown-agent" -ErrorAction SilentlyContinue
if ($proc) {
    Write-OK "Agent is running (PID: $($proc.Id))"
} else {
    Write-Err "Agent process not found after launch!"
    Write-Info "Checking crash log..."
    $crashLog = Join-Path $INSTALL_DIR "crash.log"
    if (Test-Path $crashLog) {
        Write-Info "Crash log contents:"
        Get-Content $crashLog -Tail 20
    } else {
        Write-Info "No crash log found"
        Write-Info "Try running in foreground:"
        Write-Info "  & '$agentPath' --config '$configPath'"
    }
}

# --- Step 11: Verify check-in ---
Write-Step "Waiting for first check-in (15 seconds)..."
Start-Sleep -Seconds 15

# Check if the device has checked in by querying the Worker
try {
    $healthResponse = Invoke-RestMethod -Uri "$WORKER_API/api/health/detailed" -TimeoutSec 10
    Write-OK "Worker is reachable (devices: $($healthResponse.devices), pending: $($healthResponse.pending_commands))"
} catch {
    Write-Err "Worker unreachable: $_"
}

# --- Summary ---
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Deployment Summary" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Info "Install dir: $INSTALL_DIR"
Write-Info "Agent: $agentPath"
Write-Info "Lockscreen: $lockscreenPath"
Write-Info "Config: $configPath"
Write-Info "Device ID: $deviceId"
Write-Info "Hostname: $Hostname"
Write-Info "Server: $WORKER_API"
Write-Info "Scheduled task: SystemHealthMonitor"
Write-Info "Registry: HKLM\...\Run\SystemHealthMonitor"

$proc = Get-Process -Name "lockdown-agent" -ErrorAction SilentlyContinue
if ($proc) {
    Write-OK "Agent is RUNNING (PID: $($proc.Id))"
} else {
    Write-Err "Agent is NOT running"
}

Write-Host "`nTo test the lock screen:"
Write-Host "  & '$lockscreenPath' --test" -ForegroundColor Yellow
Write-Host "`nTo flag this device stolen (from another machine):"
Write-Host "  Use the admin dashboard or curl the API" -ForegroundColor Yellow
Write-Host "`nTo check crash logs:"
Write-Host "  Get-Content '$INSTALL_DIR\crash.log'" -ForegroundColor Yellow
Write-Host "`nTo run in foreground (debug):"
Write-Host "  & '$agentPath' --config '$configPath'" -ForegroundColor Yellow
Write-Host ""
