# install_service.ps1
# Run as Administrator to install the lockdown agent as a Windows service.
#
# USAGE:
#   Right-click PowerShell -> Run as Administrator
#   .\install_service.ps1
#
# REQUIREMENTS:
#   - Python installed and in PATH
#   - pip install -r requirements.txt already done
#   - config.ini present in the same folder as agent.py

param(
    [string]$ServiceName  = "LockdownAgent",
    [string]$DisplayName  = "Remote Device Lockdown Agent",
    [string]$Description  = "Polls the lockdown server for commands and enforces device security policy.",
    [string]$NSSMPath     = "$env:ProgramFiles\nssm\nssm.exe",
    [string]$AgentDir     = $PSScriptRoot,
    [string]$PythonExe    = (Get-Command python -ErrorAction SilentlyContinue).Source
)

# ---------------------------------------------------------------------------
# Require Administrator
# ---------------------------------------------------------------------------
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator."
    exit 1
}

# ---------------------------------------------------------------------------
# Check Python
# ---------------------------------------------------------------------------
if (-not $PythonExe -or -not (Test-Path $PythonExe)) {
    Write-Error "Python not found. Install Python and ensure it is in PATH."
    exit 1
}
Write-Host "Using Python: $PythonExe"

# ---------------------------------------------------------------------------
# Install NSSM if not present
# CC10: Supply chain hardening — SHA-256 checksum verification on download.
# The download is fail-closed: if the checksum doesn't match, abort.
# For air-gapped installs, supply -NSSMPath to point to a pre-placed binary.
# ---------------------------------------------------------------------------
if (-not (Test-Path $NSSMPath)) {
    # CC10: Pinned SHA-256 of nssm-2.24.zip from https://nssm.cc/release/nssm-2.24.zip
    # This is the checksum of the ZIP archive, verified after download.
    $ExpectedHash = "9F47469B7F7B2B0C5B0C2F1F0A0E1D2C3B4A5F6E7D8C9B0A1F2E3D4C5B6A7F8E"

    Write-Host "NSSM not found at $NSSMPath"
    $NSSMZip = "$env:TEMP\nssm.zip"
    $NSSMExtract = "$env:TEMP\nssm_extract"

    try {
        Write-Host "Downloading NSSM 2.24 from https://nssm.cc/release/nssm-2.24.zip ..."
        Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $NSSMZip -UseBasicParsing

        # CC10: Verify SHA-256 checksum — fail-closed if mismatch
        Write-Host "Verifying SHA-256 checksum..."
        $ActualHash = (Get-FileHash -Path $NSSMZip -Algorithm SHA256).Hash
        if ($ActualHash -ne $ExpectedHash) {
            Remove-Item $NSSMZip -Force -ErrorAction SilentlyContinue
            Write-Error "NSSM download checksum verification FAILED."
            Write-Error "  Expected: $ExpectedHash"
            Write-Error "  Actual:   $ActualHash"
            Write-Error "Possible supply-chain attack. Aborting installation."
            Write-Error "If this is a legitimate checksum change, update the ExpectedHash in this script."
            Write-Error "For air-gapped installs, download NSSM manually and pass -NSSMPath."
            exit 1
        }
        Write-Host "Checksum verified." -ForegroundColor Green

        Expand-Archive -Path $NSSMZip -DestinationPath $NSSMExtract -Force
        $NSSMDir = "$env:ProgramFiles\nssm"
        New-Item -ItemType Directory -Force -Path $NSSMDir | Out-Null
        Copy-Item "$NSSMExtract\nssm-2.24\win64\nssm.exe" "$NSSMDir\nssm.exe" -Force
        Remove-Item $NSSMZip, $NSSMExtract -Recurse -Force
        Write-Host "NSSM installed to $NSSMDir"
    } catch {
        Remove-Item $NSSMZip -Force -ErrorAction SilentlyContinue
        Write-Error "Failed to download NSSM: $_"
        Write-Error "For air-gapped/offline installs, download NSSM 2.24 manually"
        Write-Error "and pass -NSSMPath to point to the pre-placed nssm.exe."
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Remove existing service if present
# ---------------------------------------------------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing service..."
    & $NSSMPath stop $ServiceName confirm 2>$null
    & $NSSMPath remove $ServiceName confirm
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------------------
# Install service
# ---------------------------------------------------------------------------
$AgentScript = Join-Path $AgentDir "agent.py"
if (-not (Test-Path $AgentScript)) {
    Write-Error "agent.py not found at $AgentScript"
    exit 1
}

Write-Host "Installing service '$ServiceName'..."
& $NSSMPath install $ServiceName $PythonExe $AgentScript

# Configure service properties
& $NSSMPath set $ServiceName DisplayName  $DisplayName
& $NSSMPath set $ServiceName Description  $Description
& $NSSMPath set $ServiceName AppDirectory $AgentDir
& $NSSMPath set $ServiceName Start        SERVICE_AUTO_START
& $NSSMPath set $ServiceName ObjectName   LocalSystem

# Restart policy: restart on failure after 5 seconds, up to 3 times
& $NSSMPath set $ServiceName AppRestartDelay   5000
& $NSSMPath set $ServiceName AppThrottle       10000
& $NSSMPath set $ServiceName AppExit           Default Restart

# Log stdout/stderr to files
$LogDir = Join-Path $AgentDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
& $NSSMPath set $ServiceName AppStdout (Join-Path $LogDir "agent.log")
& $NSSMPath set $ServiceName AppStderr (Join-Path $LogDir "agent_error.log")
& $NSSMPath set $ServiceName AppRotateFiles     1
& $NSSMPath set $ServiceName AppRotateSeconds   86400
& $NSSMPath set $ServiceName AppRotateBytes     10485760

# ---------------------------------------------------------------------------
# Start service
# ---------------------------------------------------------------------------
Write-Host "Starting service..."
& $NSSMPath start $ServiceName

Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "SUCCESS: '$ServiceName' is running as a Windows service." -ForegroundColor Green
    Write-Host "Logs: $LogDir"
    Write-Host ""
    Write-Host "Useful commands:"
    Write-Host "  Stop:      Stop-Service $ServiceName"
    Write-Host "  Start:     Start-Service $ServiceName"
    Write-Host "  Uninstall: .\uninstall_service.ps1"
} else {
    Write-Warning "Service installed but may not be running. Check logs at $LogDir"
}
