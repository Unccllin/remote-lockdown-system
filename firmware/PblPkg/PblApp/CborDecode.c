/** @file
  CborDecode.c — Minimal CBOR decoder for COSE_Sign1 and CBOR map parsing.

  Implements a minimal RFC 8949 CBOR decoder sufficient for:
  - Parsing COSE_Sign1 envelope (array of 4: protected, unprotected, payload, signature)
  - Extracting bstr payload from COSE_Sign1
  - Parsing CBOR maps with integer keys (policy blob, verdict payload)
  - Reading uint, bstr, tstr, bool, simple values

  Not a general-purpose CBOR decoder — only handles the types needed by
  PBL policy and verdict parsing. Does not handle: floating point, tags,
  indefinite-length items, or nested maps beyond one level.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// ============================================================================
// CBOR major types
// ============================================================================

#define CBOR_MAJOR_UINT    0   // 0b000 << 5
#define CBOR_MAJOR_NINT    1   // 0b001 << 5 — negative integer
#define CBOR_MAJOR_BSTR    2   // 0b010 << 5 — byte string
#define CBOR_MAJOR_TSTR    3   // 0b011 << 5 — text string
#define CBOR_MAJOR_ARRAY   4   // 0b100 << 5
#define CBOR_MAJOR_MAP     5   // 0b101 << 5
#define CBOR_MAJOR_TAG     6   // 0b110 << 5
#define CBOR_MAJOR_SIMPLE  7   // 0b111 << 5 — simple values, float

#define CBOR_TYPE_MASK     0xE0
#define CBOR_INFO_MASK     0x1F

#define CBOR_INFO_ONE_BYTE   24   // 0x18 — next 1 byte is value
#define CBOR_INFO_TWO_BYTE   25   // 0x19 — next 2 bytes are value
#define CBOR_INFO_FOUR_BYTE  26   // 0x1A — next 4 bytes are value
#define CBOR_INFO_EIGHT_BYTE 27   // 0x1B — next 8 bytes are value
#define CBOR_INFO_INDEF      31   // 0x1F — indefinite length (not supported)

// ============================================================================
// CBOR cursor — tracks position in a CBOR byte stream
// ============================================================================

typedef struct {
  CONST UINT8 *Buf;
  UINTN        Size;
  UINTN        Offset;
} CBOR_CURSOR;

/** Initialize a CBOR cursor. **/
STATIC
VOID
PblCborInit (
  IN  CONST UINT8 *Buf,
  IN  UINTN        Size,
  OUT CBOR_CURSOR *Cursor
  )
{
  Cursor->Buf = Buf;
  Cursor->Size = Size;
  Cursor->Offset = 0;
}

/** Read a CBOR "head" — major type and additional info value.

  @param  Cursor   The CBOR cursor.
  @param  MajorType Output: major type (0-7).
  @param  Value     Output: the additional info value (for short form, 0-23).

  @retval EFI_SUCCESS         Head read successfully.
  @retval EFI_BUFFER_TOO_SMALL Not enough bytes.
  @retval EFI_UNSUPPORTED     Indefinite length or unsupported format.
**/
STATIC
EFI_STATUS
PblCborReadHead (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    UINT8       *MajorType,
  OUT    UINT64      *Value
  )
{
  UINT8 First;
  UINT8 Info;

  if (Cursor->Offset >= Cursor->Size) {
    return EFI_BUFFER_TOO_SMALL;
  }

  First = Cursor->Buf[Cursor->Offset++];
  *MajorType = (First & CBOR_TYPE_MASK) >> 5;
  Info = First & CBOR_INFO_MASK;

  if (Info < 24) {
    *Value = Info;
    return EFI_SUCCESS;
  }

  if (Info == CBOR_INFO_INDEF) {
    return EFI_UNSUPPORTED;  // indefinite length not supported
  }

  UINTN LenBytes;
  switch (Info) {
    case CBOR_INFO_ONE_BYTE:   LenBytes = 1; break;
    case CBOR_INFO_TWO_BYTE:   LenBytes = 2; break;
    case CBOR_INFO_FOUR_BYTE:  LenBytes = 4; break;
    case CBOR_INFO_EIGHT_BYTE: LenBytes = 8; break;
    default:                   return EFI_UNSUPPORTED;
  }

  if (Cursor->Offset + LenBytes > Cursor->Size) {
    return EFI_BUFFER_TOO_SMALL;
  }

  *Value = 0;
  for (UINTN i = 0; i < LenBytes; i++) {
    *Value = (*Value << 8) | Cursor->Buf[Cursor->Offset++];
  }

  return EFI_SUCCESS;
}

