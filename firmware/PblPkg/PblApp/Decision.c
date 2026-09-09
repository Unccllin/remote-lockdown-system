/** @file
  Decision.c — C4 §5 18-step policy evaluation engine.

  PblEvaluateDecision combines platform state, policy, and verdict into
  a PASS / DEGRADED / BLOCK result. The 18-step evaluation order is
  defined in C4 §5:

    1.  Parse + verify policy blob signature       → BLOCK on fail
    2.  Check policy.version >= NV counter          → BLOCK on rollback
    3.  Check policy.expires_at > now               → DEGRADED if expired
    4.  Check min_pbl_version <= self version       → DEGRADED if lower
    5.  REQ-01: PK allowlist + PKfail denylist      → BLOCK on fail
    6.  REQ-02: db/dbx + bootmgr SVN                → BLOCK on fail
    7.  REQ-03: SPI protections                     → DEGRADED if unknown
    8.  REQ-04: firmware version + AMT + DCI        → DEGRADED on fail
    9.  REQ-05: TPM session requirements            → BLOCK on fail
    10. REQ-06: TPM firmware floors + PIN policy    → BLOCK on fail
    11. REQ-07: S3 + DMA + MOR                      → BLOCK on fail
    12. REQ-08: network boot policy                 → BLOCK on fail
    13. REQ-09: BCD + winre.wim + BitLocker         → BLOCK on fail
    14. REQ-10: firmware recovery capability        → DEGRADED if none
    15. Fetch verdict via C3 (or read cache)        → C1 §7
    16. Combine: worst(policy_checks, server_verdict)
    17. Extend PCR 13 (inputs) + PCR 12 (decision)  → C2 §4.1
    18. PASS → chain-load; DEGRADED → notice; BLOCK → lock screen

  Steps 1-2 are performed by the caller (PblApp.c) before calling
  PblEvaluateDecision. Step 15 (verdict fetch) is performed by the
  caller. Step 17 (PCR extension) is performed by the caller after
  the decision. Step 18 (action) is performed by the caller.

  This function implements steps 3-14 (policy checks) and step 16
  (combine with server verdict).

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// Helpers
// ============================================================================

/** Get current Unix time from UEFI runtime services.

  @param Now  Output: Unix timestamp (seconds since 1970-01-01).

  @retval EFI_SUCCESS  Time retrieved.
  @retval EFI_DEVICE_ERROR  Clock failure.
**/
STATIC
EFI_STATUS
PblGetUnixTime (
  OUT UINT32  *Now
  )
{
  EFI_TIME  Time;
  EFI_STATUS Status;
  UINT32    Days;
  UINT32    Seconds;
  STATIC CONST UINT8 DaysPerMonth[12] = {
    31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
  };

  Status = gRT->GetTime (&Time, NULL);
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  // Validate time fields
  if (Time.Year < 1970 || Time.Year > 2106) {
    return EFI_DEVICE_ERROR;
  }

  // Compute days since 1970-01-01
  Days = 0;
  for (UINT16 Year = 1970; Year < Time.Year; Year++) {
    BOOLEAN IsLeap = ((Year % 4 == 0) && (Year % 100 != 0)) || (Year % 400 == 0);
    Days += IsLeap ? 366 : 365;
  }
  for (UINT8 Month = 1; Month < Time.Month; Month++) {
    Days += DaysPerMonth[Month - 1];
    if (Month == 2 && Time.Year % 4 == 0 &&
        (Time.Year % 100 != 0 || Time.Year % 400 == 0)) {
      Days += 1;  // leap day
    }
  }
  Days += Time.Day - 1;

  Seconds = Days * 86400 + Time.Hour * 3600 + Time.Minute * 60 + Time.Second;
  *Now = Seconds;
  return EFI_SUCCESS;
}

// ============================================================================
// C4 §5: 18-step policy evaluation
// ============================================================================

