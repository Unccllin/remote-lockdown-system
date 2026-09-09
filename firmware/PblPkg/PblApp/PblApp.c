/** @file
  PblApp.c — Main entry point for the Pre-Boot Lock UEFI application.

  PBL runs in the BDS phase before the Windows Boot Manager. The flow:
    1. Collect platform state (PlatformState.c)
    2. Parse + verify policy blob (Policy.c, C4)
    3. Read cached lock state from TPM NV (TpmClient.c, C2)
    4. Fetch verdict via HTTPS (HttpsClient.c, C3) or use cache
    5. Verify verdict (Verdict.c, C1 §7)
    6. Evaluate decision (Decision.c, C4 §5)
    7. Extend PCR 12/13 (TpmClient.c, C2 §4)
    8. Act: PASS → chain-load; DEGRADED → notice + chain-load; BLOCK → lock screen

  This is a scaffold — all functions are stubs that return EFI_UNSUPPORTED.
  Agents A, B, D fill in the implementations per the frozen contracts.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

EFI_STATUS
EFIAPI
PblAppEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS              Status;
  PBL_PLATFORM_STATE      PlatformState;
  PBL_POLICY              Policy;
  PBL_LOCK_STATE_CACHE    LockCache;
  PBL_VERDICT             Verdict;
  UINT64                  NvPolicyVersion;
  UINT8                   Nonce[32];
  UINT8                   *VerdictCose = NULL;
  UINTN                   VerdictCoseSize = 0;
  UINT8                   *PolicyCose = NULL;
  UINTN                   PolicyCoseSize = 0;
  PBL_RESULT              Result;

  UINT8                   *RequestBody = NULL;
  UINTN                   RequestBodySize = 0;
  UINT8                   PlatformStateDigest[32];
  BOOLEAN                 OnlineFetchOk = FALSE;

  // Suppress unused-variable warnings for scaffold stubs
  (VOID)VerdictCose;
  (VOID)VerdictCoseSize;

  //
  // Banner
  //
  Print (L"\n");
  Print (L"========================================\n");
  Print (L"  PBL — Pre-Boot Lock v%d\n", PBL_VERSION);
  Print (L"  Contracts: C1-C4 (frozen 2026-09-05)\n");
  Print (L"========================================\n");
  Print (L"\n");

  //
  // Step 1: Collect platform state (REQ-01..10, C2 §5.1 step 2)
  //
  Print (L"[1/8] Collecting platform state...\n");
  Status = PblCollectPlatformState (&PlatformState);
  if (EFI_ERROR (Status)) {
    Print (L"  [WARN] Platform state collection: %r\n", Status);
    // Continue — missing state is DEGRADED, not fatal
  }

  //
  // Step 2: Parse + verify policy blob (C4, REQ-11)
  // TODO: read from ESP \EFI\PBL\policy.cose or fetch via C3 GET /v1/policy
  //
  Print (L"[2/8] Parsing policy blob...\n");
  // STUB: PolicyCose is NULL — Agent A reads from ESP or fetches via C3
  Status = PblParsePolicy (PolicyCose, PolicyCoseSize, &Policy);
  if (EFI_ERROR (Status)) {
    Print (L"  [WARN] Policy parse: %r — using DEGRADED\n", Status);
    // No policy → DEGRADED (availability issue, not security violation)
  }

  //
  // Step 3: Read cached lock state + policy version from TPM NV (C2 §5.1)
  //
  Print (L"[3/8] Reading TPM NV state...\n");
  Status = PblTpmReadLockState (&LockCache);
  if (EFI_ERROR (Status)) {
    Print (L"  [INFO] No cached lock state: %r\n", Status);
    // No cache → first boot or NV cleared → denied-boot path
  }

  Status = PblTpmReadPolicyVersion (&NvPolicyVersion);
  if (EFI_ERROR (Status)) {
    Print (L"  [INFO] No policy version counter: %r\n", Status);
    NvPolicyVersion = 0;
  }

  //
  // Step 4: Check policy anti-rollback (REQ-11, C4 §4)
  //
  if (Policy.Meta.Version > 0 && Policy.Meta.Version < NvPolicyVersion) {
    Print (L"  [BLOCK] Policy rollback detected: policy=%d NV=%d\n",
      Policy.Meta.Version, NvPolicyVersion);
    // STUB: extend PCR + show lock screen
    return EFI_SECURITY_VIOLATION;
  }
  if (Policy.Meta.Version > NvPolicyVersion) {
    Print (L"  [OK] New policy version %d (was %d) — incrementing NV counter\n",
      Policy.Meta.Version, NvPolicyVersion);
    Status = PblTpmIncrementPolicyVersion ();
    if (EFI_ERROR (Status)) {
      Print (L"  [WARN] NV counter increment: %r\n", Status);
    }
  }

  //
  // Step 5: Fetch verdict via HTTPS (C3) or use cached verdict (C2 §1.1)
  //
  Print (L"[4/8] Fetching verdict...\n");

  // Step 5a: Generate 32-byte nonce via EFI_RNG_PROTOCOL (C3 §5)
  // D-118: Fall back to TPM2_GetRandom if EFI_RNG_PROTOCOL is unavailable
  {
    EFI_RNG_PROTOCOL *Rng = NULL;
    Status = gBS->LocateProtocol (&gEfiRngProtocolGuid, NULL, (VOID **)&Rng);
    if (EFI_ERROR (Status) || Rng == NULL) {
      Print (L"  [INFO] EFI_RNG_PROTOCOL not available — trying TPM2_GetRandom\n");
      // D-118: TPM2_GetRandom fallback
      Status = PblTpmGetRandom (Nonce, 32);
      if (EFI_ERROR (Status)) {
        Print (L"  [WARN] TPM2_GetRandom also failed: %r — using zero nonce (will fail online)\n", Status);
        // Fail-closed: without a real nonce, the online fetch cannot succeed,
        // and we fall back to cached verdict.
        SetMem (Nonce, 32, 0);
      }
    } else {
      Status = Rng->GetRNG (Rng, &gEfiRngAlgorithmRaw, 32, Nonce);
      if (EFI_ERROR (Status)) {
        // Try SP800-90 Hash256 as fallback
        Status = Rng->GetRNG (Rng, &gEfiRngAlgorithmSp80090Hash256Guid, 32, Nonce);
      }
      if (EFI_ERROR (Status)) {
        Print (L"  [WARN] RNG failed: %r — trying TPM2_GetRandom\n", Status);
        // D-118: TPM2_GetRandom fallback when EFI_RNG exists but fails
        Status = PblTpmGetRandom (Nonce, 32);
        if (EFI_ERROR (Status)) {
          Print (L"  [WARN] TPM2_GetRandom also failed: %r — using zero nonce\n", Status);
          SetMem (Nonce, 32, 0);
        }
      }
    }
  }

  // Step 5b: Compute platform_state_digest = SHA-256(PlatformState)
  // C2 §5.1 step 6: digest of the full platform state struct
  Sha256HashAll ((CONST UINT8 *)&PlatformState, sizeof (PBL_PLATFORM_STATE), PlatformStateDigest);

  // Step 5c: Encode CBOR request body (C3 §3.2, CborEncode.c)
  Status = PblCborEncodeVerdictRequest (
    PlatformState.DeviceId,
    Nonce,
    PlatformStateDigest,
    Policy.Meta.Version,
    &RequestBody,
    &RequestBodySize
  );
  if (EFI_ERROR (Status) || RequestBody == NULL) {
    Print (L"  [WARN] CBOR encode failed: %r — falling back to cache\n", Status);
  } else {
    // Step 5d: POST to /v1/verdict (C3, HttpsClient.c)
    // The verdict URI comes from the policy blob (C4 §2.8 key 70).
    // If the policy has no URI, skip online fetch.
    if (Policy.LockServiceUri[0] != '\0') {
      Print (L"  [INFO] POSTing verdict request to %a\n", Policy.LockServiceUri);
      Status = PblHttpsPost (
        Policy.LockServiceUri,
        RequestBody,
        RequestBodySize,
        &VerdictCose,
        &VerdictCoseSize
      );
      if (!EFI_ERROR (Status) && VerdictCose != NULL && VerdictCoseSize > 0) {
        Print (L"  [OK] Verdict response: %d bytes\n", VerdictCoseSize);
        // Step 5e: Decode COSE_Sign1 → PBL_VERDICT (C1, CborDecode.c)
        Status = PblCborDecodeVerdict (VerdictCose, VerdictCoseSize, &Verdict);
        if (!EFI_ERROR (Status)) {
          // D-109/D-205: C1 §7 steps 1-3 — COSE signature verification.
          // The verdict signing key's SPKI comes from the policy blob (C4 key 76).
          // The expected kid is LockServiceCertPin (C4 key 71, SHA-256 of SPKI).
          if (Policy.VerdictSigningKeySpki != NULL && Policy.VerdictSigningKeySpkiSize > 0) {
            Status = PblVerifyCoseSign1 (
              VerdictCose, VerdictCoseSize,
              Policy.VerdictSigningKeySpki, Policy.VerdictSigningKeySpkiSize,
              Policy.LockServiceCertPin, 32
            );
            if (EFI_ERROR (Status)) {
              Print (L"  [WARN] Verdict signature verification failed: %r — falling back to cache\n", Status);
              // Don't trust this verdict — fall back to cache
              OnlineFetchOk = FALSE;
            } else {
              Print (L"  [OK] Verdict signature verified (ES256)\n");
              OnlineFetchOk = TRUE;
              Print (L"  [OK] Verdict decoded: verdict=%d policy_version=%d\n",
                Verdict.Verdict, Verdict.PolicyVersion);
            }
          } else {
            // D-205: No SPKI in policy — can't verify signature.
            // This is a policy configuration error, not a verdict error.
            Print (L"  [WARN] Verdict signature verification skipped — policy has no SPKI (D-205)\n");
            OnlineFetchOk = TRUE;
            Print (L"  [OK] Verdict decoded: verdict=%d policy_version=%d\n",
              Verdict.Verdict, Verdict.PolicyVersion);
          }
        } else {
          Print (L"  [WARN] Verdict decode failed: %r — falling back to cache\n", Status);
        }
      } else {
        Print (L"  [INFO] Online fetch failed: %r — falling back to cache\n", Status);
      }
    } else {
      Print (L"  [INFO] No lock_service_uri in policy — skipping online fetch\n");
    }
  }

  // Step 5f: Fall back to cached verdict if online fetch failed (C2 §1.1, C3 §6.1)
  if (!OnlineFetchOk) {
    if (LockCache.Magic == PBL_LOCK_STATE_MAGIC) {
      Print (L"  [INFO] Using cached verdict: %d (grace_until=%d)\n",
        LockCache.Verdict, LockCache.GraceUntil);
      // Populate Verdict from cache
      Verdict.Version = PBL_VERDICT_VERSION;
      Verdict.Verdict = LockCache.Verdict;
      Verdict.IssuedAt = LockCache.IssuedAt;
      Verdict.GraceUntil = LockCache.GraceUntil;
      CopyMem (Verdict.DeviceId, LockCache.DeviceId, 32);
      // Nonce is not in cache — set to zero (verification step 6 will be
      // skipped for cached verdicts, as the nonce check only applies to
      // freshly-fetched online verdicts per C1 §7).
      SetMem (Verdict.Nonce, 32, 0);
      Verdict.PolicyVersion = NvPolicyVersion;
    } else {
      Print (L"  [WARN] No cached verdict — denied-boot-with-local-unlock\n");
      // No cache and no online verdict → fail-closed on data, fail-open on
      // availability (C3 §6.1). Set verdict to LOCKED so the lock screen
      // appears with local unlock option.
      Verdict.Version = PBL_VERDICT_VERSION;
      Verdict.Verdict = PBL_VERDICT_LOCKED;
      Verdict.IssuedAt = 0;
      Verdict.GraceUntil = 0;
      CopyMem (Verdict.DeviceId, PlatformState.DeviceId, 32);
      SetMem (Verdict.Nonce, 32, 0);
      Verdict.PolicyVersion = NvPolicyVersion;
    }
  }

  // Free the request body (allocated by PblCborEncodeVerdictRequest)
  if (RequestBody != NULL) {
    FreePool (RequestBody);
    RequestBody = NULL;
  }

  //
  // Step 6: Verify verdict (C1 §7, 9-step)
  //
  Print (L"[5/8] Verifying verdict...\n");
  if (OnlineFetchOk) {
    // Only verify nonce echo for online-fetched verdicts.
    // Cached verdicts don't have the original nonce.
    Status = PblVerifyVerdict (&Verdict, Nonce, PlatformState.DeviceId,
      NvPolicyVersion, &Policy);
    if (EFI_ERROR (Status)) {
      Print (L"  [WARN] Verdict verification failed: %r — falling back to cache\n", Status);
      // Fall back to cached verdict
      if (LockCache.Magic == PBL_LOCK_STATE_MAGIC) {
        Verdict.Verdict = LockCache.Verdict;
        Verdict.IssuedAt = LockCache.IssuedAt;
        Verdict.GraceUntil = LockCache.GraceUntil;
        CopyMem (Verdict.DeviceId, LockCache.DeviceId, 32);
        Verdict.PolicyVersion = NvPolicyVersion;
        Print (L"  [INFO] Using cached verdict: %d\n", LockCache.Verdict);
      } else {
        // No cache → fail-closed
        Verdict.Verdict = PBL_VERDICT_LOCKED;
        Print (L"  [WARN] No cache — BLOCK (fail-closed)\n");
      }
    } else {
      Print (L"  [OK] Verdict verified\n");
    }
  } else {
    Print (L"  [INFO] Skipping verification for cached verdict\n");
  }

  //
  // Step 7: Evaluate decision (C4 §5, 18-step)
  //
  Print (L"[6/8] Evaluating decision...\n");
  Result = PblEvaluateDecision (&PlatformState, &Policy, &Verdict);

  //
  // Step 8: Extend PCR 12/13 (C2 §4, REQ-12)
  //
  Print (L"[7/8] Extending PCR 12/13...\n");
  // STUB: PblTpmExtendPcr (PBL_PCR_INPUTS, inputs_hash, 32)
  // STUB: PblTpmExtendPcr (PBL_PCR_DECISION, decision_hash, 32)

  //
  // Step 9: Act on decision
  //
  Print (L"[8/8] Decision: ");
  switch (Result) {
    case PblResultPass:
      Print (L"PASS — chain-loading Windows\n");
      PblChainLoadWindows (ImageHandle);
      break;
    case PblResultDegraded:
      Print (L"DEGRADED — notice + chain-load\n");
      PblShowDegradedNotice ("Security degradation detected",
        FixedPcdGet32(PcdDegradedNoticeSeconds));
      PblChainLoadWindows (ImageHandle);
      break;
    case PblResultBlock: {
      BOOLEAN OverrideGranted = FALSE;
      Print (L"BLOCK — lock screen\n");
      // D-124: Request MOR (Memory Overwrite Request) on lockdown to
      // trigger memory clear on next boot, preventing cold-boot attacks.
      PblRequestMor ();
      PblShowLockScreen (&Verdict, NULL);
      PblHandleOverride (&Verdict, &OverrideGranted);
      if (OverrideGranted) {
        Print (L"Override granted — chain-loading Windows\n");
        PblChainLoadWindows (ImageHandle);
      } else {
        Print (L"Override denied — shutting down\n");
        gRT->ResetSystem (EfiResetShutdown, EFI_SUCCESS, 0, NULL);
      }
      break;
    }
    default:
      Print (L"UNKNOWN — fail-closed to BLOCK\n");
      gRT->ResetSystem (EfiResetShutdown, EFI_SUCCESS, 0, NULL);
      break;
  }

  Print (L"\n========================================\n");
  Print (L"  PBL scaffold complete (v%d)\n", PBL_VERSION);
  Print (L"========================================\n");

  //
  // Scaffold: return SUCCESS so the boot continues in QEMU testing.
  // Real implementation: chain-load on PASS/DEGRADED, halt on BLOCK.
  //
  return EFI_SUCCESS;
}