/** Read a bstr (byte string) from the cursor.

  @param  Cursor  The CBOR cursor.
  @param  Data    Output: pointer into the original buffer (no copy).
  @param  DataLen Output: byte string length.

  @retval EFI_SUCCESS         bstr read.
  @retval EFI_BUFFER_TOO_SMALL Not enough bytes.
**/
STATIC
EFI_STATUS
PblCborReadBstr (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    CONST UINT8 **Data,
  OUT    UINTN        *DataLen
  )
{
  UINT8    MajorType;
  UINT64   Value;
  EFI_STATUS Status;

  Status = PblCborReadHead (Cursor, &MajorType, &Value);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_BSTR) {
    return EFI_PROTOCOL_ERROR;
  }

  if (Cursor->Offset + Value > Cursor->Size) {
    return EFI_BUFFER_TOO_SMALL;
  }

  *Data = Cursor->Buf + Cursor->Offset;
  *DataLen = (UINTN)Value;
  Cursor->Offset += (UINTN)Value;

  return EFI_SUCCESS;
}

/** Read a tstr (text string) from the cursor into a NUL-terminated buffer.

  @param  Cursor   The CBOR cursor.
  @param  Dest     Output: destination buffer.
  @param  DestSize Size of destination buffer.

  @retval EFI_SUCCESS         tstr read and copied.
  @retval EFI_BUFFER_TOO_SMALL String longer than DestSize-1.
**/
STATIC
EFI_STATUS
PblCborReadTstr (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    CHAR8       *Dest,
  IN     UINTN        DestSize
  )
{
  UINT8    MajorType;
  UINT64   Value;
  EFI_STATUS Status;

  if (Dest == NULL || DestSize == 0) {
    return EFI_INVALID_PARAMETER;
  }
  Dest[0] = '\0';

  Status = PblCborReadHead (Cursor, &MajorType, &Value);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_TSTR) {
    return EFI_PROTOCOL_ERROR;
  }

  if (Cursor->Offset + Value > Cursor->Size) {
    return EFI_BUFFER_TOO_SMALL;
  }

  if (Value >= DestSize) {
    // Truncate to fit
    Value = DestSize - 1;
  }

  CopyMem (Dest, Cursor->Buf + Cursor->Offset, (UINTN)Value);
  Dest[Value] = '\0';
  Cursor->Offset += (UINTN)Value;

  return EFI_SUCCESS;
}

/** Read a uint (unsigned integer) from the cursor.

  @param  Cursor  The CBOR cursor.
  @param  Value   Output: the unsigned integer value.

  @retval EFI_SUCCESS         uint read.
**/
STATIC
EFI_STATUS
PblCborReadUint (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    UINT64      *Value
  )
{
  UINT8    MajorType;
  UINT64   RawValue;
  EFI_STATUS Status;

  Status = PblCborReadHead (Cursor, &MajorType, &RawValue);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_UINT) {
    return EFI_PROTOCOL_ERROR;
  }

  *Value = RawValue;
  return EFI_SUCCESS;
}