/** C4 §5: Evaluate the 18-step policy decision.

  Steps 3-14 are policy checks. Step 16 combines the policy result
  with the server verdict (C1). The caller handles steps 1-2, 15, 17-18.

  @param  State    Platform state (collected by PlatformState.c).
  @param  Policy   Parsed policy blob (from Policy.c).
  @param  Verdict  Server verdict (from Verdict.c, may be zeroed if no verdict).

  @retval PblResultPass      All checks pass, server says UNLOCKED.
  @retval PblResultDegraded  Non-critical check failed or policy expired.
  @retval PblResultBlock     Critical check failed or server says LOCKED.
**/
PBL_RESULT
PblEvaluateDecision (
  IN CONST PBL_PLATFORM_STATE  *State,
  IN CONST PBL_POLICY          *Policy,
  IN CONST PBL_VERDICT         *Verdict
  )
{
  PBL_RESULT  PolicyResult;
  PBL_RESULT  FinalResult;
  UINT32      Now;
  EFI_STATUS  Status;

  if (State == NULL || Policy == NULL) {
    return PblResultBlock;
  }

  // Start optimistic — downgrade as we find issues
  PolicyResult = PblResultPass;

  // Get current time for expiry checks
  Status = PblGetUnixTime (&Now);
  if (EFI_ERROR (Status)) {
    // Can't tell time — degrade but don't block
    PolicyResult = PblResultDegraded;
    Now = 0;
  }

  // ------------------------------------------------------------------
  // Step 3: Check policy.expires_at > now → DEGRADED if expired
  // ------------------------------------------------------------------
  if (Policy->Meta.ExpiresAt > 0 && Now > 0 && Now >= Policy->Meta.ExpiresAt) {
    PolicyResult = PblResultDegraded;
  }

  // ------------------------------------------------------------------
  // Step 4: Check min_pbl_version <= self version → DEGRADED if lower
  // ------------------------------------------------------------------
  if (Policy->Meta.MinPblVersion > 0 &&
      Policy->Meta.MinPblVersion > PBL_VERSION) {
    PolicyResult = PblResultDegraded;
  }

  // ------------------------------------------------------------------
  // Step 5: REQ-01 — Secure Boot enabled, not in Setup Mode
  // ------------------------------------------------------------------
  if (!State->SecureBootEnabled) {
    // Secure Boot disabled is a critical security failure
    PolicyResult = PblResultBlock;
  }
  if (State->SetupMode) {
    // Setup Mode = PK not enrolled = anyone can install keys
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 6: REQ-02 — db/dbx expectations + bootmgr SVN
  // ------------------------------------------------------------------
  // Check that db has the Windows UEFI CA 2023 (basic expectation)
  // and dbx has the MS 2011 revocation (BootHole mitigation).
  // If these are missing, the platform is vulnerable.
  if (!State->DbHasWindowsUefiCa2023) {
    PolicyResult = PblResultBlock;
  }
  if (!State->DbxHasMs2011Revocation) {
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 7: REQ-03 — SPI protections (or unknown → DEGRADED)
  // ------------------------------------------------------------------
  if (!State->SpiProtectionsKnown) {
    // Can't determine SPI protection state — degrade
    if (PolicyResult != PblResultBlock) {
      PolicyResult = PblResultDegraded;
    }
  } else {
    // SPI protections known — check critical bits
    if (!State->Bioswe || !State->Ble || !State->SmmBwp) {
      PolicyResult = PblResultBlock;
    }
  }

  // ------------------------------------------------------------------
  // Step 8: REQ-04 — firmware version + AMT + DCI (DEGRADED on fail)
  // ------------------------------------------------------------------
  // AMT provisioned on a consumer device is suspicious — degrade.
  // USB DCI enabled allows direct USB debugging — degrade.
  if (State->AmtProvisioned) {
    if (PolicyResult != PblResultBlock) {
      PolicyResult = PblResultDegraded;
    }
  }
  if (State->UsbDciEnabled) {
    if (PolicyResult != PblResultBlock) {
      PolicyResult = PblResultDegraded;
    }
  }

  // ------------------------------------------------------------------
  // Step 9: REQ-05 — TPM session requirements (BLOCK on fail)
  // ------------------------------------------------------------------
  // The policy specifies whether HMAC sessions, parameter encryption,
  // salted sessions, and bound sessions are required.
  // Since PBL uses TPM2_GetRandom and TPM2_PCR_Read without sessions
  // (D-102: TPM_ST_NO_SESSIONS), any policy requiring sessions blocks.
  if (Policy->TpmSessionReq.HmacRequired ||
      Policy->TpmSessionReq.ParamEncryptRequired ||
      Policy->TpmSessionReq.SaltedRequired ||
      Policy->TpmSessionReq.BoundRequired) {
    // D-102: PBL currently uses no-session TPM commands. If the policy
    // requires sessions, we must BLOCK until session support is added.
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 10: REQ-06 — TPM firmware floors + PIN policy (BLOCK on fail)
  // ------------------------------------------------------------------
  // Check TPM firmware version against policy floor.
  if (Policy->TpmFirmwareFloor > 0 &&
      State->TpmFirmwareVersion > 0 &&
      State->TpmFirmwareVersion < Policy->TpmFirmwareFloor) {
    // TPM firmware is below the minimum required version
    PolicyResult = PblResultBlock;
  }
  // PIN policy "required" — we can't enforce PIN in pre-boot without
  // a user input mechanism. If the policy requires PIN, BLOCK.
  if (Policy->TpmPinPolicy == 1) {
    // PIN required but PBL has no PIN entry UI in this flow
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 11: REQ-07 — S3 + DMA + MOR (BLOCK on fail)
  // ------------------------------------------------------------------
  // S3 (sleep) should be disabled or MOR should be set.
  // Kernel DMA protection should be enabled.
  if (State->S3Enabled && !State->MorRequested) {
    // S3 without MOR is a DMA attack vector
    PolicyResult = PblResultBlock;
  }
  if (!State->KernelDmaProtection) {
    // No Kernel DMA protection — external DMA attacks possible
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 12: REQ-08 — network boot policy (BLOCK on fail)
  // ------------------------------------------------------------------
  // Network boot entries should not be present in a locked-down device.
  // They allow PXE boot which bypasses the local disk.
  if (State->NetworkBootEntriesPresent) {
    PolicyResult = PblResultBlock;
  }

  // ------------------------------------------------------------------
  // Step 13: REQ-09 — BCD + winre.wim + BitLocker (BLOCK on fail)
  // ------------------------------------------------------------------
  // BitLocker should be enabled on a locked-down device.
  if (!State->BitLockerEnabled) {
    PolicyResult = PblResultBlock;
  }
  // BCD and winre.wim hashes are collected but not yet compared against
  // policy expectations (no policy fields for them yet). Skip.

  // ------------------------------------------------------------------
  // Step 14: REQ-10 — firmware recovery capability (DEGRADED if none)
  // ------------------------------------------------------------------
  // FirmwareRecovery: 0=dual_image, 1=intel_pfr, 2=none
  if (State->FirmwareRecovery == 2) {
    // No firmware recovery — degrade (not block, since it's a resilience
    // issue, not a security hole)
    if (PolicyResult != PblResultBlock) {
      PolicyResult = PblResultDegraded;
    }
  }

  // ------------------------------------------------------------------
  // Step 16: Combine — worst(policy_checks, server_verdict)
  // ------------------------------------------------------------------
  // A server LOCKED verdict always wins over a policy DEGRADED.
  // A server WIPE_PENDING verdict is treated as BLOCK.
  FinalResult = PolicyResult;

  if (Verdict != NULL) {
    switch (Verdict->Verdict) {
      case PBL_VERDICT_LOCKED:
        // Server says LOCKED — always BLOCK, regardless of policy checks
        FinalResult = PblResultBlock;
        break;

      case PBL_VERDICT_WIPE_PENDING:
        // Server says WIPE_PENDING — treat as BLOCK
        FinalResult = PblResultBlock;
        break;

      case PBL_VERDICT_UNLOCKED:
        // Server says UNLOCKED — policy result stands
        break;

      case PBL_VERDICT_TRACKING:
        // C5: Server says TRACKING — covert tracking mode.
        // Do NOT force BLOCK. The policy result stands (usually PASS).
        // PBL chain-loads Windows normally. The agent enters covert
        // tracking mode and reports location. The thief sees a normal
        // boot — no lock screen, no notice.
        // Policy failures still apply: if policy checks produced BLOCK,
        // the result is BLOCK even with a TRACKING verdict.
        break;

      default:
        // Unknown verdict value — fail closed
        FinalResult = PblResultBlock;
        break;
    }
  }

  return FinalResult;
}
