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

/** D-110: Read a file from a UEFI filesystem.

  Uses EFI_SIMPLE_FILE_SYSTEM_PROTOCOL to open the volume, then opens
  the file and reads its contents into an allocated buffer. The caller
  must free the buffer with gBS->FreePool.

  @param  FilePath  UEFI-style path (e.g., L"\\EFI\\PBL\\policy.cose").
  @param  Buffer    On success, allocated buffer containing file data.
  @param  BufferSize On success, size of Buffer in bytes.

  @retval EFI_SUCCESS           File read.
  @retval EFI_NOT_FOUND         Filesystem or file not found.
  @retval EFI_OUT_OF_RESOURCES  Allocation failed.
**/
STATIC
EFI_STATUS
PblReadFileFromFs (
  IN  CONST CHAR16 *FilePath,
  OUT UINT8       **Buffer,
  OUT UINTN        *BufferSize
  )
{
  EFI_STATUS                       Status;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *Sfs = NULL;
  EFI_FILE_PROTOCOL               *Root = NULL;
  EFI_FILE_PROTOCOL               *File = NULL;
  EFI_FILE_INFO                   *Info = NULL;
  UINTN                            InfoSize;
  UINT8                           *FileBuf = NULL;

  if (Buffer == NULL || BufferSize == NULL || FilePath == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *Buffer = NULL;
  *BufferSize = 0;

  // Locate the simple filesystem protocol (first available volume)
  EFI_HANDLE *Handles = NULL;
  UINTN       HandleCount = 0;
  Status = gBS->LocateHandleBuffer (
                  ByProtocol,
                  &gEfiSimpleFileSystemProtocolGuid,
                  NULL,
                  &HandleCount,
                  &Handles
                  );
  if (EFI_ERROR (Status) || HandleCount == 0) {
    return EFI_NOT_FOUND;
  }

  // Try each volume until we find the file
  for (UINTN i = 0; i < HandleCount; i++) {
    Sfs = NULL;
    Status = gBS->HandleProtocol (Handles[i], &gEfiSimpleFileSystemProtocolGuid, (VOID **)&Sfs);
    if (EFI_ERROR (Status) || Sfs == NULL) {
      continue;
    }

    Status = Sfs->OpenVolume (Sfs, &Root);
    if (EFI_ERROR (Status)) {
      continue;
    }

    Status = Root->Open (Root, &File, (CHAR16 *)FilePath, EFI_FILE_MODE_READ, 0);
    if (EFI_ERROR (Status)) {
      Root->Close (Root);
      continue;
    }

    // Get file size
    InfoSize = 0;
    Info = NULL;
    Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
    if (Status == EFI_BUFFER_TOO_SMALL) {
      Info = AllocatePool (InfoSize);
      if (Info == NULL) {
        File->Close (File);
        Root->Close (Root);
        gBS->FreePool (Handles);
        return EFI_OUT_OF_RESOURCES;
      }
      Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
    }
    if (EFI_ERROR (Status)) {
      if (Info != NULL) FreePool (Info);
      File->Close (File);
      Root->Close (Root);
      continue;
    }

    *BufferSize = (UINTN)Info->FileSize;
    FreePool (Info);

    if (*BufferSize == 0) {
      File->Close (File);
      Root->Close (Root);
      // Empty file — treat as not found
      continue;
    }

    FileBuf = AllocatePool (*BufferSize);
    if (FileBuf == NULL) {
      File->Close (File);
      Root->Close (Root);
      gBS->FreePool (Handles);
      return EFI_OUT_OF_RESOURCES;
    }

    // Read file contents
    UINTN ReadSize = *BufferSize;
    Status = File->Read (File, &ReadSize, FileBuf);
    File->Close (File);
    Root->Close (Root);

    if (EFI_ERROR (Status) || ReadSize != *BufferSize) {
      FreePool (FileBuf);
      continue;
    }

    // Success
    *Buffer = FileBuf;
    *BufferSize = ReadSize;
    gBS->FreePool (Handles);
    return EFI_SUCCESS;
  }

  gBS->FreePool (Handles);
  return EFI_NOT_FOUND;
}

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
  CHAR8                   Hostname[256];    // D-116: parsed from LockServiceUri for TLS pin

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
  // D-110: Read from ESP \EFI\PBL\policy.cose
  //
  Print (L"[2/8] Parsing policy blob...\n");
  Status = PblReadFileFromFs (L"\\EFI\\PBL\\policy.cose", &PolicyCose, &PolicyCoseSize);
  if (EFI_ERROR (Status)) {
    Print (L"  [INFO] No policy.cose on ESP: %r — using DEGRADED\n", Status);
    PolicyCose = NULL;
    PolicyCoseSize = 0;
  } else {
    Print (L"  [INFO] policy.cose: %u bytes\n", (UINT32)PolicyCoseSize);
  }
  Status = PblParsePolicy (PolicyCose, PolicyCoseSize, &Policy);
  if (EFI_ERROR (Status)) {
    Print (L"  [WARN] Policy parse: %r — using DEGRADED\n", Status);
    // No policy → DEGRADED (availability issue, not security violation)
  } else if (PolicyCose != NULL && PolicyCoseSize > 0) {
    // D-205/RE-hardening: Verify the policy blob's COSE_Sign1 signature
    // against the pinned policy signing key root of trust. The policy
    // blob cannot self-certify its own signing key (circular dependency),
    // so the key must come from PolicyRootOfTrust.c (compile-time constant
    // or read-only NV index provisioned at manufacturing time).
    //
    // Return values:
    //   EFI_SUCCESS     — signature verified, policy is authentic
    //   EFI_UNSUPPORTED — root of trust not provisioned (dev mode)
    //   other           — signature invalid or verification error → BLOCK
    //
    // In dev mode (EFI_UNSUPPORTED), we continue with a warning. When the
    // root of trust IS provisioned and verification fails, we fail-closed
    // to prevent an attacker from injecting a malicious policy blob with
    // arbitrary verdict signing keys, lock service URI, or TLS pins.
    Status = PblVerifyPolicySignature (&Policy, PolicyCose, PolicyCoseSize);
    if (Status == EFI_UNSUPPORTED) {
      Print (L"  [INFO] Policy sig verify skipped — root of trust not provisioned (dev mode)\n");
    } else if (EFI_ERROR (Status)) {
      Print (L"  [BLOCK] Policy signature verification FAILED: %r\n", Status);
      Print (L"  [BLOCK] Policy blob may be tampered — refusing to boot\n");
      // Fail-closed: a policy with an invalid signature cannot be trusted.
      // The verdict signing key, lock service URI, and TLS pins all come
      // from the policy blob — if the blob is tampered, an attacker could
      // redirect verdict fetches to a malicious server or inject their own
      // signing key. Block immediately.
      return EFI_SECURITY_VIOLATION;
    } else {
      Print (L"  [OK] Policy signature verified (root of trust)\n");
    }
  }

  //
  // Step 3: Read cached lock state + policy version from TPM NV (C2 §5.1)
  //
  Print (L"[3/8] Reading TPM NV state...\n");

  // D-205: Provision NV indices on first boot (C2 §5.4).
  // If the NV indices don't exist yet (first boot or TPM cleared),
  // define them using TPM_RH_PLATFORM auth. If they already exist,
  // the error is ignored. This runs BEFORE the HMAC session starts
  // so it uses TPM_RS_PW password auth (empty platform password in
  // dev/swtpm), avoiding HMAC session parameter encryption issues
  // with NV_DefineSpace.
  Status = PblTpmProvisionNvIndices ();
  if (EFI_ERROR (Status) && Status != EFI_ALREADY_STARTED) {
    Print (L"  [WARN] NV index provisioning failed: %r\n", Status);
  } else if (!EFI_ERROR (Status)) {
    Print (L"  [OK] NV indices provisioned\n");
  }

  // D-102: Start HMAC session bound to TPM_RH_NULL (C2 §3.1, §3.3).
  // The session provides AES-256-CFB parameter encryption for all NV reads/writes.
  // Binding to TPM_RH_NULL creates an unbound session that still provides
  // parameter encryption. Binding to the NV index would require it to be
  // defined first (NV_DefineSpace), which hasn't been called yet.
  // In development mode (no auth value provisioned), bindAuth is empty.
  // If session start fails, commands fall back to TPM_RS_PW (C2 §3.2 minimum).
  Status = PblTpmStartHmacSession ((UINT32)TPM_RH_NULL, NULL, 0);
  if (EFI_ERROR (Status)) {
    Print (L"  [INFO] HMAC session start failed: %r — using password auth\n", Status);
    // Continue — PblTpmBeginCommandWithSessionAuth falls back to TPM_RS_PW
  } else {
    Print (L"  [OK] HMAC session established (AES-256-CFB)\n");
  }

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
      // D-116: Parse hostname from LockServiceUri for TLS pin verification
      ZeroMem (Hostname, sizeof (Hostname));
      PblParseUriHostname (Policy.LockServiceUri, Hostname, sizeof (Hostname));
      Print (L"  [INFO] POSTing verdict request to %a\n", Policy.LockServiceUri);
      Status = PblHttpsPost (
        Policy.LockServiceUri,
        RequestBody,
        RequestBodySize,
        Policy.TlsCaPin,     // D-116: C4 key 73 (32-byte SHA-256 of CA cert)
        Hostname,             // D-116: parsed from LockServiceUri
        &VerdictCose,
        &VerdictCoseSize
      );
      if (!EFI_ERROR (Status) && VerdictCose != NULL && VerdictCoseSize > 0) {
        Print (L"  [OK] Verdict response: %d bytes\n", VerdictCoseSize);
        // Step 5e: Decode COSE_Sign1 → PBL_VERDICT (C1, CborDecode.c)
        Status = PblCborDecodeVerdict (VerdictCose, VerdictCoseSize, &Verdict);
        if (!EFI_ERROR (Status)) {
          // D-109/D-205: C1 §7 steps 1-3 — COSE signature verification.
          // The verdict signing key's X.509 leaf cert comes from the policy
          // blob (C4 key 77, signing_cert_chain). The expected kid is
          // LockServiceCertPin (C4 key 71, SHA-256 of SPKI).
          if (Policy.VerdictSigningCert != NULL && Policy.VerdictSigningCertSize > 0) {
            // D-205: Validate the X.509 cert chain before using the leaf
            // cert for signature verification. C1 §5: "The cert chain is
            // validated up to the root pinned in C4."
            if (Policy.VerdictSigningCertChain != NULL &&
                Policy.VerdictSigningCertChainSize > 0 &&
                Policy.VerdictSigningRootCert != NULL &&
                Policy.VerdictSigningRootCertSize > 0) {
              Status = PblVerifyCertChain (
                Policy.VerdictSigningRootCert,
                Policy.VerdictSigningRootCertSize,
                Policy.VerdictSigningCertChain,
                Policy.VerdictSigningCertChainSize
              );
              if (EFI_ERROR (Status)) {
                Print (L"  [WARN] Cert chain validation failed: %r — falling back to cache\n", Status);
                OnlineFetchOk = FALSE;
                goto VerdictDone;
              }
              Print (L"  [OK] Cert chain validated\n");
            }

            Status = PblVerifyCoseSign1 (
              VerdictCose, VerdictCoseSize,
              Policy.VerdictSigningCert, Policy.VerdictSigningCertSize,
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
            // D-205 fail-closed: No cert chain in policy — cannot verify
            // signature. C1 §1.2: "No other verification path exists — PBL
            // does not trust the platform TLS store for verdict
            // verification." An unsigned verdict is not trustworthy.
            // Reject and fall back to cache (or BLOCK if no cache).
            Print (L"  [WARN] Verdict rejected — policy has no cert chain (D-205 fail-closed)\n");
            OnlineFetchOk = FALSE;
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
VerdictDone:

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
  // Step 6c: Persist the final verdict to TPM NV (C2 §5.2).
  // Regardless of whether the verdict came from the network or from the
  // local cache/fail-closed path, write it back to the PBL_LOCK_STATE index
  // so the next boot can use it offline. A write failure is logged but not
  // fatal — PBL continues to act on the verdict already in memory.
  //
  {
    PBL_LOCK_STATE_CACHE NewCache;
    ZeroMem (&NewCache, sizeof (NewCache));
    NewCache.Magic = PBL_LOCK_STATE_MAGIC;
    NewCache.Verdict = Verdict.Verdict;
    NewCache.IssuedAt = Verdict.IssuedAt;
    NewCache.GraceUntil = Verdict.GraceUntil;
    CopyMem (NewCache.DeviceId, Verdict.DeviceId, 32);

    Status = PblTpmWriteLockState (&NewCache);
    if (EFI_ERROR (Status)) {
      Print (L"  [WARN] NV_Write(LOCK_STATE) failed: %r\n", Status);
    } else {
      Print (L"  [OK] Lock state cached to TPM NV\n");
    }
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

  // D-102: Start PCR session (bound to TPM_RH_NULL, C2 §3.3) for PCR extends.
  Status = PblTpmStartPcrSession ();
  if (EFI_ERROR (Status)) {
    Print (L"  [INFO] PCR session start failed: %r — using no-session\n", Status);
    // Continue — PblTpmExtendPcr falls back to no-session
  } else {
    Print (L"  [OK] PCR HMAC session established\n");
  }

  // D-206: Extend PCR 13 (inputs) and PCR 12 (decision) per C2 §4.
  //   PCR 13 = SHA-256(policy_blob_hash || nonce || device_id || pcr4 || pcr5 || pcr7 || pcr11)
  //   PCR 12 = SHA-256(verdict || policy_version || platform_state_digest || final_result)
  //
  // RE-hardening #4 (REVERTED): Self-image hash was added to PCR 12 but
  // produced a different hash every boot because PBL's PE has ImageBase=0,
  // so UEFI applies DIR64 relocations at a different load address each
  // boot. This made PCR 12 non-deterministic and broke attestation.
  // Secure Boot already verifies the PE signature before PBL runs,
  // providing the integrity guarantee that the self-image hash was
  // meant to add. See D-212 in the debt ledger.
  {
    UINT8 InputsHash[32];
    UINT8 DecisionHash[32];

    // PCR 13 (inputs): hash the platform state inputs
    // C2 §4: SHA-256(policy_blob_hash || nonce || device_id || pcr4 || pcr5 || pcr7 || pcr11)
    // For simplicity, hash the full PlatformState struct (which includes all
    // PCR values and device_id) concatenated with the nonce and policy hash.
    // The policy blob hash is SHA-256 of the raw CBOR.
    UINT8 PolicyBlobHash[32];
    if (Policy.RawCbor != NULL && Policy.RawCborSize > 0) {
      Sha256HashAll (Policy.RawCbor, Policy.RawCborSize, PolicyBlobHash);
    } else {
      ZeroMem (PolicyBlobHash, 32);
    }

    // Build inputs digest: PolicyBlobHash || Nonce || DeviceId || Pcr4 || Pcr5 || Pcr7 || Pcr11
    UINTN InputsSize = 32 + 32 + 32 + 32 + 32 + 32 + 32;
    UINT8 *InputsBuf = AllocatePool (InputsSize);
    if (InputsBuf != NULL) {
      UINT8 *P = InputsBuf;
      CopyMem (P, PolicyBlobHash, 32);  P += 32;
      CopyMem (P, Nonce, 32);             P += 32;
      CopyMem (P, PlatformState.DeviceId, 32); P += 32;
      CopyMem (P, PlatformState.Pcr4, 32);     P += 32;
      CopyMem (P, PlatformState.Pcr5, 32);     P += 32;
      CopyMem (P, PlatformState.Pcr7, 32);     P += 32;
      CopyMem (P, PlatformState.Pcr11, 32);    P += 32;
      Sha256HashAll (InputsBuf, InputsSize, InputsHash);
      FreePool (InputsBuf);
    } else {
      ZeroMem (InputsHash, 32);
    }

    Status = PblTpmExtendPcr (PBL_PCR_INPUTS, InputsHash, 32);
    if (EFI_ERROR (Status)) {
      Print (L"  [WARN] PCR 13 (inputs) extend failed: %r\n", Status);
    } else {
      Print (L"  [OK] PCR 13 (inputs) extended\n");
    }

    // PCR 12 (decision): SHA-256(verdict || policy_version || platform_state_digest || final_result)
    // C2 §4: verdict byte || policy_version (8 bytes BE) || platform_state_digest || final_result (1 byte)
    UINTN DecisionSize = 1 + 8 + 32 + 1;
    UINT8 *DecisionBuf = AllocatePool (DecisionSize);
    if (DecisionBuf != NULL) {
      UINT8 *P = DecisionBuf;
      *P++ = Verdict.Verdict;
      UINT64 PolicyVersionBe = SwapBytes64 (Verdict.PolicyVersion);
      CopyMem (P, &PolicyVersionBe, 8); P += 8;
      CopyMem (P, PlatformStateDigest, 32); P += 32;
      *P++ = (UINT8)Result;
      Sha256HashAll (DecisionBuf, DecisionSize, DecisionHash);
      FreePool (DecisionBuf);
    } else {
      ZeroMem (DecisionHash, 32);
    }

    Status = PblTpmExtendPcr (PBL_PCR_DECISION, DecisionHash, 32);
    if (EFI_ERROR (Status)) {
      Print (L"  [WARN] PCR 12 (decision) extend failed: %r\n", Status);
    } else {
      Print (L"  [OK] PCR 12 (decision) extended\n");
    }
  }

  //
  // Step 9: Act on decision
  //
  Print (L"[8/8] Decision: ");
  switch (Result) {
    case PblResultPass:
      Print (L"PASS — chain-loading Windows\n");
      PblTpmFlushSession ();
      PblTpmFlushPcrSession ();
      PblChainLoadWindows (ImageHandle, &Policy);
      break;
    case PblResultDegraded:
      Print (L"DEGRADED — notice + chain-load\n");
      PblShowDegradedNotice ("Security degradation detected",
        FixedPcdGet32(PcdDegradedNoticeSeconds));
      PblTpmFlushSession ();
      PblTpmFlushPcrSession ();
      PblChainLoadWindows (ImageHandle, &Policy);
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
        PblTpmFlushSession ();
        PblTpmFlushPcrSession ();
        PblChainLoadWindows (ImageHandle, &Policy);
      } else {
        Print (L"Override denied — shutting down\n");
        PblTpmFlushSession ();
        PblTpmFlushPcrSession ();
        gRT->ResetSystem (EfiResetShutdown, EFI_SUCCESS, 0, NULL);
      }
      break;
    }
    default:
      Print (L"UNKNOWN — fail-closed to BLOCK\n");
      PblTpmFlushSession ();
      PblTpmFlushPcrSession ();
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
