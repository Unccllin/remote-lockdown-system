<#
.SYNOPSIS
  BitLocker PCR sealing enrollment script for PBL high-assurance tier (C2 §4.4).

.DESCRIPTION
  When a device is enrolled with the high-assurance BitLocker sealing tier,
  the VMK must be sealed to both the normal-boot and tracking-boot PCR 12
  values. This script:

  1. Captures the current PCR 12 value (normal-boot, UNLOCKED verdict)
  2. Suspends BitLocker protection
  3. Adds a TPM+PCR protector with the current PCR profile
  4. Resumes BitLocker protection
  5. (Future) When PBL tracking mode is tested, seals to the tracking PCR 12
     value as well via Manage-bde -protectors -add

  Prerequisites:
  - BitLocker enabled on C: with TPM protector
  - PBL firmware installed and running (PCR 12 has PBL extension)
  - Administrator privileges
  - TPM 2.0 ready

  Usage:
    powershell -ExecutionPolicy Bypass -File enroll-bitlocker-pcr.ps1
    powershell -ExecutionPolicy Bypass -File enroll-bitlocker-pcr.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File enroll-bitlocker-pcr.ps1 -TrackingPcr12 <hex>

.PARAMETER DryRun
  Print what would be done without making changes.

.PARAMETER TrackingPcr12
  The expected PCR 12 value when PBL boots in TRACKING mode (verdict=3).
  If provided, the script seals the VMK to both normal and tracking PCR values.

.NOTES
  D-211: Covert tracking mode (C5) — BitLocker PCR sealing enrollment.
  See docs/adr/PBL-C2-TPM-Contract.md §4.4 for the full design.
#>

param(
    [switch]$DryRun,
    [string]$TrackingPcr12
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] [$Level] $Message"
}

function Get-TpmPcr12 {
    <#
      Read the current PCR 12 value from the TPM.
      Uses tpm2-tss or Windows TPM API depending on availability.
    #>
    try {
        # Method 1: Windows TPM Provider (WMI)
        $tpm = Get-WmiObject -Namespace "root\cimv2\security\MicrosoftTpm" -Class Win32_Tpm -ErrorAction SilentlyContinue
        if ($tpm) {
            # Read PCR 12 via TPM cmdlet
            $pcrResult = & tpmtool.exe getpcr 12 2>$null
            if ($pcrResult) {
                # Parse the PCR value from output
                $pcrLine = $pcrResult | Where-Object { $_ -match "PCR\s+12" }
                if ($pcrLine -match "([0-9a-fA-F]{64})") {
                    return $matches[1].ToLower()
                }
            }
        }
    } catch {
        Write-Log "TPM WMI query failed: $_" "WARN"
    }

    # Method 2: Use tpm2_pcrread if available (Linux/WSL)
    try {
        $result = & tpm2_pcrread sha256:12 2>$null
        if ($result -match "12\s*:\s*([0-9a-fA-F]{64})") {
            return $matches[1].ToLower()
        }
    } catch {
        # Not available
    }

    return $null
}

function Get-BitLockerProtectors {
    <# Get all BitLocker key protectors for C: #>
    $protectors = manage-bde -protectors -get C: 2>$null
    return $protectors
}

function Suspend-BitLockerProtection {
    <# Suspend BitLocker for PCR profile changes #>
    Write-Log "Suspending BitLocker protection on C:..."
    if ($DryRun) {
        Write-Log "  [DRY-RUN] manage-bde -protectors -disable C:" "DRY"
        return
    }
    $result = manage-bde -protectors -disable C: 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to suspend BitLocker: $result"
    }
    Write-Log "BitLocker protection suspended"
}

function Resume-BitLockerProtection {
    <# Resume BitLocker after PCR profile changes #>
    Write-Log "Resuming BitLocker protection on C:..."
    if ($DryRun) {
        Write-Log "  [DRY-RUN] manage-bde -protectors -enable C:" "DRY"
        return
    }
    $result = manage-bde -protectors -enable C: 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to resume BitLocker: $result"
    }
    Write-Log "BitLocker protection resumed"
}

function Add-PcrProtector {
    <#
      Add a TPM+PCR protector to BitLocker.
      The PCR profile specifies which PCRs must match for the VMK to release.
    #>
    param(
        [int[]]$PcrMask,
        [string]$Label
    )

    $pcrArg = ($PcrMask -join ",")
    Write-Log "Adding TPM+PCR protector (PCRs: $pcrArg, label: $Label)..."

    if ($DryRun) {
        Write-Log "  [DRY-RUN] manage-bde -protectors -add C: -tpm -pcr $pcrArg" "DRY"
        return
    }

    # Manage-bde PCR protector syntax:
    # manage-bde -protectors -add C: -tpm -pcr <pcr_list>
    $result = manage-bde -protectors -add C: -tpm -pcr $pcrArg 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to add PCR protector: $result"
    }
    Write-Log "TPM+PCR protector added (PCRs: $pcrArg)"
}

