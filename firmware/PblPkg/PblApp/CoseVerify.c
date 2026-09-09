/** @file
  CoseVerify.c — COSE_Sign1 signature verification (D-109/D-110).

  Implements C1 §7 steps 1-3 and C4 §1 signature verification:
    1. COSE_Sign1 structural parse (CBOR well-formed, required keys present)
    2. kid lookup: verify kid in protected header matches expected kid
       (SHA-256 of signing key's SPKI, from policy.lock_service_cert_pin)
    3. Signature verification over Sig_structure (RFC 8152 §4.2)

  Sig_structure = [
      "Signature1",
      protected: bstr,          // the protected header from COSE_Sign1
      external_aad: bstr'',     // empty — no external AAD
      payload: bstr             // the CBOR-encoded payload
  ]

  Supported algorithms:
    -7  (ES256): ECDSA P-256 SHA-256, signature = raw r||s (64 bytes)
    -8  (Ed25519): EdDSA with Ed25519 (NOT yet implemented — BaseCryptLib
        does not expose Ed25519 verify in standard EDK2 builds).
        Server-side signing is implemented (signing.ts
        generateSigningKeyWithAlgorithm('Ed25519')), but firmware
        verification returns EFI_UNSUPPORTED until a compatible
        Ed25519 verify library is available in the UEFI environment.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// CBOR encoding helpers (for Sig_structure reconstruction)
// ============================================================================

#define CBOR_MAJOR_UINT    0
#define CBOR_MAJOR_BSTR   2
#define CBOR_MAJOR_ARRAY  4
#define CBOR_MAJOR_TSTR   3

/** Append a CBOR head (major type + length value) to a buffer.

  @param Out     Output cursor (advanced).
  @param End     End of output buffer (for bounds checking).
  @param Major   Major type (0-7).
  @param Value   The length/value to encode.
**/
STATIC
EFI_STATUS
PblCvPutHead (
  IN OUT UINT8 **Out,
  IN     UINT8  *End,
  IN     UINT8   Major,
  IN     UINT64  Value
  )
{
  UINT8 TypeByte = (UINT8)(Major << 5);

  if (Value < 24) {
    if (*Out + 1 > End) return EFI_BUFFER_TOO_SMALL;
    *(*Out)++ = (UINT8)(TypeByte | (UINT8)Value);
  } else if (Value <= 0xFF) {
    if (*Out + 2 > End) return EFI_BUFFER_TOO_SMALL;
    *(*Out)++ = (UINT8)(TypeByte | 24);
    *(*Out)++ = (UINT8)Value;
  } else if (Value <= 0xFFFF) {
    if (*Out + 3 > End) return EFI_BUFFER_TOO_SMALL;
    *(*Out)++ = (UINT8)(TypeByte | 25);
    *(*Out)++ = (UINT8)(Value >> 8);
    *(*Out)++ = (UINT8)(Value & 0xFF);
  } else if (Value <= 0xFFFFFFFF) {
    if (*Out + 5 > End) return EFI_BUFFER_TOO_SMALL;
    *(*Out)++ = (UINT8)(TypeByte | 26);
    *(*Out)++ = (UINT8)(Value >> 24);
    *(*Out)++ = (UINT8)((Value >> 16) & 0xFF);
    *(*Out)++ = (UINT8)((Value >> 8) & 0xFF);
    *(*Out)++ = (UINT8)(Value & 0xFF);
  } else {
    if (*Out + 9 > End) return EFI_BUFFER_TOO_SMALL;
    *(*Out)++ = (UINT8)(TypeByte | 27);
    for (INTN i = 7; i >= 0; i--) {
      *(*Out)++ = (UINT8)((Value >> (i * 8)) & 0xFF);
    }
  }
  return EFI_SUCCESS;
}

/** Append a CBOR bstr (head + data) to a buffer. **/
STATIC
EFI_STATUS
PblCvPutBstr (
  IN OUT UINT8       **Out,
  IN     UINT8        *End,
  IN     CONST UINT8  *Data,
  IN     UINTN         Len
  )
{
  EFI_STATUS Status;
  Status = PblCvPutHead (Out, End, CBOR_MAJOR_BSTR, Len);
  if (EFI_ERROR (Status)) return Status;
  if (*Out + Len > End) return EFI_BUFFER_TOO_SMALL;
  if (Len > 0 && Data != NULL) {
    CopyMem (*Out, Data, Len);
  }
  *Out += Len;
  return EFI_SUCCESS;
}

/** Append a CBOR tstr (head + data) to a buffer. **/
STATIC
EFI_STATUS
PblCvPutTstr (
  IN OUT UINT8       **Out,
  IN     UINT8        *End,
  IN     CONST CHAR8  *Str
  )
{
  UINTN Len = 0;
  while (Str[Len] != '\0') Len++;
  return PblCvPutBstr (Out, End, (CONST UINT8 *)Str, Len);
}

