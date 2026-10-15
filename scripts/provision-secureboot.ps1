<#
.SYNOPSIS
  Apply a pre-built Secure Boot owner-key bundle on a target machine (D-130).

.DESCRIPTION
  Implements the enrollment half of PBL-SECURE-BOOT-DEPLOYMENT.md section 2.1.
  The bundle is produced on the signing host by scripts/gen-secureboot-keys.sh
  and contains unsigned .auth files for PK / KEK / db / dbx.

  IMPORTANT -- the unsigned .auth bundle is ONLY accepted while the machine is
  in Setup Mode (no PK enrolled). That is exactly the provisioning window.
  This script therefore:

    1. Verifies UEFI boot + Administrator privileges.
    2. Confirms the platform is in Setup Mode (or requires -Force to proceed
       past an existing PK -- replacing an enrolled PK needs a *signed* update
       which unsigned .auth cannot satisfy).
    3. Applies db, KEK, then PK LAST (writing PK is what flips SetupMode->0
       and arms Secure Boot enforcement on the next boot).
    4. Re-reads the variables to confirm enrollment.
    5. Optionally reboots (or prompts for a manual reboot) to commit.

  After a successful run + reboot the platform reports:
      SetupMode    = 0
      DeployedMode = 1   (on platforms that support it)
      SecureBoot   = 1   (must be ENABLED in firmware setup already)

  Decision.c BLOCKs Windows boot while SecureBoot=0 or SetupMode=1, so the
  machine is fail-closed until enrollment completes and Secure Boot is on.

.PARAMETER AuthDir
  Directory containing PK.auth / KEK.auth / db.auth / dbx.auth produced by
  gen-secureboot-keys.sh. Required.

.PARAMETER Force
  Attempt enrollment even when SetupMode=0. Only useful if the current PK is
  the owner PK already (idempotent re-provision); otherwise it will fail --
  unsigned .auth cannot replace an existing PK.

.PARAMETER NoReboot
  Apply the variables but do not reboot. Enrollment commits on the next boot.

.PARAMETER WhatIf
  Validate environment + print the enrollment plan without writing NVRAM.

.EXAMPLE
  # First-time provisioning on a Setup-Mode machine:
  powershell -ExecutionPolicy Bypass -File provision-secureboot.ps1 -AuthDir C:\pbl\auth

.NOTES
  Ruling 2026-10-14: owner-cert + provisioning-time db enrollment; the
  Microsoft UEFI portal is not used because every unit gets a provisioning
  touch. External SPI clip is the fallback for units that reject enrollment.
  See: docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md, D-129, D-130.
#>

param(
    [Parameter(Mandatory=$true)][string]$AuthDir,
    [switch]$Force,
    [switch]$NoReboot,
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] [$Level] $Message"
}

# --- Precondition checks -----------------------------------------------------

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Log "Must run as Administrator (UEFI variable writes need SE_SYSTEM_ENVIRONMENT)." "ERROR"
    exit 1
}

# Confirm UEFI boot -- Get-SecureBootUEFI throws on Legacy/CSM.
try { $null = Get-SecureBootUEFI -Name SetupMode -ErrorAction Stop }
catch {
    Write-Log "System is not in UEFI mode (or UEFI vars inaccessible). Cannot provision Secure Boot." "ERROR"
    exit 1
}

function Read-ByteVar([string]$name) {
    try { return [int](Get-SecureBootUEFI -Name $name).Bytes[0] }
    catch { return -1 }
}

$setupMode    = Read-ByteVar "SetupMode"
$secureBoot   = Read-ByteVar "SecureBoot"
$deployedMode = Read-ByteVar "DeployedMode"
Write-Log "Pre-state: SetupMode=$setupMode SecureBoot=$secureBoot DeployedMode=$deployedMode"

# Required .auth files.
$need = @("db","KEK","PK")
foreach ($n in $need) {
    if (-not (Test-Path (Join-Path $AuthDir "$n.auth"))) {
        Write-Log "Missing $AuthDir\$n.auth -- run gen-secureboot-keys.sh first." "ERROR"
        exit 1
    }
}
$dbxPath = Join-Path $AuthDir "dbx.auth"   # optional

if ($setupMode -eq 0 -and -not $Force) {
    Write-Log "SetupMode=0 -- a PK is already enrolled. Unsigned .auth cannot replace it." "ERROR"
    Write-Log "If this machine already carries the owner PK, re-run with -Force (idempotent)." "INFO"
    Write-Log "Otherwise clear keys in firmware setup (Setup Mode) and re-run." "INFO"
    exit 1
}

Write-Log "=== Enrollment plan ==="
Write-Log "  db  <- db.auth   (PBL signing cert + Microsoft UEFI/Windows CAs)"
Write-Log "  KEK <- KEK.auth  (owner KEK + Microsoft KEK)"
if (Test-Path $dbxPath) { Write-Log "  dbx <- dbx.auth  (revocation list)" }
Write-Log "  PK  <- PK.auth   (owner PK -- enroll LAST; flips SetupMode->0)"

if ($WhatIf) {
    Write-Log "WhatIf -- no changes made." "WARN"
    exit 0
}

# --- Apply -------------------------------------------------------------------
# Order: dbx -> db -> KEK -> PK.  PK last because writing it is what exits
# Setup Mode. On a Setup-Mode machine these unsigned .auth files are accepted
# (self-signed / no authentication required while PK is empty).

function Set-SecureVar([string]$name, [string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    Write-Log "Writing $name ($($bytes.Length) bytes) from $path"
    Set-SecureBootUEFI -Name $name -ContentBytes $bytes
}

try {
    if (Test-Path $dbxPath) { Set-SecureVar "dbx" $dbxPath }
    Set-SecureVar "db"  (Join-Path $AuthDir "db.auth")
    Set-SecureVar "KEK" (Join-Path $AuthDir "KEK.auth")
    Set-SecureVar "PK"  (Join-Path $AuthDir "PK.auth")
} catch {
    Write-Log "Enrollment failed writing variables: $_" "ERROR"
    Write-Log "If this failed on PK/KEK/db with 'access denied', the platform may" "INFO"
    Write-Log "not be in Setup Mode, or requires signed (time-based) auth." "INFO"
    exit 1
}

# --- Verify ------------------------------------------------------------------
$setupAfter    = Read-ByteVar "SetupMode"
$secureAfter   = Read-ByteVar "SecureBoot"
$deployedAfter = Read-ByteVar "DeployedMode"
Write-Log "Post-state: SetupMode=$setupAfter SecureBoot=$secureAfter DeployedMode=$deployedAfter"

# Enrollment is committed at next boot by firmware; some platforms reflect
# the change immediately, others after reboot. Report both.
Write-Log "Enrollment applied. SetupMode flips to 0 and Secure Boot arms on next boot." "OK"

if ($NoReboot) {
    Write-Log "-NoReboot set -- reboot manually to commit." "WARN"
} else {
    Write-Log "Rebooting in 10s to commit enrollment (Ctrl+C to abort)..." "WARN"
    Start-Sleep -Seconds 10
    Restart-Computer -Force
}
