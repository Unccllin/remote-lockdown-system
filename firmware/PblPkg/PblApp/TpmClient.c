/** @file
  TpmClient.c — TPM 2.0 client for PBL.

  Implements the C2 §5.1 boot-time read sequence and C2 §5.2 verdict cache
  write sequence using EFI_TCG2_PROTOCOL->SubmitCommand to send raw TPM2
  command buffers.

  C2 contract guarantees:
    - 3 NV indices under Platform hierarchy (0x01C00001..03)
    - HMAC sessions with AES-256-CFB parameter encryption (REQ-05)
    - PCR 12/13 only (never 0-7 or 11)
    - PolicyAuthorize-based NV access policy

  This implementation provides the boot-time read path (C2 §5.1) and the
  PCR extend path (C2 §4.1). The HMAC session setup (C2 §3) and verdict
  cache write (C2 §5.2) are stubbed with TODO markers — they require the
  full PolicyAuthorize flow which depends on C4 policy blob parsing.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"
#include <IndustryStandard/Tpm20.h>

// ============================================================================
// TPM2 command/response buffer helpers
// ============================================================================

/** TPM2 command header (10 bytes). **/
#pragma pack(1)
typedef struct {
  UINT16    Tag;          // TPM_ST_SESSIONS or TPM_ST_NO_SESSIONS
  UINT32    CommandSize;  // Total command size including header
  UINT32    CommandCode;  // TPM_CC_* value
} PBL_TPM2_COMMAND_HEADER;

/** TPM2 response header (10 bytes). **/
typedef struct {
  UINT16    Tag;          // TPM_ST_RSP_COMMAND
  UINT32    ResponseSize; // Total response size
  UINT32    ResponseCode; // TPM_RC_* value (0 = success)
} PBL_TPM2_RESPONSE_HEADER;
#pragma pack()

/** Locate the EFI_TCG2_PROTOCOL. Returns NULL if no TPM present. **/
STATIC
EFI_TCG2_PROTOCOL *
PblTcg2Locate (
  VOID
  )
{
  EFI_STATUS        Status;
  EFI_TCG2_PROTOCOL *Tcg2;

  Status = gBS->LocateProtocol (&gEfiTcg2ProtocolGuid, NULL, (VOID **)&Tcg2);
  if (EFI_ERROR (Status) || Tcg2 == NULL) {
    return NULL;
  }

  // Verify TPM is present
  EFI_TCG2_BOOT_SERVICE_CAPABILITY Cap;
  Cap.Size = sizeof (Cap);
  Status = Tcg2->GetCapability (Tcg2, &Cap);
  if (EFI_ERROR (Status) || !Cap.TPMPresentFlag) {
    return NULL;
  }

  return Tcg2;
}

