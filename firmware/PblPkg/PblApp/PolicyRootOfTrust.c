/** @file
  PolicyRootOfTrust.c — Policy signing key root of trust (D-205).

  The policy signing key is a long-lived root key pinned in firmware (C4 §1).
  Its SPKI is a compile-time constant — the key can only be rotated with a
  firmware update. This is distinct from the verdict signing key, whose SPKI
  comes from the policy blob (C4 key 76) and can be rotated via policy updates.

  This file defines the pinned policy signing key SPKI and its SHA-256
  (the expected kid). In production, these constants are populated at build
  time from the offline root CA's policy signing key. In development, they
  are zero-filled and PblVerifyPolicySignature() returns EFI_UNSUPPORTED.

  To provision:
  1. Generate the policy signing key (server-side: loadOrGeneratePolicySigningKey)
  2. Export the SPKI (DER bytes)
  3. Compute SHA-256 of the SPKI (the kid)
  4. Fill in gPblPolicySigningKeySpki[] and gPblPolicySigningKeySpkiSize
  5. Fill in gPblPolicySigningKeyKid[] (32 bytes)
  6. Rebuild the firmware

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// Pinned policy signing key (root of trust)
// ============================================================================

// D-205/D-215: The policy signing key SPKI + kid + cert are provisioned at
// build time by firmware/PblPkg/gen-policy-rot.py, which emits
// PolicyRootOfTrust.generated.h. When the header exists, it defines:
//   static CONST UINT8 gPblPolicySigningKeySpki[<n>];
//   static CONST UINTN gPblPolicySigningKeySpkiSize;
//   static CONST UINT8 gPblPolicySigningKeyKid[32];
//   static CONST UINT8 gPblPolicySigningKeyCert[<m>];
//   static CONST UINTN gPblPolicySigningKeyCertSize;
//
// When the header does NOT exist (development without provisioning),
// the SPKI size is 0 and PblVerifyPolicySignature() returns EFI_UNSUPPORTED.
//
// NOTE: the include is gated by __has_include — the header's own include
// guard macro cannot be used here (it is only defined inside the header,
// so an #ifdef on it would never fire and the generated file would be
// dead code even when present).
//
// To provision:
//   python3 firmware/PblPkg/gen-policy-rot.py --emit-header
//   (rebuild firmware)

#if defined(__has_include)
  #if __has_include("PolicyRootOfTrust.generated.h")
    #include "PolicyRootOfTrust.generated.h"
    #define PBL_POLICY_ROT_PROVISIONED  1
  #endif
#endif

#if !defined(PBL_POLICY_ROT_PROVISIONED)
// Development mode: root of trust not provisioned
static CONST UINT8 gPblPolicySigningKeySpki[1] = { 0x00 };
static CONST UINTN gPblPolicySigningKeySpkiSize = 0;
static CONST UINT8 gPblPolicySigningKeyKid[32] = { 0 };
// D-205: Policy signing key cert DER (for EcGetPublicKeyFromX509).
// In production, this is a self-signed root CA cert pinned at build time.
static CONST UINT8 gPblPolicySigningKeyCert[1] = { 0x00 };
static CONST UINTN gPblPolicySigningKeyCertSize = 0;
#endif

/** Check whether the policy signing key root of trust is provisioned.

  @retval TRUE   Root of trust is provisioned (SPKI size > 0).
  @retval FALSE  Root of trust is not provisioned (development mode).
**/
BOOLEAN
PblPolicySigningKeyIsProvisioned (
  VOID
  )
{
  return gPblPolicySigningKeySpkiSize > 0;
}

/** Get the pinned policy signing key SPKI.

  @param  SpkiSize  Output: size of the SPKI (0 if not provisioned).

  @retval Pointer to the SPKI bytes, or NULL if not provisioned.
**/
CONST UINT8 *
PblGetPolicySigningKeySpki (
  OUT UINTN  *SpkiSize
  )
{
  if (SpkiSize == NULL) {
    return NULL;
  }
  *SpkiSize = gPblPolicySigningKeySpkiSize;
  if (gPblPolicySigningKeySpkiSize == 0) {
    return NULL;
  }
  return gPblPolicySigningKeySpki;
}

/** Get the pinned policy signing key kid (SHA-256 of SPKI, 32 bytes).

  @retval Pointer to the 32-byte kid, or NULL if not provisioned.
**/
CONST UINT8 *
PblGetPolicySigningKeyKid (
  VOID
  )
{
  if (gPblPolicySigningKeySpkiSize == 0) {
    return NULL;
  }
  return gPblPolicySigningKeyKid;
}

/** Get the pinned policy signing key X.509 cert DER (D-205).

  Used by PblVerifyPolicySignature() to obtain an EC context via
  EcGetPublicKeyFromX509(). In production, this is a self-signed
  root CA cert pinned at build time.

  @param  CertSize  Output: size of the cert DER (0 if not provisioned).

  @retval Pointer to the cert DER bytes, or NULL if not provisioned.
**/
CONST UINT8 *
PblGetPolicySigningKeyCert (
  OUT UINTN  *CertSize
  )
{
  if (CertSize == NULL) {
    return NULL;
  }
  *CertSize = gPblPolicySigningKeyCertSize;
  if (gPblPolicySigningKeyCertSize == 0) {
    return NULL;
  }
  return gPblPolicySigningKeyCert;
}
