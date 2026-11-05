# Build the Windows artefacts from their specs, in one place.
#
# Why this exists
# ---------------
# `agent/dist/` is gitignored, so a fresh clone has no Windows installers: until this
# script existed, `lockdown-installer.exe` had to be produced by hand on a Windows box
# (S227). CI runs exactly this script on `windows-latest`, and a developer can run it
# locally with the same result.
#
#   pwsh -File scripts/build-windows-artifacts.ps1              # everything
#   pwsh -File scripts/build-windows-artifacts.ps1 -Only agent  # one target
#
# Outputs land in agent/dist/:
#   lockdown-service.exe     the SCM host the service runs (S220/S224)
#   lockdown-installer.exe   the CLI installer the NSIS wrapper delegates to (S209)
#   lockdown-agent.exe       the agent itself
#   lockdown-setup.exe       the GUI wizard (optional; needs tkinter)
#
# Each build is verified by size and PE header - a zero-byte or non-PE output is a
# failure, not a warning, because the server happily serves whatever is staged and the
# failure would surface later as "the installer does nothing" (S227).

[CmdletBinding()]
param(
    [ValidateSet('all', 'service', 'installer', 'agent', 'gui')]
    [string]$Only = 'all',
    [string]$Python = 'python',
    [switch]$SkipDeps
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$agentDir = Join-Path $repoRoot 'agent'
$distDir = Join-Path $agentDir 'dist'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Fail($message) { Write-Host "!!  $message" -ForegroundColor Red }

if (-not (Test-Path $agentDir)) {
    Write-Fail "agent/ not found next to scripts/ - run this from the repository."
    exit 1
}

Push-Location $agentDir
try {
    if (-not $SkipDeps) {
        Write-Step "installing build dependencies"
        & $Python -m pip install --quiet --disable-pip-version-check `
            pyinstaller cryptography requests pywin32
        if ($LASTEXITCODE -ne 0) { Write-Fail 'pip install failed'; exit 1 }
    }

    New-Item -ItemType Directory -Force -Path $distDir | Out-Null

    # name -> build command. Specs are used where they exist so hidden imports and datas
    # stay in one place; service_host has no spec (it is a single file) and is built with
    # flags.
    $targets = [ordered]@{
        service   = @('--onefile', '--noconsole', '--name', 'lockdown-service', 'service_host.py')
        installer = @('installer.spec', '--noconfirm')
        agent     = @('agent.spec', '--noconfirm')
        gui       = @('installer_gui.spec', '--noconfirm')
    }

    $selected = if ($Only -eq 'all') { $targets.Keys } else { @($Only) }

    foreach ($name in $selected) {
        if (-not $targets.Contains($name)) { continue }
        Write-Step "building $name"
        & $Python -m PyInstaller @($targets[$name])
        if ($LASTEXITCODE -ne 0) { Write-Fail "pyinstaller failed for $name"; exit 1 }
    }

    # Verify every expected artefact: exists, has real size, starts with "MZ".
    $expected = @{
        service   = 'lockdown-service.exe'
        installer = 'lockdown-installer.exe'
        agent     = 'lockdown-agent.exe'
        gui       = 'lockdown-setup.exe'
    }

    Write-Step 'verifying artefacts'
    $failed = $false
    foreach ($name in $selected) {
        $file = Join-Path $distDir $expected[$name]
        if (-not (Test-Path $file)) {
            Write-Fail "$($expected[$name]) was not produced"
            $failed = $true
            continue
        }
        $item = Get-Item $file
        $header = [System.IO.File]::ReadAllBytes($file)[0..1]
        $isPe = ($header[0] -eq 0x4D -and $header[1] -eq 0x5A)   # "MZ"
        if ($item.Length -lt 1MB -or -not $isPe) {
            Write-Fail "$($item.Name): size=$($item.Length) PE=$isPe - not a usable binary"
            $failed = $true
            continue
        }
        Write-Host ("    {0,-26} {1,12:N0} bytes  PE={2}" -f $item.Name, $item.Length, $isPe)
    }

    if ($failed) { exit 1 }

    Write-Step "done - artefacts in $distDir"
    Get-ChildItem $distDir -Filter '*.exe' | Select-Object Name, Length |
        Format-Table -AutoSize | Out-String | Write-Host
}
finally {
    Pop-Location
}