/** Send a raw TPM2 command via EFI_TCG2_PROTOCOL->SubmitCommand. **/
STATIC
EFI_STATUS
PblTpmSubmitCommand (
  IN  EFI_TCG2_PROTOCOL *Tcg2,
  IN  UINT8             *Command,
  IN  UINT32            CommandSize,
  OUT UINT8             *Response,
  IN  UINT32            ResponseSize,
  OUT UINT32            *ActualResponseSize
  )
{
  EFI_STATUS Status;
  UINT32     OutSize;

  if (Tcg2 == NULL || Command == NULL || Response == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  OutSize = ResponseSize;
  Status = Tcg2->SubmitCommand (Tcg2, CommandSize, Command, OutSize, Response);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse response header to get actual size
  PBL_TPM2_RESPONSE_HEADER *Resp = (PBL_TPM2_RESPONSE_HEADER *)Response;
  if (Resp->ResponseSize > ResponseSize) {
    return EFI_BUFFER_TOO_SMALL;
  }

  *ActualResponseSize = Resp->ResponseSize;

  // Check response code (0 = TPM_RC_SUCCESS)
  if (Resp->ResponseCode != 0) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Build a TPM2 no-session command (TPM_ST_NO_SESSIONS). **/
STATIC
UINT8 *
PblTpmBeginCommand (
  OUT UINT8  *Buffer,
  IN  UINT32  BufferSize,
  IN  TPM_CC  CommandCode
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)Buffer;
  Hdr->Tag         = TPM_ST_NO_SESSIONS;
  Hdr->CommandSize = sizeof (PBL_TPM2_COMMAND_HEADER); // Updated by caller
  Hdr->CommandCode = (UINT32)CommandCode;
  return Buffer + sizeof (PBL_TPM2_COMMAND_HEADER);
}

/** Build a TPM2 command with password auth session (TPM_ST_SESSIONS).

  Uses TPM_RS_PW (password session) with an empty password. This is the
  minimum auth upgrade from TPM_ST_NO_SESSIONS — it satisfies the C2 §3.2
  rule "never use TPM_RH_NULL as auth session" while not requiring the
  full HMAC session with parameter encryption (C2 §3.1).

  The full HMAC session is tracked as remaining work in D-102.

  Authorization area format (TPMS_AUTH_COMMAND):
    sessionHandle (4 bytes): TPM_RS_PW
    nonceCaller (TPM2B): 2 bytes size=0
    sessionAttributes (1 byte): 0
    hmac/password (TPM2B): 2 bytes size=0 (empty password)

  @return Pointer past the authorization area (where command parameters go).
**/
STATIC
UINT8 *
PblTpmBeginCommandWithAuth (
  OUT UINT8  *Buffer,
  IN  UINT32  BufferSize,
  IN  TPM_CC  CommandCode
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)Buffer;
  UINT8 *Ptr;

  Hdr->Tag         = TPM_ST_SESSIONS;
  Hdr->CommandSize = sizeof (PBL_TPM2_COMMAND_HEADER); // Updated by caller
  Hdr->CommandCode = (UINT32)CommandCode;
  Ptr = Buffer + sizeof (PBL_TPM2_COMMAND_HEADER);

  // Authorization area size (4 bytes, big-endian) — 9 bytes for password auth
  *(UINT32 *)Ptr = SwapBytes32 (9);
  Ptr += 4;

  // TPMS_AUTH_COMMAND:
  // sessionHandle = TPM_RS_PW
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_RS_PW);
  Ptr += 4;

  // nonceCaller = empty TPM2B
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;

  // sessionAttributes = 0 (no flags for password session)
  *Ptr = 0;
  Ptr += 1;

  // hmac/password = empty TPM2B
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;

  return Ptr;
}

/** Finalize a TPM2 command buffer (set total size). **/
STATIC
VOID
PblTpmFinalizeCommand (
  IN OUT UINT8 *CommandBuffer,
  IN     UINT32 TotalSize
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)CommandBuffer;
  Hdr->CommandSize = TotalSize;
}

/** Skip the authorization area in a TPM_ST_SESSIONS response.

  For TPM_ST_SESSIONS responses, after the 10-byte header there is a
  4-byte parameterSize, then the response parameters, then the auth area.
  This function returns a pointer to the response parameters (past the
  parameterSize field) and sets *ParamSize to the parameter area size.

  @param RespBuf      Response buffer.
  @param RespSize     Total response size.
  @param ParamSize    Output: size of the parameter area.

  @return Pointer to the start of response parameters, or NULL on error.
**/
STATIC
UINT8 *
PblTpmParseSessionResponse (
  IN  UINT8   *RespBuf,
  IN  UINT32   RespSize,
  OUT UINT32  *ParamSize
  )
{
  if (RespSize < 14) {
    return NULL;
  }

  // Skip 10-byte header, read 4-byte parameterSize
  UINT32 Param = SwapBytes32 (*(UINT32 *)(RespBuf + 10));
  if (Param > RespSize - 14) {
    return NULL;
  }

  *ParamSize = Param;
  return RespBuf + 14;
}

// ============================================================================
// C2 §5.1 step 2: Read AK Name (device_id derivation)
// ============================================================================