/** Skip one CBOR item (any type) from the cursor.

  Used to skip over map values we don't need.

  @param  Cursor  The CBOR cursor.

  @retval EFI_SUCCESS         Item skipped.
**/
STATIC
EFI_STATUS
PblCborSkipItem (
  IN OUT CBOR_CURSOR *Cursor
  )
{
  UINT8    MajorType;
  UINT64   Value;
  EFI_STATUS Status;

  Status = PblCborReadHead (Cursor, &MajorType, &Value);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  switch (MajorType) {
    case CBOR_MAJOR_UINT:
    case CBOR_MAJOR_NINT:
    case CBOR_MAJOR_SIMPLE:
      // Value already read in the head
      return EFI_SUCCESS;

    case CBOR_MAJOR_BSTR:
    case CBOR_MAJOR_TSTR:
      // Skip the string content
      if (Cursor->Offset + Value > Cursor->Size) {
        return EFI_BUFFER_TOO_SMALL;
      }
      Cursor->Offset += (UINTN)Value;
      return EFI_SUCCESS;

    case CBOR_MAJOR_ARRAY:
      // Skip each element
      for (UINT64 i = 0; i < Value; i++) {
        Status = PblCborSkipItem (Cursor);
        if (EFI_ERROR (Status)) {
          return Status;
        }
      }
      return EFI_SUCCESS;

    case CBOR_MAJOR_MAP:
      // Skip each key-value pair
      for (UINT64 i = 0; i < Value; i++) {
        Status = PblCborSkipItem (Cursor);  // key
        if (EFI_ERROR (Status)) {
          return Status;
        }
        Status = PblCborSkipItem (Cursor);  // value
        if (EFI_ERROR (Status)) {
          return Status;
        }
      }
      return EFI_SUCCESS;

    case CBOR_MAJOR_TAG:
      // Skip the tag content
      return PblCborSkipItem (Cursor);

    default:
      return EFI_UNSUPPORTED;
  }
}

/** Read a map key (must be uint) from the cursor.

  @param  Cursor  The CBOR cursor.
  @param  Key     Output: the integer key.

  @retval EFI_SUCCESS         Key read.
**/
STATIC
EFI_STATUS
PblCborReadMapKey (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    UINT64      *Key
  )
{
  return PblCborReadUint (Cursor, Key);
}

/** Read a CBOR map length (major type 5).

  @param  Cursor  The CBOR cursor.
  @param  Len     Output: number of key-value pairs in the map.

  @retval EFI_SUCCESS         Map length read.
  @retval EFI_PROTOCOL_ERROR  Not a CBOR map.
**/
STATIC
EFI_STATUS
PblCborReadMapLen (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    UINTN       *Len
  )
{
  UINT8    MajorType;
  UINT64   RawValue;
  EFI_STATUS Status;

  Status = PblCborReadHead (Cursor, &MajorType, &RawValue);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_MAP) {
    return EFI_PROTOCOL_ERROR;
  }

  *Len = (UINTN)RawValue;
  return EFI_SUCCESS;
}

/** Read a CBOR boolean (simple value false=0xF4 or true=0xF5).

  @param  Cursor  The CBOR cursor.
  @param  Value   Output: TRUE or FALSE.

  @retval EFI_SUCCESS         Boolean read.
  @retval EFI_PROTOCOL_ERROR  Not a CBOR boolean.
**/
STATIC
EFI_STATUS
PblCborReadBool (
  IN OUT CBOR_CURSOR *Cursor,
  OUT    BOOLEAN     *Value
  )
{
  UINT8    MajorType;
  UINT64   RawValue;
  EFI_STATUS Status;

  Status = PblCborReadHead (Cursor, &MajorType, &RawValue);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_SIMPLE) {
    return EFI_PROTOCOL_ERROR;
  }

  if (RawValue == 20) {  // false
    *Value = FALSE;
  } else if (RawValue == 21) {  // true
    *Value = TRUE;
  } else {
    return EFI_PROTOCOL_ERROR;
  }

  return EFI_SUCCESS;
}

// ============================================================================
// COSE_Sign1 parsing
// ============================================================================

/** Parse a COSE_Sign1 envelope and extract the payload bstr.

  COSE_Sign1 = [protected: bstr, unprotected: map, payload: bstr, signature: bstr]

  @param  CoseData     The COSE_Sign1 bytes.
  @param  CoseSize     Size of CoseData.
  @param  Payload      Output: pointer to payload bytes (into CoseData).
  @param  PayloadSize  Output: payload size.

  @retval EFI_SUCCESS         Payload extracted.
  @retval EFI_PROTOCOL_ERROR  Not a valid COSE_Sign1.
**/
STATIC
EFI_STATUS
PblCoseExtractPayload (
  IN  CONST UINT8 *CoseData,
  IN  UINTN        CoseSize,
  OUT CONST UINT8 **Payload,
  OUT UINTN       *PayloadSize
  )
{
  CBOR_CURSOR  Cursor;
  UINT8        MajorType;
  UINT64       ArrayLen;
  EFI_STATUS   Status;

  PblCborInit (CoseData, CoseSize, &Cursor);

  // Expect a CBOR array of 4 elements
  Status = PblCborReadHead (&Cursor, &MajorType, &ArrayLen);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_ARRAY || ArrayLen != 4) {
    return EFI_PROTOCOL_ERROR;
  }

  // Element 0: protected header (bstr) — skip
  Status = PblCborSkipItem (&Cursor);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 1: unprotected header (map) — skip
  Status = PblCborSkipItem (&Cursor);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 2: payload (bstr) — extract
  Status = PblCborReadBstr (&Cursor, Payload, PayloadSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 3: signature (bstr) — not needed here (sig verify is separate)

  return EFI_SUCCESS;
}

