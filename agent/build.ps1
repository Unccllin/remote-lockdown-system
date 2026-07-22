# Build the lockdown agent and companion tools as standalone executables
# using PyInstaller.
#
# Produces three executables in dist\:
#   lockdown-agent.exe     — the main agent (checkin, encryption, boot lockdown)
#   lockdown-watchdog.exe  — process monitor that restarts the agent if it crashes
#   lockdown-recovery.exe  — offline recovery tool for IT staff
#
# Usage:
#   .\build.ps1                 # Build all three for current platform
#   .\build.ps1 -Clean          # Clean build directories and rebuild
#   .\build.ps1 -Install        # Install PyInstaller first, then build
#   .\build.ps1 -AgentOnly      # Build only the agent (skip watchdog/recovery)
#
# Requirements:
#   - Python 3.8+
#   - pip install pyinstaller
#   - pip install -r requirements.txt
#
# Output:
#   dist\lockdown-agent.exe, dist\lockdown-watchdog.exe, dist\lockdown-recovery.exe

param(
    [switch]$Clean,
    [switch]$Install,
    [switch]$AgentOnly
)

$ErrorActionPreference = "Stop"

Write-Host "=== Remote Lockdown Agent Build ===" -ForegroundColor Green
Write-Host "Platform: Windows $([System.Environment]::OSVersion.Version)"
Write-Host "Python:   $(python --version 2>&1)"
Write-Host ""

# Install PyInstaller if requested
if ($Install) {
    Write-Host "Installing PyInstaller..." -ForegroundColor Yellow
    pip install pyinstaller
    Write-Host ""
}

# Check PyInstaller is available
$pyinstallerCheck = python -c "import PyInstaller; print('ok')" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: PyInstaller is not installed." -ForegroundColor Red
    Write-Host "Run: .\build.ps1 -Install"
    exit 1
}

# Install agent dependencies
Write-Host "Installing agent dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt --quiet
Write-Host ""

# Clean build directories if requested
if ($Clean) {
    Write-Host "Cleaning build directories..." -ForegroundColor Yellow
    if (Test-Path "build") { Remove-Item -Recurse -Force "build" }
    if (Test-Path "dist") { Remove-Item -Recurse -Force "dist" }
    Write-Host ""
}

# Determine which specs to build
$specs = @("agent.spec")
if (-not $AgentOnly) {
    $specs += @("watchdog.spec", "offline_recovery.spec")
}

$builtOk = @()
$builtFail = @()

foreach ($spec in $specs) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($spec)
    Write-Host "Building $name with PyInstaller..." -ForegroundColor Yellow
    python -m PyInstaller $spec --noconfirm
    if ($LASTEXITCODE -eq 0) {
        $builtOk += $name
    } else {
        $builtFail += $name
    }
    Write-Host ""
}

# Summary
Write-Host "=== Build Summary ===" -ForegroundColor Green
foreach ($name in $builtOk) {
    $binName = if ($name -eq "agent") { "lockdown-agent.exe" } else { "lockdown-$name.exe" }
    $binPath = "dist\$binName"
    if (Test-Path $binPath) {
        $size = (Get-Item $binPath).Length / 1MB
        Write-Host "  OK   $binPath ($([math]::Round($size, 1)) MB)" -ForegroundColor Green
    }
}
foreach ($name in $builtFail) {
    Write-Host "  FAIL $name.spec" -ForegroundColor Red
}
if ($builtFail.Count -gt 0) {
    Write-Host "One or more builds failed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Test the builds:"
Write-Host "  .\dist\lockdown-agent.exe --version"
Write-Host "  .\dist\lockdown-agent.exe --help"
Write-Host ""
Write-Host "To deploy with a config file:"
Write-Host "  .\dist\lockdown-agent.exe --config C:\path\to\agent-config.json"
Write-Host ""
Write-Host "To run the watchdog (place it next to lockdown-agent.exe):"
Write-Host "  .\dist\lockdown-watchdog.exe"