EFI_STATUS
PblTpmReadAkName (
  OUT UINT8  *AkName,
  IN  UINTN   AkNameSize
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[512];
  UINT32             RespSize;

  if (AkName == NULL || AkNameSize < 34) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_ReadPublic(0x01C00003)
  // Command: tag(2) + size(4) + cc(4) + nvIndex(4) = 14 bytes
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_ReadPublic);
  *(UINT32 *)Ptr = SwapBytes32 (PBL_NV_AK_NAME);  // NV index (big-endian)
  Ptr += 4;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + nvPublic(TPM2B_NV_PUBLIC) + nvName(TPM2B_NAME)
  // TPM2B_NV_PUBLIC: 2-byte size + NV_PUBLIC structure
  // TPM2B_NAME: 2-byte size + name bytes
  // For now, extract the name from the response
  // The name is the last TPM2B in the response
  if (RespSize < 14) {
    return EFI_DEVICE_ERROR;
  }

  // Skip response header (10 bytes) + TPM2B_NV_PUBLIC (2 + N bytes)
  UINT8 *RespPtr = RespBuf + 10;
  UINT16 NvPublicSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2 + NvPublicSize;

  // Read TPM2B_NAME
  if ((RespPtr - RespBuf) + 2 > (INTN)RespSize) {
    return EFI_DEVICE_ERROR;
  }
  UINT16 NameSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;

  if (NameSize > AkNameSize || (RespPtr - RespBuf) + NameSize > (INTN)RespSize) {
    return EFI_BUFFER_TOO_SMALL;
  }

  CopyMem (AkName, RespPtr, NameSize);

  // Also compute device_id = SHA-256(AK public Area) from the NV public data
  // The name is SHA-256(alg) || SHA-256(publicArea), so the last 32 bytes
  // of the name ARE the device_id
  // TODO: Extract device_id from name — for now, caller handles this

  return EFI_SUCCESS;
}

// ============================================================================
// C2 §5.1 step 4: Read lock state from NV
// ============================================================================

EFI_STATUS
PblTpmReadLockState (
  OUT PBL_LOCK_STATE_CACHE  *Cache
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[512];
  UINT32             RespSize;

  if (Cache == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  ZeroMem (Cache, sizeof (PBL_LOCK_STATE_CACHE));

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_Read(0x01C00001, offset=0, size=64) with password auth
  // Uses TPM_ST_SESSIONS with TPM_RS_PW (empty password).
  // Full HMAC session with parameter encryption is tracked in D-102.
  UINT8 *Ptr = PblTpmBeginCommandWithAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read);
  *(UINT32 *)Ptr = SwapBytes32 (PBL_NV_LOCK_STATE);  // NV index
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);  // size
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + parameterSize(4) + TPM2B_MAX_BUFFER(2 + data) + auth
  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, &ParamSize);
  if (RespPtr == NULL || ParamSize < 4) {
    return EFI_DEVICE_ERROR;
  }

  UINT16 DataSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;

  if (DataSize < PBL_LOCK_STATE_SIZE || (RespPtr - RespBuf) + PBL_LOCK_STATE_SIZE > (INTN)RespSize) {
    return EFI_DEVICE_ERROR;
  }

  CopyMem (Cache, RespPtr, sizeof (PBL_LOCK_STATE_CACHE));

  // Validate magic
  if (Cache->Magic != PBL_LOCK_STATE_MAGIC) {
    ZeroMem (Cache, sizeof (PBL_LOCK_STATE_CACHE));
    return EFI_NOT_FOUND;
  }

  return EFI_SUCCESS;
}

// ============================================================================
// C2 §5.1 step 5: Read policy version counter
// ============================================================================

EFI_STATUS
PblTpmReadPolicyVersion (
  OUT UINT64  *Version
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[512];
  UINT32             RespSize;

  if (Version == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *Version = 0;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_Read(0x01C00002, offset=0, size=8) with password auth
  UINT8 *Ptr = PblTpmBeginCommandWithAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read);
  *(UINT32 *)Ptr = SwapBytes32 (PBL_NV_POLICY_VERSION);
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (8);   // size (uint64)
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + parameterSize(4) + TPM2B_MAX_BUFFER(2 + 8) + auth
  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, &ParamSize);
  if (RespPtr == NULL || ParamSize < 10) {
    return EFI_DEVICE_ERROR;
  }

  UINT16 DataSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;

  if (DataSize < 8) {
    return EFI_DEVICE_ERROR;
  }

  // Counter is uint64 big-endian
  UINT64 BeValue;
  CopyMem (&BeValue, RespPtr, 8);
  *Version = SwapBytes64 (BeValue);

  return EFI_SUCCESS;
}