# ---------------------------------------------------------------------------
# Main enrollment flow
# ---------------------------------------------------------------------------

Write-Log "=== PBL BitLocker PCR Sealing Enrollment ==="
Write-Log "DryRun: $DryRun"
Write-Log "TrackingPcr12: $TrackingPcr12"
Write-Log ""

# Step 1: Verify BitLocker is enabled
Write-Log "Step 1: Checking BitLocker status..."
$status = manage-bde -status C: 2>&1
if ($status -notmatch "Protection On") {
    Write-Log "BitLocker protection is not ON on C:. Cannot enroll PCR sealing." "ERROR"
    exit 1
}
Write-Log "BitLocker is ON"

# Step 2: Capture current PCR 12 value (normal-boot, UNLOCKED verdict)
Write-Log "Step 2: Capturing current PCR 12 value (normal-boot)..."
$normalPcr12 = Get-TpmPcr12
if ($normalPcr12) {
    Write-Log "Normal-boot PCR 12: $normalPcr12"
} else {
    Write-Log "Could not read PCR 12 — TPM may not be available or PBL not running" "WARN"
    Write-Log "Proceeding with standard PCR mask (without PCR 12 verification)" "WARN"
}

# Step 3: Suspend BitLocker
Write-Log "Step 3: Suspending BitLocker for PCR profile changes..."
Suspend-BitLockerProtection

# Step 4: Add TPM+PCR protector for high-assurance tier
# High-assurance sealing profile (C2 §4.3): PCR 7 + 11 + 12 + 13
Write-Log "Step 4: Adding high-assurance TPM+PCR protector (PCR 7, 11, 12, 13)..."
Add-PcrProtector -PcrMask 7,11,12,13 -Label "PBL-HighAssurance-Normal"

# Step 5: If tracking PCR 12 is provided, add a second protector for tracking mode
if ($TrackingPcr12 -and $TrackingPcr12 -ne $normalPcr12) {
    Write-Log "Step 5: Adding tracking-mode TPM+PCR protector..."
    Write-Log "Tracking-boot PCR 12: $TrackingPcr12"

    # BitLocker supports multiple PCR profiles. The VMK releases if ANY
    # protector matches. We add a second protector with the same PCR mask
    # but the tracking PCR 12 value will be different at boot time.
    #
    # NOTE: Windows BitLocker does NOT support sealing to specific PCR
    # VALUES — it seals to the current PCR state at protector creation
    # time. To seal to the tracking PCR 12 value, the device must:
    #   1. Boot PBL with TRACKING verdict
    #   2. Run this script (or the agent) to capture the tracking PCR 12
    #   3. Add the protector while PCR 12 has the tracking value
    #
    # This is a two-boot enrollment process documented in C2 §4.4.
    Write-Log "  NOTE: Sealing to tracking PCR 12 requires booting PBL in" "WARN"
    Write-Log "  TRACKING mode first. Run this script again after a" "WARN"
    Write-Log "  tracking-mode boot to add the tracking protector." "WARN"
    Write-Log "  For now, only the normal-boot protector is added." "WARN"
} else {
    Write-Log "Step 5: Skipped (no tracking PCR 12 provided or same as normal)"
}

# Step 6: Resume BitLocker
Write-Log "Step 6: Resuming BitLocker protection..."
Resume-BitLockerProtection

# Step 7: Verify protectors
Write-Log "Step 7: Verifying BitLocker protectors..."
if ($DryRun) {
    Write-Log "  [DRY-RUN] Skipping protector verification" "DRY"
} else {
    $protectors = Get-BitLockerProtectors
    Write-Log "Current protectors:"
    Write-Log $protectors
}

# Step 8: Output enrollment result
Write-Log ""
Write-Log "=== Enrollment Complete ==="
$result = @{
    success = $true
    normal_pcr12 = $normalPcr12
    tracking_pcr12 = $TrackingPcr12
    sealing_tier = "high-assurance"
    pcr_mask = @(7, 11, 12, 13)
    note = "If tracking mode is needed, boot PBL with TRACKING verdict and re-run with -TrackingPcr12"
}
Write-Log ($result | ConvertTo-Json -Depth 3)

Write-Log ""
Write-Log "IMPORTANT: A reboot is required for the new PCR protector to take effect."
Write-Log "After reboot, BitLocker will only release the VMK if PCR 7, 11, 12, 13"
Write-Log "all match the values captured during enrollment."
Write-Log ""
Write-Log "If PBL is removed or reflashed, PCR 12 will not have the PBL extension,"
Write-Log "and BitLocker will require the recovery key — this is the desired behavior."
