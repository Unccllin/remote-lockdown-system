/** @file
  CborEncode.c — CBOR encoder for the PBL verdict request body.

  Implements PblCborEncodeVerdictRequest() per C3 §3.2. The request body
  is a CBOR map with 4 entries:

    { 1: device_id (bstr 32),
      2: nonce (bstr 32),
      3: platform_state_digest (bstr 32),
      4: policy_version (uint) }

  The encoded output is allocated via AllocatePool and must be freed by
  the caller via FreePool.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// CBOR major types (match CborDecode.c)
// ============================================================================

#define CBOR_MAJOR_UINT    0   // 0b000 << 5
#define CBOR_MAJOR_BSTR    2   // 0b010 << 5
#define CBOR_MAJOR_MAP     5   // 0b101 << 5

#define CBOR_INFO_ONE_BYTE   24   // 0x18 — next 1 byte is value
#define CBOR_INFO_TWO_BYTE   25   // 0x19 — next 2 bytes are value
#define CBOR_INFO_FOUR_BYTE  26   // 0x1A — next 4 bytes are value
#define CBOR_INFO_EIGHT_BYTE 27   // 0x1B — next 8 bytes are value

// ============================================================================
// Internal helpers
// ============================================================================

/** Append a single byte to the output buffer.

  The output buffer is pre-allocated to the exact size needed, so no
  bounds checking is required — the caller computed the size correctly.

  @param Out    Output buffer pointer (advanced by 1).
  @param Value  Byte to append.
**/
STATIC
VOID
PblCborPutByte (
  IN OUT UINT8 **Out,
  IN     UINT8   Value
  )
{
  **Out = Value;
  (*Out)++;
}

/** Append N bytes to the output buffer.

  @param Out   Output buffer pointer (advanced by N).
  @param Src   Source bytes.
  @param N     Number of bytes to copy.
**/
STATIC
VOID
PblCborPutBytes (
  IN OUT UINT8       **Out,
  IN     CONST UINT8  *Src,
  IN     UINTN         N
  )
{
  CopyMem (*Out, Src, N);
  *Out += N;
}

/** Encode a CBOR "head" — major type + additional info.

  For the verdict request, all values fit in:
  - Short form (0-23): 1 byte
  - One-byte info (24-255): 2 bytes
  - Two-byte info (256-65535): 3 bytes
  - Four-byte info (up to 4 GB): 5 bytes

  @param Out        Output buffer pointer (advanced).
  @param MajorType  CBOR major type (0-7).
  @param Value      The value to encode.
**/
STATIC
VOID
PblCborPutHead (
  IN OUT UINT8  **Out,
  IN     UINT8   MajorType,
  IN     UINT64  Value
  )
{
  UINT8 TypeByte = (UINT8)(MajorType << 5);

  if (Value < 24) {
    PblCborPutByte (Out, (UINT8)(TypeByte | (UINT8)Value));
  } else if (Value <= 0xFF) {
    PblCborPutByte (Out, (UINT8)(TypeByte | CBOR_INFO_ONE_BYTE));
    PblCborPutByte (Out, (UINT8)Value);
  } else if (Value <= 0xFFFF) {
    PblCborPutByte (Out, (UINT8)(TypeByte | CBOR_INFO_TWO_BYTE));
    PblCborPutByte (Out, (UINT8)(Value >> 8));
    PblCborPutByte (Out, (UINT8)(Value & 0xFF));
  } else if (Value <= 0xFFFFFFFF) {
    PblCborPutByte (Out, (UINT8)(TypeByte | CBOR_INFO_FOUR_BYTE));
    PblCborPutByte (Out, (UINT8)(Value >> 24));
    PblCborPutByte (Out, (UINT8)((Value >> 16) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 8) & 0xFF));
    PblCborPutByte (Out, (UINT8)(Value & 0xFF));
  } else {
    PblCborPutByte (Out, (UINT8)(TypeByte | CBOR_INFO_EIGHT_BYTE));
    PblCborPutByte (Out, (UINT8)(Value >> 56));
    PblCborPutByte (Out, (UINT8)((Value >> 48) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 40) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 32) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 24) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 16) & 0xFF));
    PblCborPutByte (Out, (UINT8)((Value >> 8) & 0xFF));
    PblCborPutByte (Out, (UINT8)(Value & 0xFF));
  }
}

/** Encode a CBOR bstr (byte string) head + data.

  @param Out   Output buffer pointer (advanced).
  @param Data  Pointer to the byte string data.
  @param Len   Length of the byte string.
**/
STATIC
VOID
PblCborPutBstr (
  IN OUT UINT8       **Out,
  IN     CONST UINT8  *Data,
  IN     UINTN         Len
  )
{
  PblCborPutHead (Out, CBOR_MAJOR_BSTR, Len);
  PblCborPutBytes (Out, Data, Len);
}