// ============================================================================
// C2 §5.3: Increment policy version counter
// ============================================================================

EFI_STATUS
PblTpmIncrementPolicyVersion (
  VOID
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[256];
  UINT32             RespSize;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_Increment(0x01C00002) with password auth
  UINT8 *Ptr = PblTpmBeginCommandWithAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Increment);
  *(UINT32 *)Ptr = SwapBytes32 (PBL_NV_POLICY_VERSION);
  Ptr += 4;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  return Status;
}

// ============================================================================
// C2 §5.2: Write lock state cache (after verdict verification)
// ============================================================================

EFI_STATUS
PblTpmWriteLockState (
  IN CONST PBL_LOCK_STATE_CACHE  *Cache
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[256];
  UINT32             RespSize;

  if (Cache == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_Write(0x01C00001, offset=0, data=64 bytes) with password auth
  UINT8 *Ptr = PblTpmBeginCommandWithAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Write);
  *(UINT32 *)Ptr = SwapBytes32 (PBL_NV_LOCK_STATE);  // NV index
  Ptr += 4;
  // TPM2B_NV_BUFFER: 2-byte size + data
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);
  Ptr += 2;
  CopyMem (Ptr, Cache, PBL_LOCK_STATE_SIZE);
  Ptr += PBL_LOCK_STATE_SIZE;
  // offset
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  return Status;
}

// ============================================================================
// D-118: TPM2_GetRandom fallback for nonce generation
// ============================================================================

/** D-118: Get random bytes from the TPM.

  Calls TPM2_GetRandom to fetch random bytes from the TPM's RNG.
  This is a fallback for when EFI_RNG_PROTOCOL is not available or
  fails. The TPM RNG is seeded by the platform firmware and is
  resistant to OS-level attacks.

  @param[out] Buffer  Output buffer for random bytes.
  @param[in]  Size    Number of bytes to fetch (max 256).

  @retval EFI_SUCCESS       Random bytes fetched.
  @retval EFI_NOT_FOUND     No TPM present.
  @retval EFI_DEVICE_ERROR  TPM command failed.
**/
EFI_STATUS
PblTpmGetRandom (
  OUT UINT8  *Buffer,
  IN  UINTN   Size
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[64];
  UINT8              RespBuf[512];
  UINT32             RespSize;
  UINT8             *Ptr;
  UINT8             *RespPtr;
  UINT16             DataSize;

  if (Buffer == NULL || Size == 0 || Size > 256) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_GetRandom(bytesRequested)
  // No auth session needed — GetRandom is a non-auth command
  Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_GetRandom);
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)Size);
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + TPM2B_DIGEST(2 + data)
  if (RespSize < 14) {
    return EFI_DEVICE_ERROR;
  }

  RespPtr = RespBuf + 10;
  DataSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;

  if (DataSize < Size) {
    return EFI_DEVICE_ERROR;
  }

  CopyMem (Buffer, RespPtr, Size);
  return EFI_SUCCESS;
}

// ============================================================================
// C2 §4.1: PCR extend (decision + inputs)
// ============================================================================