// ============================================================================
// COSE_Sign1 full extraction (for signature verification)
// ============================================================================

/** Parse a COSE_Sign1 envelope and extract all 4 elements.

  COSE_Sign1 = [protected: bstr, unprotected: map, payload: bstr, signature: bstr]

  All output pointers point into the original CoseData buffer (no copies).
  The protected header bstr is the raw CBOR-encoded map bytes (as it appears
  in the wire format), which is what Sig_structure uses.

  @param  CoseData      The COSE_Sign1 bytes.
  @param  CoseSize      Size of CoseData.
  @param  ProtectedHdr  Output: pointer to protected header bstr bytes.
  @param  ProtectedSize Output: protected header bstr size.
  @param  Payload       Output: pointer to payload bstr bytes.
  @param  PayloadSize   Output: payload bstr size.
  @param  Signature     Output: pointer to signature bstr bytes.
  @param  SignatureSize Output: signature bstr size.

  @retval EFI_SUCCESS         All elements extracted.
  @retval EFI_PROTOCOL_ERROR  Not a valid COSE_Sign1.
**/
EFI_STATUS
PblCoseExtractAll (
  IN  CONST UINT8 *CoseData,
  IN  UINTN        CoseSize,
  OUT CONST UINT8 **ProtectedHdr,
  OUT UINTN       *ProtectedSize,
  OUT CONST UINT8 **Payload,
  OUT UINTN       *PayloadSize,
  OUT CONST UINT8 **Signature,
  OUT UINTN       *SignatureSize
  )
{
  CBOR_CURSOR  Cursor;
  UINT8        MajorType;
  UINT64       ArrayLen;
  EFI_STATUS   Status;

  if (CoseData == NULL || CoseSize == 0 ||
      ProtectedHdr == NULL || ProtectedSize == NULL ||
      Payload == NULL || PayloadSize == NULL ||
      Signature == NULL || SignatureSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  PblCborInit (CoseData, CoseSize, &Cursor);

  // Expect a CBOR array of 4 elements
  Status = PblCborReadHead (&Cursor, &MajorType, &ArrayLen);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_ARRAY || ArrayLen != 4) {
    return EFI_PROTOCOL_ERROR;
  }

  // Element 0: protected header (bstr) — extract
  Status = PblCborReadBstr (&Cursor, ProtectedHdr, ProtectedSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 1: unprotected header (map) — skip
  Status = PblCborSkipItem (&Cursor);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 2: payload (bstr) — extract
  Status = PblCborReadBstr (&Cursor, Payload, PayloadSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Element 3: signature (bstr) — extract
  Status = PblCborReadBstr (&Cursor, Signature, SignatureSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  return EFI_SUCCESS;
}

/** Parse the COSE protected header map to extract alg and kid.

  The protected header is a CBOR map: {1: alg_id (int), 4: kid (bstr)}.
  This function parses it and returns the algorithm ID and kid.

  @param  ProtectedHdr  The protected header bstr bytes (CBOR map).
  @param  ProtectedSize Size of the protected header.
  @param  AlgId         Output: COSE algorithm ID (e.g., -7 for ES256, -8 for Ed25519).
  @param  Kid           Output: pointer to kid bstr bytes (into ProtectedHdr).
  @param  KidSize       Output: kid bstr size.

  @retval EFI_SUCCESS         alg and kid extracted.
  @retval EFI_PROTOCOL_ERROR  Malformed protected header.
**/
EFI_STATUS
PblCoseParseProtectedHeader (
  IN  CONST UINT8 *ProtectedHdr,
  IN  UINTN        ProtectedSize,
  OUT INT64       *AlgId,
  OUT CONST UINT8 **Kid,
  OUT UINTN       *KidSize
  )
{
  CBOR_CURSOR  Cursor;
  UINT8        MajorType;
  UINT64       MapLen;
  EFI_STATUS   Status;

  if (ProtectedHdr == NULL || ProtectedSize == 0 ||
      AlgId == NULL || Kid == NULL || KidSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *AlgId = 0;
  *Kid = NULL;
  *KidSize = 0;

  PblCborInit (ProtectedHdr, ProtectedSize, &Cursor);

  Status = PblCborReadHead (&Cursor, &MajorType, &MapLen);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_MAP) {
    return EFI_PROTOCOL_ERROR;
  }

  for (UINT64 i = 0; i < MapLen; i++) {
    UINT64 Key;
    Status = PblCborReadMapKey (&Cursor, &Key);
    if (EFI_ERROR (Status)) {
      return Status;
    }

    switch (Key) {
      case 1: {  // alg (int — may be negative)
        UINT8  Mt;
        UINT64 Val;
        Status = PblCborReadHead (&Cursor, &Mt, &Val);
        if (EFI_ERROR (Status)) {
          return Status;
        }
        if (Mt == CBOR_MAJOR_UINT) {
          *AlgId = (INT64)Val;
        } else if (Mt == CBOR_MAJOR_NINT) {
          *AlgId = -(INT64)Val - 1;
        } else {
          return EFI_PROTOCOL_ERROR;
        }
        break;
      }

      case 4: {  // kid (bstr)
        Status = PblCborReadBstr (&Cursor, Kid, KidSize);
        if (EFI_ERROR (Status)) {
          return Status;
        }
        break;
      }

      default:
        Status = PblCborSkipItem (&Cursor);
        if (EFI_ERROR (Status)) {
          return Status;
        }
        break;
    }
  }

  return EFI_SUCCESS;
}

// ============================================================================
// C4: Policy blob parsing
// ============================================================================

/** C4: Parse a COSE_Sign1 policy blob into PBL_POLICY.

  This function extracts the CBOR map payload from the COSE_Sign1 envelope
  and parses the fields that PBL_POLICY has dedicated members for. Fields
  without dedicated members (arrays of OEM-specific data, etc.) are skipped
  but the raw CBOR pointer is retained for on-demand access.

  @param  CoseData  The COSE_Sign1 policy blob bytes.
  @param  CoseSize  Size of CoseData.
  @param  Policy    Output: parsed policy struct.

  @retval EFI_SUCCESS         Policy parsed.
  @retval EFI_INVALID_PARAMETER NULL parameter.
  @retval EFI_PROTOCOL_ERROR  Malformed CBOR/COSE.
**/
EFI_STATUS
PblCborDecodePolicy (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_POLICY    *Policy
  )
{
  CONST UINT8  *Payload;
  UINTN         PayloadSize;
  CBOR_CURSOR   Cursor;
  UINT8         MajorType;
  UINT64        MapLen;
  EFI_STATUS    Status;

  if (CoseData == NULL || CoseSize == 0 || Policy == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  ZeroMem (Policy, sizeof (PBL_POLICY));

  // Extract payload from COSE_Sign1
  Status = PblCoseExtractPayload (CoseData, CoseSize, &Payload, &PayloadSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Retain raw CBOR pointer for on-demand field access
  Policy->RawCbor = (UINT8 *)Payload;
  Policy->RawCborSize = PayloadSize;

  // Parse the CBOR map
  PblCborInit (Payload, PayloadSize, &Cursor);

  Status = PblCborReadHead (&Cursor, &MajorType, &MapLen);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_MAP) {
    return EFI_PROTOCOL_ERROR;
  }

  // Walk the map entries
  for (UINT64 i = 0; i < MapLen; i++) {
    UINT64 Key;
    Status = PblCborReadMapKey (&Cursor, &Key);
    if (EFI_ERROR (Status)) {
      return Status;
    }

    switch (Key) {
      case 1:  // version (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->Meta.Version = (UINT32)Key;
        break;

      case 2:  // issued_at (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->Meta.IssuedAt = (UINT32)Key;
        break;

      case 3:  // expires_at (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->Meta.ExpiresAt = (UINT32)Key;
        break;

      case 4:  // min_pbl_version (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->Meta.MinPblVersion = (UINT32)Key;
        break;

      case 40: {  // tpm_session_requirements (map)
        // C4 §2.5: {hmac: bool, param_encrypt: bool, salted: bool, bound: bool}
        // Parse the sub-map with string keys.
        UINTN MapLen40;
        Status = PblCborReadMapLen (&Cursor, &MapLen40);
        if (EFI_ERROR (Status)) return Status;
        for (UINTN I40 = 0; I40 < MapLen40; I40++) {
          CHAR8 Key40[24];
          Status = PblCborReadTstr (&Cursor, Key40, sizeof (Key40));
          if (EFI_ERROR (Status)) return Status;
          BOOLEAN Val40;
          Status = PblCborReadBool (&Cursor, &Val40);
          if (EFI_ERROR (Status)) {
            // Not a bool — skip the value
            PblCborSkipItem (&Cursor);
            continue;
          }
          if (AsciiStrCmp (Key40, "hmac") == 0) {
            Policy->TpmSessionReq.HmacRequired = Val40;
          } else if (AsciiStrCmp (Key40, "param_encrypt") == 0) {
            Policy->TpmSessionReq.ParamEncryptRequired = Val40;
          } else if (AsciiStrCmp (Key40, "salted") == 0) {
            Policy->TpmSessionReq.SaltedRequired = Val40;
          } else if (AsciiStrCmp (Key40, "bound") == 0) {
            Policy->TpmSessionReq.BoundRequired = Val40;
          }
        }
        break;
      }

      case 41:  // tpm_firmware_floors (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->TpmFirmwareFloor = (UINT32)Key;
        break;

      case 42: {  // tpm_pin_policy (tstr)
        CHAR8 PinPolicy[16];
        Status = PblCborReadTstr (&Cursor, PinPolicy, sizeof (PinPolicy));
        if (EFI_ERROR (Status)) return Status;
        if (AsciiStrCmp (PinPolicy, "required") == 0) {
          Policy->TpmPinPolicy = 1;
        } else if (AsciiStrCmp (PinPolicy, "preferred") == 0) {
          Policy->TpmPinPolicy = 2;
        } else {
          Policy->TpmPinPolicy = 0;  // "none" or unknown
        }
        break;
      }

      case 43:  // nv_index_base (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->NvIndexBase = (UINT32)Key;
        break;

      case 44: {  // bitlocker_sealing_tier (tstr)
        CHAR8 Tier[32];
        Status = PblCborReadTstr (&Cursor, Tier, sizeof (Tier));
        if (EFI_ERROR (Status)) return Status;
        if (AsciiStrCmp (Tier, "high_assurance") == 0) {
          Policy->BitLockerTier = 1;
        } else {
          Policy->BitLockerTier = 0;  // "standard" or unknown
        }
        break;
      }

      case 70:  // lock_service_uri (tstr)
        Status = PblCborReadTstr (&Cursor, Policy->LockServiceUri,
                                  sizeof (Policy->LockServiceUri));
        if (EFI_ERROR (Status)) return Status;
        break;

      case 71: {  // lock_service_cert_pin (bstr 32)
        CONST UINT8 *Pin;
        UINTN        PinLen;
        Status = PblCborReadBstr (&Cursor, &Pin, &PinLen);
        if (EFI_ERROR (Status)) return Status;
        if (PinLen == 32) {
          CopyMem (Policy->LockServiceCertPin, Pin, 32);
        }
        break;
      }

      case 73: {  // tls_ca_pin (bstr 32)
        CONST UINT8 *Pin;
        UINTN        PinLen;
        Status = PblCborReadBstr (&Cursor, &Pin, &PinLen);
        if (EFI_ERROR (Status)) return Status;
        if (PinLen == 32) {
          CopyMem (Policy->TlsCaPin, Pin, 32);
        }
        break;
      }

      case 76: {  // verdict_signing_key_spki (bstr, variable length)
        // D-205: Full SPKI DER of the verdict signing key.
        // Pointer into RawCbor — valid as long as the policy buffer is alive.
        CONST UINT8 *Spki;
        UINTN        SpkiLen;
        Status = PblCborReadBstr (&Cursor, &Spki, &SpkiLen);
        if (EFI_ERROR (Status)) return Status;
        Policy->VerdictSigningKeySpki = Spki;
        Policy->VerdictSigningKeySpkiSize = SpkiLen;
        break;
      }

      case 77: {  // signing_cert_chain (array of bstr, D-205)
        // D-205: X.509 cert chain [leaf, intermediate, root] as DER bytes.
        // Extract the first cert (leaf) for EcGetPublicKeyFromX509().
        // Store all certs as concatenated DER for X509VerifyCertChain.
        // The last cert is the root CA (self-signed in test, or pinned root).
        UINT8        Mt77;
        UINT64       ArrLen;
        Status = PblCborReadHead (&Cursor, &Mt77, &ArrLen);
        if (EFI_ERROR (Status)) return Status;
        if (Mt77 != CBOR_MAJOR_ARRAY) return EFI_PROTOCOL_ERROR;
        if (ArrLen > 0) {
          // Read all certs into a concatenated DER buffer
          UINTN TotalChainSize = 0;
          CONST UINT8 *CertPtrs[8];
          UINTN        CertSizes[8];
          UINT64       NumCerts = ArrLen < 8 ? ArrLen : 8;

          for (UINT64 Ci = 0; Ci < NumCerts; Ci++) {
            CONST UINT8 *CertDer;
            UINTN        CertDerLen;
            Status = PblCborReadBstr (&Cursor, &CertDer, &CertDerLen);
            if (EFI_ERROR (Status)) return Status;
            CertPtrs[Ci] = CertDer;
            CertSizes[Ci] = CertDerLen;
            TotalChainSize += CertDerLen;
          }
          // Skip any remaining certs beyond 8
          for (UINT64 Ci = NumCerts; Ci < ArrLen; Ci++) {
            CONST UINT8 *Skip;
            UINTN        SkipLen;
            Status = PblCborReadBstr (&Cursor, &Skip, &SkipLen);
            if (EFI_ERROR (Status)) return Status;
          }

          // First cert = leaf
          Policy->VerdictSigningCert = CertPtrs[0];
          Policy->VerdictSigningCertSize = CertSizes[0];

          // Last cert = root
          Policy->VerdictSigningRootCert = CertPtrs[NumCerts - 1];
          Policy->VerdictSigningRootCertSize = CertSizes[NumCerts - 1];

          // Concatenate all certs EXCEPT the root for X509VerifyCertChain,
          // in REVERSED order (intermediate first, leaf last).
          // X509VerifyCertChain(RootCert, CertChain) verifies each cert in
          // CertChain against the preceding cert, starting with RootCert.
          // So the chain must be ordered: [intermediate, ..., leaf] so that
          // root verifies intermediate, intermediate verifies leaf, etc.
          // C4 key 77 is [leaf, intermediate, root] — we reverse excluding root.
          UINTN ChainSize = TotalChainSize - CertSizes[NumCerts - 1];
          Policy->VerdictSigningCertChain = AllocatePool (ChainSize);
          if (Policy->VerdictSigningCertChain != NULL) {
            UINT8 *P = Policy->VerdictSigningCertChain;
            // Write certs in reverse order (excluding root at index NumCerts-1)
            for (INT64 Ci = (INT64)NumCerts - 2; Ci >= 0; Ci--) {
              CopyMem (P, CertPtrs[Ci], CertSizes[Ci]);
              P += CertSizes[Ci];
            }
            Policy->VerdictSigningCertChainSize = ChainSize;
          }
        }
        break;
      }

      case 80:  // verdict_freshness_seconds (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->VerdictFreshnessSec = (UINT32)Key;
        break;

      case 81:  // grace_period_seconds (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->GracePeriodSec = (UINT32)Key;
        break;

      case 82:  // wipe_deadline_seconds (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Policy->WipeDeadlineSec = (UINT32)Key;
        break;

      case 83:  // override_rate_limit (map)
        // C4 §2.9: {max_attempts: uint, window_seconds: uint}
        // Keys are text strings. Skip — parsed on demand from RawCbor.
        Status = PblCborSkipItem (&Cursor);
        if (EFI_ERROR (Status)) return Status;
        break;

      default:
        // Skip unknown keys
        Status = PblCborSkipItem (&Cursor);
        if (EFI_ERROR (Status)) return Status;
        break;
    }
  }

  return EFI_SUCCESS;
}

// ============================================================================
// C1: Verdict payload parsing
// ============================================================================

/** C1 §2: Parse a COSE_Sign1 verdict into PBL_VERDICT.

  Extracts the CBOR map payload from the COSE_Sign1 envelope and parses
  the verdict fields (version, device_id, nonce, verdict, policy_version,
  issued_at, grace_until, reason, challenge_seed).

  @param  CoseData  The COSE_Sign1 verdict bytes.
  @param  CoseSize  Size of CoseData.
  @param  Verdict   Output: parsed verdict struct.

  @retval EFI_SUCCESS         Verdict parsed.
  @retval EFI_INVALID_PARAMETER NULL parameter.
  @retval EFI_PROTOCOL_ERROR  Malformed CBOR/COSE.
**/
EFI_STATUS
PblCborDecodeVerdict (
  IN  CONST UINT8   *CoseData,
  IN  UINTN          CoseSize,
  OUT PBL_VERDICT   *Verdict
  )
{
  CONST UINT8  *Payload;
  UINTN         PayloadSize;
  CBOR_CURSOR   Cursor;
  UINT8         MajorType;
  UINT64        MapLen;
  EFI_STATUS    Status;

  if (CoseData == NULL || CoseSize == 0 || Verdict == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  ZeroMem (Verdict, sizeof (PBL_VERDICT));

  // Extract payload from COSE_Sign1
  Status = PblCoseExtractPayload (CoseData, CoseSize, &Payload, &PayloadSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse the CBOR map
  PblCborInit (Payload, PayloadSize, &Cursor);

  Status = PblCborReadHead (&Cursor, &MajorType, &MapLen);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  if (MajorType != CBOR_MAJOR_MAP) {
    return EFI_PROTOCOL_ERROR;
  }

  for (UINT64 i = 0; i < MapLen; i++) {
    UINT64 Key;
    Status = PblCborReadMapKey (&Cursor, &Key);
    if (EFI_ERROR (Status)) {
      return Status;
    }

    switch (Key) {
      case 1:  // version (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Verdict->Version = (UINT32)Key;
        break;

      case 2: {  // device_id (bstr 32)
        CONST UINT8 *Data;
        UINTN        DataLen;
        Status = PblCborReadBstr (&Cursor, &Data, &DataLen);
        if (EFI_ERROR (Status)) return Status;
        if (DataLen == 32) {
          CopyMem (Verdict->DeviceId, Data, 32);
        }
        break;
      }

      case 3: {  // nonce (bstr 32)
        CONST UINT8 *Data;
        UINTN        DataLen;
        Status = PblCborReadBstr (&Cursor, &Data, &DataLen);
        if (EFI_ERROR (Status)) return Status;
        if (DataLen == 32) {
          CopyMem (Verdict->Nonce, Data, 32);
        }
        break;
      }

      case 4:  // verdict (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Verdict->Verdict = (UINT8)Key;
        break;

      case 5:  // policy_version (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Verdict->PolicyVersion = Key;
        break;

      case 6:  // issued_at (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Verdict->IssuedAt = (UINT32)Key;
        break;

      case 7:  // grace_until (uint)
        Status = PblCborReadUint (&Cursor, &Key);
        if (EFI_ERROR (Status)) return Status;
        Verdict->GraceUntil = (UINT32)Key;
        break;

      case 8:  // reason (tstr)
        Status = PblCborReadTstr (&Cursor, Verdict->Reason,
                                  sizeof (Verdict->Reason));
        if (EFI_ERROR (Status)) return Status;
        break;

      case 9: {  // challenge_seed (bstr 16, optional)
        CONST UINT8 *Data;
        UINTN        DataLen;
        Status = PblCborReadBstr (&Cursor, &Data, &DataLen);
        if (EFI_ERROR (Status)) return Status;
        if (DataLen == 16) {
          CopyMem (Verdict->ChallengeSeed, Data, 16);
          Verdict->HasChallengeSeed = TRUE;
        }
        break;
      }

      default:
        Status = PblCborSkipItem (&Cursor);
        if (EFI_ERROR (Status)) return Status;
        break;
    }
  }

  return EFI_SUCCESS;
}