/** Encode a CBOR uint (unsigned integer).

  @param Out    Output buffer pointer (advanced).
  @param Value  The unsigned integer value.
**/
STATIC
VOID
PblCborPutUint (
  IN OUT UINT8  **Out,
  IN     UINT64  Value
  )
{
  PblCborPutHead (Out, CBOR_MAJOR_UINT, Value);
}

// ============================================================================
// Public API — C3 §3.2 verdict request body
// ============================================================================

/** Encode the verdict request body as a CBOR map.

  The map has 4 entries per C3 §3.2:
    1: device_id             — bstr(32)
    2: nonce                 — bstr(32)
    3: platform_state_digest — bstr(32)
    4: policy_version        — uint

  The output buffer is allocated with AllocatePool and must be freed
  by the caller with FreePool.

  @param[in]  DeviceId             32-byte device identity (C2 §1.3).
  @param[in]  Nonce                32-byte nonce from EFI_RNG_PROTOCOL.
  @param[in]  PlatformStateDigest  32-byte SHA-256 of platform state.
  @param[in]  PolicyVersion        Current policy version from C4.
  @param[out] Output               Pointer to allocated output buffer.
  @param[out] OutputSize           Size of the output buffer in bytes.

  @retval EFI_SUCCESS            Encoding complete.
  @retval EFI_INVALID_PARAMETER  Null pointer.
  @retval EFI_OUT_OF_RESOURCES   Allocation failed.
**/
EFI_STATUS
PblCborEncodeVerdictRequest (
  IN CONST UINT8  *DeviceId,
  IN CONST UINT8  *Nonce,
  IN CONST UINT8  *PlatformStateDigest,
  IN UINT64        PolicyVersion,
  OUT UINT8       **Output,
  OUT UINTN        *OutputSize
  )
{
  // Compute the encoded size:
  //   Map header: 1 byte (map(4) = 0xA4)
  //   Key 1 (uint 1): 1 byte
  //   device_id bstr(32): 1 head byte + 32 data bytes = 33 bytes
  //   Key 2 (uint 2): 1 byte
  //   nonce bstr(32): 33 bytes
  //   Key 3 (uint 3): 1 byte
  //   platform_state_digest bstr(32): 33 bytes
  //   Key 4 (uint 4): 1 byte
  //   policy_version uint: 1-9 bytes (depends on value)
  //
  // Total fixed: 1 + 1 + 33 + 1 + 33 + 1 + 33 + 1 = 104 bytes
  // Plus policy_version encoding size (1-9 bytes).
  // Worst case: 104 + 9 = 113 bytes. Allocate 128 for safety.

  if (DeviceId == NULL || Nonce == NULL || PlatformStateDigest == NULL ||
      Output == NULL || OutputSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Determine policy_version encoding size
  UINTN VersionSize;
  if (PolicyVersion < 24) {
    VersionSize = 1;
  } else if (PolicyVersion <= 0xFF) {
    VersionSize = 2;
  } else if (PolicyVersion <= 0xFFFF) {
    VersionSize = 3;
  } else if (PolicyVersion <= 0xFFFFFFFF) {
    VersionSize = 5;
  } else {
    VersionSize = 9;
  }

  UINTN TotalSize = 1 +    // map(4)
                    1 + 33 +  // key 1 + bstr(32)
                    1 + 33 +  // key 2 + bstr(32)
                    1 + 33 +  // key 3 + bstr(32)
                    1 +       // key 4
                    VersionSize;

  UINT8 *Buf = AllocatePool (TotalSize);
  if (Buf == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  UINT8 *Cursor = Buf;

  // Map header: map(4) = 0xA4
  PblCborPutByte (&Cursor, (UINT8)(CBOR_MAJOR_MAP << 5 | 4));

  // Key 1: device_id
  PblCborPutUint (&Cursor, 1);
  PblCborPutBstr (&Cursor, DeviceId, 32);

  // Key 2: nonce
  PblCborPutUint (&Cursor, 2);
  PblCborPutBstr (&Cursor, Nonce, 32);

  // Key 3: platform_state_digest
  PblCborPutUint (&Cursor, 3);
  PblCborPutBstr (&Cursor, PlatformStateDigest, 32);

  // Key 4: policy_version
  PblCborPutUint (&Cursor, 4);
  PblCborPutUint (&Cursor, PolicyVersion);

  *Output = Buf;
  *OutputSize = (UINTN)(Cursor - Buf);

  return EFI_SUCCESS;
}
