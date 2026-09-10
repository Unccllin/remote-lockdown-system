/** @file
  Policy.c — C4 policy blob parsing and verification.

  PblParsePolicy: Extract CBOR map from COSE_Sign1, parse fields into
  PBL_POLICY struct. Does NOT verify the COSE signature — that is
  PblVerifyPolicySignature's job. The caller should call both:
    1. PblParsePolicy (CoseData, CoseSize, &Policy)
    2. PblVerifyPolicySignature (&Policy, CoseData, CoseSize)
    3. Check Policy.Meta.Version >= NvPolicyVersion (anti-rollback)

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// C4: Policy blob parsing
// ============================================================================

/** C4: Parse a COSE_Sign1 policy blob into PBL_POLICY.

  This function delegates to PblCborDecodePolicy for the CBOR/COSE
  parsing. It does NOT verify the signature — use
  PblVerifyPolicySignature for that.

  @param  CoseData  The COSE_Sign1 policy blob bytes.
  @param  CoseSize  Size of CoseData.
  @param  Policy    Output: parsed policy struct.

  @retval EFI_SUCCESS           Policy parsed.
  @retval EFI_INVALID_PARAMETER NULL parameter or empty input.
  @retval EFI_NOT_FOUND         No policy data (CoseData is NULL).
  @retval EFI_PROTOCOL_ERROR    Malformed CBOR/COSE.
**/
EFI_STATUS
PblParsePolicy (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_POLICY    *Policy
  )
{
  if (Policy == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // No policy data available — return EFI_NOT_FOUND with zeroed policy
  if (CoseData == NULL || CoseSize == 0) {
    ZeroMem (Policy, sizeof (PBL_POLICY));
    return EFI_NOT_FOUND;
  }

  // Delegate to the CBOR decoder
  return PblCborDecodePolicy (CoseData, CoseSize, Policy);
}

/** C4 §1: Verify the COSE_Sign1 signature on a policy blob.

  This function verifies that the policy blob's signature is valid
  and was signed by the **policy signing key** (not the verdict signing key).
  The policy signing key is separate from the verdict signing key (C4 §1)
  and must come from a **root of trust** — not from the policy blob itself
  (that would be circular: you'd need the key to verify the policy that
  contains the key).

  The policy signing key's SPKI is expected to be pinned in firmware
  (e.g., compiled into the PBL binary or stored in a read-only NV index
  provisioned at manufacturing time). This is distinct from the verdict
  signing key's SPKI, which comes from the policy blob (C4 key 76).

  Until the policy signing key SPKI is provisioned as a root of trust,
  this function returns EFI_UNSUPPORTED. The verdict signing key SPKI
  (from the policy blob, key 76) is used by PblVerifyCoseSign1() in the
  verdict flow — NOT here.

  @param  Policy    The parsed policy (for reference, if needed).
  @param  CoseData  The raw COSE_Sign1 bytes.
  @param  CoseSize  Size of CoseData.

  @retval EFI_SUCCESS           Signature valid.
  @retval EFI_UNSUPPORTED       Policy signing key SPKI not provisioned as root of trust.
**/
EFI_STATUS
PblVerifyPolicySignature (
  IN CONST PBL_POLICY  *Policy,
  IN CONST UINT8       *CoseData,
  IN UINTN              CoseSize
  )
{
  // D-110/D-205: The policy signing key SPKI comes from the root of trust
  // (PolicyRootOfTrust.c — compile-time constant or read-only NV index).
  // The policy blob cannot self-certify its own signing key (circular).
  //
  // The policy blob contains the *verdict* signing key's SPKI (key 76),
  // which is used by PblVerifyCoseSign1() in the verdict flow (PblApp.c).
  //
  // If the root of trust is not provisioned (development mode), return
  // EFI_UNSUPPORTED. If it is provisioned, verify the policy signature.
  (VOID)Policy;

  if (!PblPolicySigningKeyIsProvisioned ()) {
    return EFI_UNSUPPORTED;
  }

  UINTN        CertSize;
  CONST UINT8 *Cert = PblGetPolicySigningKeyCert (&CertSize);
  CONST UINT8 *Kid  = PblGetPolicySigningKeyKid ();

  if (Cert == NULL || Kid == NULL || CertSize == 0) {
    return EFI_UNSUPPORTED;
  }

  return PblVerifyCoseSign1 (
    CoseData, CoseSize,
    Cert, CertSize,
    Kid, 32
  );
}
