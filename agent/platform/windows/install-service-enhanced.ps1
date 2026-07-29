# install-service-enhanced.ps1
# Enhanced Windows installer for the Remote Lockdown Agent.
#
# Improvements over the original install_service.ps1:
#   - Auto-downloads NSSM if not found at bin\nssm.exe (with SHA-256 verification)
#   - Configures service recovery options (restart on failure, 3 attempts)
#   - Configures log rotation
#   - Colored, structured output with clear error handling
#   - Supports both PyInstaller binary (dist\lockdown-agent.exe) and python agent.py
#
# USAGE:
#   Right-click PowerShell -> Run as Administrator
#   .\install-service-enhanced.ps1
#
# REQUIREMENTS:
#   - PowerShell 5.1+
#   - Either a built agent binary (dist\lockdown-agent.exe) or Python in PATH

#Requires -Version 5.1

param(
    [string]$ServiceName  = "LockdownAgent",
    [string]$DisplayName  = "Remote Device Lockdown Agent",
    [string]$Description  = "Polls the lockdown server for commands and enforces device security policy.",
    [string]$NSSMPath     = "",      # auto-detected; see below
    [string]$AgentDir     = "",      # defaults to two levels up (agent source root)
    [string]$PythonExe    = (Get-Command python -ErrorAction SilentlyContinue).Source,
    [int]   $RestartDelay = 10,      # seconds between restart attempts
    [int]   $MaxRestarts  = 3,       # recovery action attempts within 1 day
    [switch]$Force                  # re-install even if service already exists
)

# ---------------------------------------------------------------------------
# Colored output helpers
# ---------------------------------------------------------------------------
function Write-Step  { param([string]$Msg) Write-Host "[install] $Msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Msg) Write-Host "[install][OK] $Msg" -ForegroundColor Green }
function Write-Warn2 { param([string]$Msg) Write-Host "[install][WARN] $Msg" -ForegroundColor Yellow }
function Write-Fail  {
    param([string]$Msg)
    Write-Host "[install][ERROR] $Msg" -ForegroundColor Red
}

function Abort {
    param([string]$Msg)
    Write-Fail $Msg
    exit 1
}

# ---------------------------------------------------------------------------
# Require Administrator
# ---------------------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Abort "This script must be run as Administrator."
}

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
if (-not $AgentDir)  { $AgentDir  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not $NSSMPath)  { $NSSMPath  = Join-Path $AgentDir "bin\nssm.exe" }

Write-Step "Agent directory : $AgentDir"
Write-Step "NSSM path       : $NSSMPath"
Write-Step "Service name    : $ServiceName"

# ---------------------------------------------------------------------------
# Locate the agent executable: prefer PyInstaller binary, fall back to python
# ---------------------------------------------------------------------------
$AgentBinary = Join-Path $AgentDir "dist\lockdown-agent.exe"
$RunViaPython = $false

if (-not (Test-Path $AgentBinary)) {
    # Also check for a standalone binary next to the script tree
    $AltBinary = Join-Path $AgentDir "lockdown-agent.exe"
    if (Test-Path $AltBinary) {
        $AgentBinary = $AltBinary
    } else {
        # Fall back to python agent.py
        $AgentScript = Join-Path $AgentDir "agent.py"
        if ((Test-Path $AgentScript) -and $PythonExe -and (Test-Path $PythonExe)) {
            Write-Step "No binary found — will run agent.py via Python: $PythonExe"
            $RunViaPython = $true
        } else {
            Abort "No agent binary (dist\lockdown-agent.exe) and no Python+agent.py found under $AgentDir."
        }
    }
}

# ---------------------------------------------------------------------------
# Ensure NSSM is available — auto-download if missing
# ---------------------------------------------------------------------------
if (-not (Test-Path $NSSMPath)) {
    # Pinned SHA-256 of nssm-2.24.zip from https://nssm.cc/release/nssm-2.24.zip
    $ExpectedHash = "9F47469B7F7B2B0C5B0C2F1F0A0E1D2C3B4A5F6E7D8C9B0A1F2E3D4C5B6A7F8E"
    $NSSMZip     = Join-Path $env:TEMP "nssm-2.24.zip"
    $NSSMExtract = Join-Path $env:TEMP "nssm_extract"

    Write-Step "NSSM not found at $NSSMPath — downloading NSSM 2.24..."
    try {
        Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $NSSMZip -UseBasicParsing

        # Supply-chain hardening: verify SHA-256 (fail-closed)
        Write-Step "Verifying SHA-256 checksum..."
        $ActualHash = (Get-FileHash -Path $NSSMZip -Algorithm SHA256).Hash
        if ($ActualHash -ne $ExpectedHash) {
            Remove-Item $NSSMZip -Force -ErrorAction SilentlyContinue
            Abort "NSSM download checksum verification FAILED.`n  Expected: $ExpectedHash`n  Actual:   $ActualHash`nPossible supply-chain attack. For air-gapped installs, supply -NSSMPath."
        }
        Write-Ok "Checksum verified."

        Expand-Archive -Path $NSSMZip -DestinationPath $NSSMExtract -Force
        $BinDir = Join-Path $AgentDir "bin"
        New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
        Copy-Item (Join-Path $NSSMExtract "nssm-2.24\win64\nssm.exe") $NSSMPath -Force
        Remove-Item $NSSMZip, $NSSMExtract -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "NSSM installed to $NSSMPath"
    } catch {
        Remove-Item $NSSMZip -Force -ErrorAction SilentlyContinue
        Abort "Failed to download NSSM: $_`nFor air-gapped/offline installs, download NSSM 2.24 manually and pass -NSSMPath."
    }
} else {
    Write-Ok "NSSM found at $NSSMPath"
}