EFI_STATUS
PblTpmExtendPcr (
  IN UINT8          PcrIndex,
  IN CONST UINT8   *Data,
  IN UINTN          DataSize
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[256];
  UINT32             RespSize;

  if (Data == NULL || DataSize != 32) {
    return EFI_INVALID_PARAMETER;
  }

  // C2 §4: PBL writes only PCR 12 and 13
  if (PcrIndex != PBL_PCR_DECISION && PcrIndex != PBL_PCR_INPUTS) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_PCR_Extend(pcrIndex, digest)
  // No-session version (scaffold)
  // Command: tag(2) + size(4) + cc(4) + pcrHandle(4) + digestCount(4) +
  //          alg(2) + digest(32) = 52 bytes
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_PCR_Extend);
  *(UINT32 *)Ptr = SwapBytes32 (PcrIndex);  // PCR handle
  Ptr += 4;
  *(UINT32 *)Ptr = SwapBytes32 (1);  // digest count
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (TPM_ALG_SHA256);  // hash algorithm
  Ptr += 2;
  CopyMem (Ptr, Data, 32);  // digest
  Ptr += 32;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  return Status;
}

// ============================================================================
// C2 §5.1 step 6: Read PCR values (4, 5, 7, 11)
// ============================================================================

EFI_STATUS
PblTpmReadPcr (
  IN  UINT8   PcrIndex,
  OUT UINT8   *PcrValue,
  IN  UINTN   PcrValueSize
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[512];
  UINT32             RespSize;

  if (PcrValue == NULL || PcrValueSize < 32) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_PCR_Read(pcrSelection)
  // Command: tag(2) + size(4) + cc(4) + pcrSelectionCount(4) +
  //          alg(2) + pcrSelectSize(3) + pcrSelect(3) = 22 bytes
  // For a single PCR: set the bit in the 3-byte bitmap
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_PCR_Read);
  *(UINT32 *)Ptr = SwapBytes32 (1);  // pcr selection count
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (TPM_ALG_SHA256);  // hash algorithm
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (3);  // sizeof(select) = 3
  Ptr += 2;
  // 3-byte PCR bitmask: set bit for the requested PCR
  ZeroMem (Ptr, 3);
  Ptr[PcrIndex / 8] |= (1 << (PcrIndex % 8));
  Ptr += 3;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // TPM2_PCR_Read response layout (TPM 2.0 Part 3 §22.4):
  //   header(10) + pcrUpdateCounter(4) + pcrSelection +
  //   pcrValues
  //
  // pcrSelection = count(4) + [ hashAlg(2) + sizeofSelect(2) +
  //   pcrSelect(sizeofSelect) ] * count
  //
  // pcrValues = [ TPM2B_DIGEST ] * (number of selected PCRs)
  //   TPM2B_DIGEST = size(2) + digest(size bytes)
  //
  // We requested 1 PCR with SHA-256, so there should be exactly
  // one 32-byte digest in the response.
  if (RespSize < 10 + 4 + 4 + 2 + 2 + 3 + 2) {
    return EFI_DEVICE_ERROR;
  }

  UINT8  *RespPtr = RespBuf + 10;  // skip response header
  // Skip pcrUpdateCounter (4 bytes)
  RespPtr += 4;

  // Parse pcrSelection: count(4) + one selection entry
  UINT32 SelectionCount = SwapBytes32 (*(UINT32 *)RespPtr);
  RespPtr += 4;
  if (SelectionCount < 1) {
    return EFI_DEVICE_ERROR;
  }

  // Skip hashAlg(2) + sizeofSelect(2)
  RespPtr += 4;
  // Skip pcrSelect (3 bytes for SHA-256 bank)
  RespPtr += 3;

  // Now at pcrValues: TPM2B_DIGEST
  UINT16 DigestSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;
  if (DigestSize != 32) {
    return EFI_DEVICE_ERROR;
  }

  // Verify we have enough bytes remaining
  if ((UINTN)(RespPtr + 32 - RespBuf) > RespSize) {
    return EFI_DEVICE_ERROR;
  }

  CopyMem (PcrValue, RespPtr, 32);

  return EFI_SUCCESS;
}

// ============================================================================
// C2 §3.3: Flush context (cleanup before chain-load)
// ============================================================================

EFI_STATUS
PblTpmFlushContext (
  IN  VOID  *SessionHandle
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[64];
  UINT8              RespBuf[64];
  UINT32             RespSize;

  if (SessionHandle == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_FlushContext(handle)
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_FlushContext);
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)(UINTN)SessionHandle);
  Ptr += 4;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  return Status;
}