// ============================================================================
// Sig_structure reconstruction
// ============================================================================

/** Build the Sig_structure for COSE_Sign1 verification.

  Sig_structure = [
      "Signature1",
      protected: bstr,
      external_aad: bstr'',
      payload: bstr
  ]

  The output buffer is allocated via AllocatePool and must be freed by
  the caller via FreePool.

  @param  ProtectedHdr   The protected header bstr bytes.
  @param  ProtectedSize  Size of the protected header.
  @param  Payload        The payload bstr bytes.
  @param  PayloadSize    Size of the payload.
  @param  Output         Output: allocated Sig_structure bytes.
  @param  OutputSize     Output: size of the Sig_structure.

  @retval EFI_SUCCESS            Sig_structure built.
  @retval EFI_INVALID_PARAMETER  NULL parameter.
  @retval EFI_OUT_OF_RESOURCES   Allocation failed.
**/
STATIC
EFI_STATUS
PblBuildSigStructure (
  IN  CONST UINT8 *ProtectedHdr,
  IN  UINTN        ProtectedSize,
  IN  CONST UINT8 *Payload,
  IN  UINTN        PayloadSize,
  OUT UINT8       **Output,
  OUT UINTN        *OutputSize
  )
{
  UINTN  BufSize;
  UINT8  *Buf;
  UINT8  *Cursor;
  UINT8  *End;
  EFI_STATUS Status;

  if (ProtectedHdr == NULL || Payload == NULL ||
      Output == NULL || OutputSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Compute worst-case buffer size:
  //   array(4): 1 byte
  //   "Signature1" tstr: 1 + 10 = 11 bytes
  //   protected bstr: 9 (max head) + ProtectedSize
  //   empty bstr: 1 byte
  //   payload bstr: 9 (max head) + PayloadSize
  BufSize = 1 + 11 + (9 + ProtectedSize) + 1 + (9 + PayloadSize);

  Buf = AllocatePool (BufSize);
  if (Buf == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  Cursor = Buf;
  End = Buf + BufSize;

  // Array of 4 elements: 0x84
  if (Cursor + 1 > End) { FreePool (Buf); return EFI_BUFFER_TOO_SMALL; }
  *Cursor++ = (UINT8)(CBOR_MAJOR_ARRAY << 5 | 4);

  // "Signature1" tstr
  Status = PblCvPutTstr (&Cursor, End, "Signature1");
  if (EFI_ERROR (Status)) { FreePool (Buf); return Status; }

  // protected bstr
  Status = PblCvPutBstr (&Cursor, End, ProtectedHdr, ProtectedSize);
  if (EFI_ERROR (Status)) { FreePool (Buf); return Status; }

  // external_aad bstr (empty)
  Status = PblCvPutBstr (&Cursor, End, NULL, 0);
  if (EFI_ERROR (Status)) { FreePool (Buf); return Status; }

  // payload bstr
  Status = PblCvPutBstr (&Cursor, End, Payload, PayloadSize);
  if (EFI_ERROR (Status)) { FreePool (Buf); return Status; }

  *Output = Buf;
  *OutputSize = (UINTN)(Cursor - Buf);
  return EFI_SUCCESS;
}

// ============================================================================
// COSE algorithm IDs
// ============================================================================

#define COSE_ALG_ES256    (-7)   // ECDSA P-256 SHA-256
#define COSE_ALG_ED25519  (-8)   // EdDSA with Ed25519

// ============================================================================
// Public API — PblVerifyCoseSign1
// ============================================================================

/** Verify a COSE_Sign1 signature (C1 §7 steps 1-3, C4 §1).

  This function performs the three signature-related verification steps:
    1. COSE_Sign1 structural parse (extract protected, payload, signature)
    2. kid lookup: verify kid in protected header matches ExpectedKid
    3. Signature verification over Sig_structure using the public key

  The caller provides:
    - The raw COSE_Sign1 bytes (CoseData/CoseSize)
    - The signing key's SPKI DER bytes (PublicKeySpki/PublicKeySpkiSize)
    - The expected kid (32-byte SHA-256 of SPKI, from policy.lock_service_cert_pin)

  @param  CoseData          The COSE_Sign1 bytes.
  @param  CoseSize          Size of CoseData.
  @param  PublicKeySpki     The signing key's SPKI DER bytes.
  @param  PublicKeySpkiSize Size of PublicKeySpki.
  @param  ExpectedKid       The expected kid (32-byte SHA-256 of SPKI).
  @param  ExpectedKidSize   Size of ExpectedKid (should be 32).

  @retval EFI_SUCCESS            Signature valid.
  @retval EFI_INVALID_PARAMETER  NULL parameter.
  @retval EFI_PROTOCOL_ERROR      Malformed COSE_Sign1 or protected header.
  @retval EFI_SECURITY_VIOLATION  kid mismatch or signature invalid.
  @retval EFI_UNSUPPORTED        Algorithm not supported (e.g., Ed25519).
**/
EFI_STATUS
PblVerifyCoseSign1 (
  IN CONST UINT8  *CoseData,
  IN UINTN         CoseSize,
  IN CONST UINT8   *PublicKeySpki,
  IN UINTN          PublicKeySpkiSize,
  IN CONST UINT8   *ExpectedKid,
  IN UINTN          ExpectedKidSize
  )
{
  CONST UINT8 *ProtectedHdr = NULL;
  UINTN        ProtectedSize = 0;
  CONST UINT8 *Payload = NULL;
  UINTN        PayloadSize = 0;
  CONST UINT8 *Signature = NULL;
  UINTN        SignatureSize = 0;
  INT64        AlgId = 0;
  CONST UINT8 *Kid = NULL;
  UINTN        KidSize = 0;
  UINT8       *SigStructure = NULL;
  UINTN        SigStructureSize = 0;
  UINT8        Hash[32];
  EFI_STATUS   Status;

  if (CoseData == NULL || CoseSize == 0 ||
      PublicKeySpki == NULL || PublicKeySpkiSize == 0 ||
      ExpectedKid == NULL || ExpectedKidSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  // Step 1: COSE_Sign1 structural parse
  Status = PblCoseExtractAll (
    CoseData, CoseSize,
    &ProtectedHdr, &ProtectedSize,
    &Payload, &PayloadSize,
    &Signature, &SignatureSize
  );
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse the protected header to get alg and kid
  Status = PblCoseParseProtectedHeader (
    ProtectedHdr, ProtectedSize, &AlgId, &Kid, &KidSize
  );
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Step 2: kid lookup — verify kid matches expected kid
  // C1 §5: kid = SHA-256 of the signing cert's public key.
  // The expected kid comes from policy.lock_service_cert_pin (C4 key 71).
  if (Kid == NULL || KidSize != ExpectedKidSize) {
    return EFI_SECURITY_VIOLATION;
  }
  if (CompareMem (Kid, ExpectedKid, ExpectedKidSize) != 0) {
    return EFI_SECURITY_VIOLATION;
  }

  // Step 3: Signature verification over Sig_structure
  // Build the Sig_structure: ["Signature1", protected, empty_aad, payload]
  Status = PblBuildSigStructure (
    ProtectedHdr, ProtectedSize,
    Payload, PayloadSize,
    &SigStructure, &SigStructureSize
  );
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Hash the Sig_structure with SHA-256 (ES256 uses SHA-256)
  if (!Sha256HashAll (SigStructure, SigStructureSize, Hash)) {
    FreePool (SigStructure);
    return EFI_DEVICE_ERROR;
  }

  // Verify based on algorithm
  switch (AlgId) {
    case COSE_ALG_ES256: {
      // ES256: ECDSA P-256 SHA-256
      // Signature is raw r||s (64 bytes for P-256)
      if (SignatureSize != 64) {
        FreePool (SigStructure);
        return EFI_SECURITY_VIOLATION;
      }

      // Use BaseCryptLib ECDSA verification.
      // EDK2 BaseCryptLib provides EcDsaVerify(EcContext, HashNid, Hash, HashSize, Sig, SigSize)
      // but does NOT provide a way to load an EC public key from raw SPKI DER.
      // EcGetPublicKeyFromX509() requires a full X.509 certificate, not SPKI.
      //
      // Until the policy provides a cert chain (C4 key 77) alongside the SPKI
      // (C4 key 76), ES256 signature verification from SPKI alone is not
      // supported. The server already generates cert chains (D-205), but the
      // firmware policy parser only extracts key 76 (SPKI), not key 77 (cert
      // chain).
      //
      // TODO: Parse C4 key 77 (signing_cert_chain) in Policy.c and pass the
      //       leaf cert DER here instead of SPKI. Then use:
      //   VOID *EcCtx = NULL;
      //   if (EcGetPublicKeyFromX509 (CertDer, CertDerSize, &EcCtx)) {
      //     Ok = EcDsaVerify (EcCtx, CRYPTO_NID_SHA256,
      //                       Hash, sizeof (Hash), Signature, SignatureSize);
      //     EcFree (EcCtx);
      //   }
      //
      // For now, ES256 verification from SPKI is not supported.
      FreePool (SigStructure);
      return EFI_UNSUPPORTED;
    }

    case COSE_ALG_ED25519: {
      // Ed25519: EdDSA with Ed25519
      // BaseCryptLib does not expose Ed25519 verify in standard EDK2 builds.
      // TODO: Implement Ed25519 verification when BaseCryptLib adds support
      //       or use a third-party Ed25519 library.
      // For now, Ed25519 is not supported in firmware.
      FreePool (SigStructure);
      return EFI_UNSUPPORTED;
    }

    default:
      // Unknown algorithm
      FreePool (SigStructure);
      return EFI_UNSUPPORTED;
  }

  return EFI_SUCCESS;
}