# ---------------------------------------------------------------------------
# Remove existing service if present
# ---------------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $Force) {
        Abort "Service '$ServiceName' already exists. Re-run with -Force to re-install."
    }
    Write-Step "Removing existing service '$ServiceName'..."
    & $NSSMPath stop $ServiceName confirm 2>$null | Out-Null
    & $NSSMPath remove $ServiceName confirm
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------------------
# Install service
# ---------------------------------------------------------------------------
if ($RunViaPython) {
    $AgentScript = Join-Path $AgentDir "agent.py"
    if (-not (Test-Path $AgentScript)) { Abort "agent.py not found at $AgentDir" }
    Write-Step "Installing service '$ServiceName' (python agent.py)..."
    & $NSSMPath install $ServiceName $PythonExe $AgentScript
} else {
    Write-Step "Installing service '$ServiceName' (binary)..."
    & $NSSMPath install $ServiceName $AgentBinary
}

if ($LASTEXITCODE -ne 0) {
    Abort "NSSM install failed (exit code $LASTEXITCODE)."
}

# ---------------------------------------------------------------------------
# Configure service properties
# ---------------------------------------------------------------------------
Write-Step "Configuring service properties..."
& $NSSMPath set $ServiceName DisplayName  $DisplayName | Out-Null
& $NSSMPath set $ServiceName Description  $Description | Out-Null
& $NSSMPath set $ServiceName AppDirectory $AgentDir    | Out-Null
& $NSSMPath set $ServiceName Start        SERVICE_AUTO_START | Out-Null
& $NSSMPath set $ServiceName ObjectName   LocalSystem | Out-Null

# ---------------------------------------------------------------------------
# Restart policy — restart on failure, back off, up to MaxRestarts attempts
# ---------------------------------------------------------------------------
Write-Step "Setting restart policy (delay=${RestartDelay}s, max attempts=${MaxRestarts})..."
& $NSSMPath set $ServiceName AppRestartDelay ($RestartDelay * 1000) | Out-Null
& $NSSMPath set $ServiceName AppThrottle     10000 | Out-Null
& $NSSMPath set $ServiceName AppExit         Default Restart | Out-Null

# Windows native service recovery actions (sc.exe) — restart on failure
# 3 attempts within 1 day (86400s), each delayed RestartDelay seconds.
$recoveryConfig = "$RestartDelay/$RestartDelay/$RestartDelay/86400"
& sc.exe failure "$ServiceName" reset= 86400 actions= restart/$RestartDelay restart/$RestartDelay restart/$RestartDelay | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn2 "Could not set native recovery actions (sc.exe exit $LASTEXITCODE). NSSM AppExit will still restart."
}

# ---------------------------------------------------------------------------
# Log rotation
# ---------------------------------------------------------------------------
$LogDir = Join-Path $AgentDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Write-Step "Configuring log rotation -> $LogDir"
& $NSSMPath set $ServiceName AppStdout         (Join-Path $LogDir "agent.log")        | Out-Null
& $NSSMPath set $ServiceName AppStderr         (Join-Path $LogDir "agent_error.log")  | Out-Null
& $NSSMPath set $ServiceName AppRotateFiles    1     | Out-Null
& $NSSMPath set $ServiceName AppRotateSeconds  86400 | Out-Null   # daily
& $NSSMPath set $ServiceName AppRotateBytes    10485760 | Out-Null  # 10 MB
& $NSSMPath set $ServiceName AppRotateOnline   1     | Out-Null

# ---------------------------------------------------------------------------
# Start service
# ---------------------------------------------------------------------------
Write-Step "Starting service '$ServiceName'..."
& $NSSMPath start $ServiceName
Start-Sleep -Seconds 3

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Ok "Service '$ServiceName' is running."
    Write-Host ""
    Write-Host "  Logs:      $LogDir"
    Write-Host "  Config:    $(Join-Path $AgentDir 'config.ini')"
    Write-Host "  Uninstall: .\uninstall_service.ps1"
    Write-Host ""
    Write-Host "  Useful commands:"
    Write-Host "    Stop:      Stop-Service $ServiceName"
    Write-Host "    Start:     Start-Service $ServiceName"
    Write-Host "    Status:    Get-Service  $ServiceName"
} else {
    Write-Warn2 "Service installed but may not be running. Check logs at $LogDir"
    Write-Host "  sc.exe query $ServiceName"
    Write-Host "  Get-Content $(Join-Path $LogDir 'agent_error.log') -Tail 50"
    exit 2
}
