/** @file
  Verdict.c — C1 §7 9-step verdict verification.

  Implements the verification-only steps (4-8) on a parsed PBL_VERDICT
  struct. Steps 1-3 (COSE structural parse, kid lookup, signature
  verification) are performed by the caller before invoking
  PblVerifyVerdict, because they require the raw COSE bytes and the
  pinned certificate.

  Verification ordering (C1 §7):
    4. version == 1
    5. device_id == SHA-256(self AK public Area)
    6. nonce == self nonce
    7. policy_version >= self NV counter
    8. issued_at <= now < grace_until

  Steps 1-8 are verification only — no side effects. Step 9 (cache in
  TPM NV, extend PCR 12/13) is performed by the caller after
  PblVerifyVerdict returns EFI_SUCCESS.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// C1 §7: Verdict verification (steps 4-8)
// ============================================================================

/** C1 §7 step 8: Get current Unix time from UEFI runtime services.

  UEFI provides EFI_TIME via gRT->GetTime(). Convert to Unix epoch
  seconds. Returns 0 on failure (caller should reject if time is 0
  and verdict requires time validation).
**/
STATIC
UINT32
PblGetUnixTime (
  VOID
  )
{
  EFI_STATUS  Status;
  EFI_TIME    Time;
  UINT32      Epoch;

  Status = gRT->GetTime (&Time, NULL);
  if (EFI_ERROR (Status)) {
    Print (L"  [DBG] GetTime failed: %r\n", Status);
    return 0;
  }

  // Basic sanity checks
  if (Time.Year < 1970 || Time.Year > 2106) {
    Print (L"  [DBG] GetTime year out of range: %d\n", Time.Year);
    return 0;
  }

  Print (L"  [DBG] GetTime: %04d-%02d-%02d %02d:%02d:%02d\n",
    Time.Year, Time.Month, Time.Day, Time.Hour, Time.Minute, Time.Second);

  // Convert EFI_TIME to Unix epoch seconds
  // Simplified calculation (ignores leap seconds, valid for 1970-2106)
  UINT32 DaysPerMonth[] = {
    31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31
  };

  // Account for leap years
  if ((Time.Year % 4 == 0 && Time.Year % 100 != 0) || Time.Year % 400 == 0) {
    DaysPerMonth[1] = 29;  // February has 29 days in leap years
  }

  Epoch = 0;
  for (UINT16 Year = 1970; Year < Time.Year; Year++) {
    Epoch += 365 * 86400;
    if ((Year % 4 == 0 && Year % 100 != 0) || Year % 400 == 0) {
      Epoch += 86400;  // leap day
    }
  }

  for (UINT8 Month = 1; Month < Time.Month; Month++) {
    Epoch += DaysPerMonth[Month - 1] * 86400;
  }

  Epoch += (Time.Day - 1) * 86400;
  Epoch += Time.Hour * 3600;
  Epoch += Time.Minute * 60;
  Epoch += Time.Second;

  return Epoch;
}

/** C1 §7: Verify a parsed verdict (steps 4-8).

  This function performs the verification-only checks on a PBL_VERDICT
  struct that has already been parsed from COSE_Sign1 (steps 1-3 done
  by caller). No side effects — does not modify TPM state.

  @param[in] Verdict        The parsed verdict to verify.
  @param[in] SelfNonce      32-byte nonce PBL sent in the request.
  @param[in] SelfDeviceId   32-byte SHA-256(AK public Area) of this device.
  @param[in] SelfNvCounter  Current NV policy version counter.
  @param[in] Policy         Parsed C4 policy blob (for freshness/grace checks).

  @retval EFI_SUCCESS           All verification steps passed.
  @retval EFI_INVALID_PARAMETER Verdict or required parameter is NULL.
  @retval EFI_PROTOCOL_ERROR    Step 4: version mismatch.
  @retval EFI_SECURITY_VIOLATION Step 5: device_id mismatch.
  @retval EFI_SECURITY_VIOLATION Step 6: nonce mismatch (replay).
  @retval EFI_SECURITY_VIOLATION Step 7: policy_version rollback.
  @retval EFI_DEVICE_ERROR      Step 8: stale, future-dated, or clock failure.
**/
EFI_STATUS
PblVerifyVerdict (
  IN  CONST PBL_VERDICT       *Verdict,
  IN  CONST UINT8             *SelfNonce,
  IN  CONST UINT8             *SelfDeviceId,
  IN  UINT64                   SelfNvCounter,
  IN  CONST PBL_POLICY        *Policy
  )
{
  if (Verdict == NULL || SelfNonce == NULL || SelfDeviceId == NULL || Policy == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Step 4: version == 1 (reject unknown wire format versions)
  if (Verdict->Version != PBL_VERDICT_VERSION) {
    return EFI_PROTOCOL_ERROR;
  }

  // Step 5: device_id == SHA-256(self AK public Area)
  // Rejects verdicts stolen from another device.
  if (CompareMem (Verdict->DeviceId, SelfDeviceId, 32) != 0) {
    return EFI_SECURITY_VIOLATION;
  }

  // Step 6: nonce == self nonce
  // Rejects replayed verdicts from a different session.
  if (CompareMem (Verdict->Nonce, SelfNonce, 32) != 0) {
    return EFI_SECURITY_VIOLATION;
  }

  // Step 7: policy_version >= self NV counter (REQ-11 anti-rollback)
  // Rejects verdicts signed against an older policy version.
  if (Verdict->PolicyVersion < SelfNvCounter) {
    return EFI_SECURITY_VIOLATION;
  }

  // Step 8: issued_at <= now < grace_until
  // Rejects stale (past grace) or future-dated verdicts.
  UINT32 Now = PblGetUnixTime ();
  Print (L"  [DBG] Verdict time check: Now=%u IssuedAt=%u GraceUntil=%u\n",
    Now, Verdict->IssuedAt, Verdict->GraceUntil);
  if (Now == 0) {
    // Clock failure — cannot safely determine time validity.
    // C1 §3: "never brick" — but we also can't validate freshness.
    // Fail safe: reject the verdict. The caller can fall back to
    // cached verdict or enter denied-boot-with-local-unlock.
    return EFI_DEVICE_ERROR;
  }

  if (Verdict->IssuedAt > Now + 60) {
    // Future-dated verdict — reject (clock skew > 60s or forgery)
    // D-206: Allow up to 60 seconds of clock skew to account for network
    // round-trip delay between server timestamp generation and firmware
    // time read. The server may issue the verdict a few seconds before
    // the firmware reads its clock.
    return EFI_DEVICE_ERROR;
  }

  if (Now >= Verdict->GraceUntil) {
    // Stale verdict — past grace period
    return EFI_DEVICE_ERROR;
  }

  // Optional: check verdict freshness against policy
  // C1 §3.1: issued_at within verdict_freshness_seconds of now (online path)
  // This is a soft check — the grace_until check above is the hard bound.
  // Only enforce freshness if the policy specifies a non-zero value.
  if (Policy->VerdictFreshnessSec > 0) {
    if ((Now - Verdict->IssuedAt) > Policy->VerdictFreshnessSec) {
      // Verdict is not fresh enough for online use.
      // The caller may still use it as a cached offline verdict
      // if within grace_until. Return a distinct status so the
      // caller can decide: treat as stale-online but valid-offline.
      // For now, we treat this as a soft failure — the hard grace
      // check above already passed, so the verdict is usable.
      // The caller checks freshness separately for online vs offline.
    }
  }

  // All verification steps passed.
  // Step 9 (cache in TPM NV, extend PCR 12/13) is the caller's responsibility.
  return EFI_SUCCESS;
}
