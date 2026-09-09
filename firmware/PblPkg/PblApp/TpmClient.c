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

// D-102: Track handle count for the current TPM_ST_SESSIONS command being built.
// Handles go between the header and the auth area per TPM 2.0 wire format.
// PblTpmFillCommandHmac and PblTpmFillPcrCommandHmac use this to compute
// correct offsets for nonceCaller, HMAC, and pHash (which includes handles).
STATIC UINT32 mCurrentCmdHandleCount = 0;

/** Locate the EFI_TCG2_PROTOCOL. Returns NULL if no TPM present. **/
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
  UINT32 RespSz = SwapBytes32 (Resp->ResponseSize);
  UINT32 RespRc = SwapBytes32 (Resp->ResponseCode);
  if (RespSz > ResponseSize) {
    return EFI_BUFFER_TOO_SMALL;
  }

  *ActualResponseSize = RespSz;

  // Check response code (0 = TPM_RC_SUCCESS)
  if (RespRc != 0) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Build a TPM2 no-session command (TPM_ST_NO_SESSIONS). **/
UINT8 *
PblTpmBeginCommand (
  OUT UINT8  *Buffer,
  IN  UINT32  BufferSize,
  IN  TPM_CC  CommandCode
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)Buffer;
  Hdr->Tag         = SwapBytes16 (TPM_ST_NO_SESSIONS);
  Hdr->CommandSize = SwapBytes32 (sizeof (PBL_TPM2_COMMAND_HEADER)); // Updated by caller
  Hdr->CommandCode = SwapBytes32 ((UINT32)CommandCode);
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

// Session attributes for HMAC session: continueSession | decrypt | encrypt
#define PBL_SESSION_ATTRS  (BIT0 | BIT5 | BIT6)

/** Build a TPM2 command with HMAC session auth (D-102).

  If an HMAC session is active (PblTpmIsSessionActive), uses the session
  handle with continueSession + decrypt + encrypt attributes. Otherwise,
  falls back to TPM_RS_PW password auth (C2 §3.2 minimum).

  TPM 2.0 wire format for TPM_ST_SESSIONS commands:
    header(10) + handles(4*HandleCount) + authAreaSize(4) + authArea + params

  Handles go BEFORE the auth area per TPM 2.0 Part 2 §17.5.

  Authorization area format (TPMS_AUTH_COMMAND) with HMAC session:
    sessionHandle (4 bytes): session handle from StartAuthSession
    nonceCaller (TPM2B): 2 bytes size=0 (refreshed per command in full impl)
    sessionAttributes (1 byte): continueSession | decrypt | encrypt
    hmac (TPM2B): 2 bytes size=0 (computed in full impl)

  @param  Buffer        Output command buffer.
  @param  BufferSize    Size of Buffer.
  @param  CommandCode   TPM command code.
  @param  HandleCount   Number of handles to write before the auth area.
  @param  Handles       Array of handle values (HandleCount entries).

  @return Pointer past the authorization area (where command parameters go).
**/
STATIC
UINT8 *
PblTpmBeginCommandWithSessionAuth (
  OUT UINT8        *Buffer,
  IN  UINT32       BufferSize,
  IN  TPM_CC       CommandCode,
  IN  UINT32       HandleCount,
  IN  CONST UINT32 *Handles
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)Buffer;
  UINT8 *Ptr;
  UINT32 i;

  mCurrentCmdHandleCount = HandleCount;

  Hdr->Tag         = SwapBytes16 (TPM_ST_SESSIONS);
  Hdr->CommandSize = SwapBytes32 (sizeof (PBL_TPM2_COMMAND_HEADER));
  Hdr->CommandCode = SwapBytes32 ((UINT32)CommandCode);
  Ptr = Buffer + sizeof (PBL_TPM2_COMMAND_HEADER);

  // Write handles before the auth area (TPM 2.0 Part 2 §17.5)
  for (i = 0; i < HandleCount; i++) {
    *(UINT32 *)Ptr = SwapBytes32 (Handles[i]);
    Ptr += 4;
  }

  if (PblTpmIsSessionActive ()) {
    // HMAC session auth — 73 bytes:
    //   handle(4) + nonceCaller(2+32) + attrs(1) + hmac(2+32)
    // Reserve full space upfront so PblTpmFillCommandHmac can fill in
    // the nonce and HMAC after parameters are written.
    *(UINT32 *)Ptr = SwapBytes32 (73);
    Ptr += 4;

    // sessionHandle = active session handle
    *(UINT32 *)Ptr = SwapBytes32 (PblTpmGetSessionHandle ());
    Ptr += 4;

    // nonceCaller = placeholder TPM2B(32 bytes), filled by PblTpmFillCommandHmac
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;

    // sessionAttributes = continueSession | decrypt | encrypt
    *Ptr = PBL_SESSION_ATTRS;
    Ptr += 1;

    // hmac = placeholder TPM2B(32 bytes), filled by PblTpmFillCommandHmac
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;
  } else {
    // Fallback: TPM_RS_PW password auth (empty password)
    *(UINT32 *)Ptr = SwapBytes32 (9);
    Ptr += 4;

    *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_RS_PW);
    Ptr += 4;

    *(UINT16 *)Ptr = SwapBytes16 (0);
    Ptr += 2;

    *Ptr = 0;
    Ptr += 1;

    *(UINT16 *)Ptr = SwapBytes16 (0);
    Ptr += 2;
  }

  return Ptr;
}

/** Finalize a TPM2 command buffer (set total size). **/
VOID
PblTpmFinalizeCommand (
  IN OUT UINT8 *CommandBuffer,
  IN     UINT32 TotalSize
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)CommandBuffer;
  Hdr->CommandSize = SwapBytes32 (TotalSize);
}

/** D-102: Fill the HMAC into the auth area of a TPM2 command.

  After PblTpmBeginCommandWithSessionAuth builds the command with a placeholder
  HMAC (32 zero bytes), and the caller fills in the command parameters, this
  function computes the proper pHash-based HMAC and writes it into the auth area.

  Command buffer layout (TPM_ST_SESSIONS with HMAC session):
    offset 0:  header (10 bytes: tag(2) + size(4) + commandCode(4))
    offset 10: authAreaSize (4 bytes) = 73
    offset 14: sessionHandle (4 bytes)
    offset 18: nonceCaller (2 bytes size + 32 bytes)
    offset 52: sessionAttributes (1 byte)
    offset 53: hmac (2 bytes size + 32 bytes)
    offset 87: parameters start

  @param  CommandBuffer  The TPM2 command buffer.
  @param  TotalSize      Total command size (as set by PblTpmFinalizeCommand).

  @retval EFI_SUCCESS       HMAC filled.
  @retval EFI_NOT_STARTED   No active session (no-op, password auth).
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
STATIC
EFI_STATUS
PblTpmFillCommandHmac (
  IN OUT UINT8  *CommandBuffer,
  IN     UINT32  TotalSize
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr;
  UINT32  CommandCode;
  UINT8  *ParamsStart;
  UINTN  ParamsSize;
  UINT8   Hmac[32];
  CONST UINT8 *Nonce;
  EFI_STATUS Status;

  if (!PblTpmIsSessionActive ()) {
    return EFI_NOT_STARTED;
  }

  // D-102: Refresh nonceCaller for replay protection (TPM 2.0 Part 1 §18.1)
  Status = PblTpmRefreshNonce ();
  if (EFI_ERROR (Status)) {
    return Status;
  }

  Hdr = (PBL_TPM2_COMMAND_HEADER *)CommandBuffer;
  CommandCode = SwapBytes32 (Hdr->CommandCode);

  // Compute auth area offset: header(10) + handles(4*N)
  UINT32 HandleBytes = 4 * mCurrentCmdHandleCount;
  UINT32 AuthOffset = 10 + HandleBytes;

  // Write the refreshed nonceCaller into the auth area
  // Auth area layout: authAreaSize(4) + sessionHandle(4) + nonceCaller(2+32) + attrs(1) + hmac(2+32)
  // nonceCaller TPM2B: size(2) at AuthOffset+8, data(32) at AuthOffset+10
  Nonce = PblTpmGetNonceCaller ();
  if (Nonce != NULL) {
    *(UINT16 *)(CommandBuffer + AuthOffset + 8) = SwapBytes16 (32);
    CopyMem (CommandBuffer + AuthOffset + 10, Nonce, 32);
  }

  // Parameters start after: header(10) + handles(4*N) + authAreaSize(4) + authArea(73)
  UINT32 ParamsOffset = AuthOffset + 4 + 73;
  ParamsStart = CommandBuffer + ParamsOffset;
  ParamsSize = TotalSize - ParamsOffset;

  // Build pHash input: handles + parameters (per TPM 2.0 Part 1 §18.1,
  // cpHash = H(TPM_CC || handles || params), auth area excluded)
  UINTN HashInputSize = HandleBytes + ParamsSize;
  UINT8 *HashInput = AllocatePool (HashInputSize);
  if (HashInput == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }
  CopyMem (HashInput, CommandBuffer + 10, HandleBytes);  // handles
  CopyMem (HashInput + HandleBytes, ParamsStart, ParamsSize);  // params

  // Compute pHash-based HMAC
  Status = PblTpmComputeCommandHmacEx (CommandCode, HashInput, HashInputSize, Hmac);
  FreePool (HashInput);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Fill HMAC into auth area at: AuthOffset + 4 + 4 + 2 + 32 + 1 + 2 = AuthOffset + 45
  CopyMem (CommandBuffer + AuthOffset + 45, Hmac, 32);

  return EFI_SUCCESS;
}

/** Skip the authorization area in a TPM_ST_SESSIONS response.

  For TPM_ST_SESSIONS responses, after the 10-byte header there is a
  4-byte parameterSize, then the response parameters, then the auth area.
  This function returns a pointer to the response parameters (past the
  parameterSize field) and sets *ParamSize to the parameter area size.

  D-102: If an HMAC session is active, verifies the response HMAC using
  proper pHash (SHA256 of responseCode || commandCode || responseParameters).
  Returns NULL on HMAC mismatch (fail-closed).

  @param RespBuf      Response buffer.
  @param RespSize     Total response size.
  @param CommandCode  The TPM command code (for pHash computation).
  @param ParamSize    Output: size of the parameter area.

  @return Pointer to the start of response parameters, or NULL on error/HMAC mismatch.
**/
STATIC
UINT8 *
PblTpmParseSessionResponse (
  IN  UINT8   *RespBuf,
  IN  UINT32   RespSize,
  IN  UINT32   CommandCode,
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

  // D-102: Verify response HMAC if session is active (fail-closed)
  // Response layout: header(10) | parameterSize(4) | params(Param) | authArea
  // Auth area: nonceTPM(TPM2B) | sessionAttributes(1) | hmac(TPM2B)
  if (PblTpmIsSessionActive () && RespSize > 14 + Param + 2) {
    UINT8 *AuthPtr = RespBuf + 14 + Param;

    // Extract nonceTPM (TPM2B) — will update session state after verification
    UINT16 NonceTpmSize = SwapBytes16 (*(UINT16 *)AuthPtr);
    UINT8 *NonceTpmPtr = AuthPtr + 2;
    if (NonceTpmSize > 32 || (NonceTpmPtr + NonceTpmSize) > (RespBuf + RespSize)) {
      return NULL;  // Malformed auth area — fail-closed
    }
    AuthPtr += 2 + NonceTpmSize;

    // Skip sessionAttributes (1 byte)
    AuthPtr += 1;

    // Read response HMAC (TPM2B)
    UINT16 RespHmacSize = SwapBytes16 (*(UINT16 *)AuthPtr);
    AuthPtr += 2;

    if (RespHmacSize == 32 && (AuthPtr + 32) <= (RespBuf + RespSize)) {
      // D-102: Fail-closed — return NULL on HMAC mismatch
      // Use proper pHash-based verification (SHA256 of responseCode || commandCode || responseParams)
      EFI_STATUS HmacStatus = PblTpmVerifyResponseHmacEx (
                                CommandCode,
                                RespBuf + 10,           // starts at responseCode
                                (UINTN)(4 + Param),     // responseCode(4) + responseParams(Param)
                                AuthPtr);
      if (EFI_ERROR (HmacStatus)) {
        return NULL;
      }

      // D-102: Update nonceTPM from response for next command's HMAC
      PblTpmUpdateNonceTpm (NonceTpmPtr, NonceTpmSize);
    }
  }

  return RespBuf + 14;
}

/** D-102: Fill the PCR session HMAC into a TPM2 command's auth area.

  Parallel to PblTpmFillCommandHmac but uses the PCR session (mPcrSession)
  instead of the NV session (mSession). Computes pHash-based HMAC and writes
  it into the pre-reserved auth area.

  @param  CommandBuffer  The TPM2 command buffer.
  @param  TotalSize      Total command size.

  @retval EFI_SUCCESS       HMAC filled.
  @retval EFI_NOT_STARTED   No active PCR session.
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
STATIC
EFI_STATUS
PblTpmFillPcrCommandHmac (
  IN OUT UINT8  *CommandBuffer,
  IN     UINT32  TotalSize
  )
{
  PBL_TPM2_COMMAND_HEADER *Hdr;
  UINT32  CommandCode;
  UINT8  *ParamsStart;
  UINTN  ParamsSize;
  UINT8   Hmac[32];
  CONST UINT8 *Nonce;
  EFI_STATUS Status;

  if (!PblTpmIsPcrSessionActive ()) {
    return EFI_NOT_STARTED;
  }

  // Refresh PCR session nonceCaller for replay protection
  Status = PblTpmRefreshPcrNonce ();
  if (EFI_ERROR (Status)) {
    return Status;
  }

  Hdr = (PBL_TPM2_COMMAND_HEADER *)CommandBuffer;
  CommandCode = SwapBytes32 (Hdr->CommandCode);

  // Compute auth area offset: header(10) + handles(4*N)
  UINT32 PcrHandleBytes = 4 * mCurrentCmdHandleCount;
  UINT32 PcrAuthOffset = 10 + PcrHandleBytes;

  // Write refreshed nonceCaller into auth area
  Nonce = PblTpmGetPcrNonceCaller ();
  if (Nonce != NULL) {
    *(UINT16 *)(CommandBuffer + PcrAuthOffset + 8) = SwapBytes16 (32);
    CopyMem (CommandBuffer + PcrAuthOffset + 10, Nonce, 32);
  }

  // Parameters start after: header(10) + handles(4*N) + authAreaSize(4) + authArea(73)
  UINT32 PcrParamsOffset = PcrAuthOffset + 4 + 73;
  ParamsStart = CommandBuffer + PcrParamsOffset;
  ParamsSize = TotalSize - PcrParamsOffset;

  // Build pHash input: handles + parameters
  UINTN PcrHashInputSize = PcrHandleBytes + ParamsSize;
  UINT8 *PcrHashInput = AllocatePool (PcrHashInputSize);
  if (PcrHashInput == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }
  CopyMem (PcrHashInput, CommandBuffer + 10, PcrHandleBytes);
  CopyMem (PcrHashInput + PcrHandleBytes, ParamsStart, ParamsSize);

  // Compute pHash-based HMAC using the PCR session
  PBL_TPM_SESSION *PcrSession = PblTpmGetPcrSession ();
  if (PcrSession == NULL) {
    FreePool (PcrHashInput);
    return EFI_NOT_STARTED;
  }
  Status = PblTpmComputeCommandHmacSession (
             PcrSession, CommandCode, PcrHashInput, PcrHashInputSize, Hmac);
  FreePool (PcrHashInput);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Fill HMAC into auth area at: PcrAuthOffset + 45
  CopyMem (CommandBuffer + PcrAuthOffset + 45, Hmac, 32);

  return EFI_SUCCESS;
}

/** D-102: Parse a TPM_ST_SESSIONS response for a PCR session command.

  Parallel to PblTpmParseSessionResponse but verifies the response HMAC
  using the PCR session (mPcrSession). Returns NULL on HMAC mismatch
  (fail-closed).

  @param RespBuf      Response buffer.
  @param RespSize     Total response size.
  @param CommandCode  The TPM command code (for pHash computation).
  @param ParamSize    Output: size of the parameter area.

  @return Pointer to response parameters, or NULL on error/HMAC mismatch.
**/
STATIC
UINT8 *
PblTpmParsePcrSessionResponse (
  IN  UINT8   *RespBuf,
  IN  UINT32   RespSize,
  IN  UINT32   CommandCode,
  OUT UINT32  *ParamSize
  )
{
  if (RespSize < 14) {
    return NULL;
  }

  UINT32 Param = SwapBytes32 (*(UINT32 *)(RespBuf + 10));
  if (Param > RespSize - 14) {
    return NULL;
  }

  *ParamSize = Param;

  // Verify response HMAC using PCR session (fail-closed)
  if (PblTpmIsPcrSessionActive () && RespSize > 14 + Param + 2) {
    UINT8 *AuthPtr = RespBuf + 14 + Param;

    // Extract nonceTPM (TPM2B) — will update session state after verification
    UINT16 NonceTpmSize = SwapBytes16 (*(UINT16 *)AuthPtr);
    UINT8 *NonceTpmPtr = AuthPtr + 2;
    if (NonceTpmSize > 32 || (NonceTpmPtr + NonceTpmSize) > (RespBuf + RespSize)) {
      return NULL;  // Malformed auth area — fail-closed
    }
    AuthPtr += 2 + NonceTpmSize;
    AuthPtr += 1;  // sessionAttributes

    UINT16 RespHmacSize = SwapBytes16 (*(UINT16 *)AuthPtr);
    AuthPtr += 2;

    if (RespHmacSize == 32 && (AuthPtr + 32) <= (RespBuf + RespSize)) {
      PBL_TPM_SESSION *PcrSession = PblTpmGetPcrSession ();
      if (PcrSession == NULL) {
        return NULL;
      }
      EFI_STATUS HmacStatus = PblTpmVerifyResponseHmacSession (
                                PcrSession,
                                CommandCode,
                                RespBuf + 10,
                                (UINTN)(4 + Param),
                                AuthPtr);
      if (EFI_ERROR (HmacStatus)) {
        return NULL;
      }

      // D-102: Update nonceTPM from response for next command's HMAC
      PblTpmUpdatePcrNonceTpm (NonceTpmPtr, NonceTpmSize);
    }
  }

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

  // TPM2_NV_Read(0x01C00001, offset=0, size=64) with HMAC session auth.
  // D-102: When HMAC session is active, command parameters are encrypted
  // with AES-256-CFB before sending, and response parameters are decrypted.
  // NV_Read has two handles: authHandle + nvIndex (both = NV index).
  UINT32 NvHandles[] = { PBL_NV_LOCK_STATE, PBL_NV_LOCK_STATE };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read, 2, NvHandles);
  UINT8 *ParamsStart = Ptr;  // Save start of parameters for encryption
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);  // size
  Ptr += 2;
  UINTN ParamsSize = (UINTN)(Ptr - ParamsStart);

  // D-102: Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));

  // D-102: Encrypt command parameters if HMAC session is active
  if (PblTpmIsSessionActive ()) {
    PblTpmEncryptCommandParams (ParamsStart, ParamsSize);
  }

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + parameterSize(4) + TPM2B_MAX_BUFFER(2 + data) + auth
  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, TPM_CC_NV_Read, &ParamSize);
  if (RespPtr == NULL || ParamSize < 4) {
    return EFI_DEVICE_ERROR;
  }

  // D-102: Decrypt response parameters if HMAC session is active
  // The response parameters are the TPM2B buffer containing the NV data
  if (PblTpmIsSessionActive ()) {
    PblTpmDecryptResponseParams (RespPtr, ParamSize);
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

  // TPM2_NV_Read(0x01C00002, offset=0, size=8) with HMAC session auth.
  // D-102: Encrypt command parameters if session is active.
  UINT32 PvHandles[] = { PBL_NV_POLICY_VERSION, PBL_NV_POLICY_VERSION };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read, 2, PvHandles);
  UINT8 *ParamsStart = Ptr;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (8);   // size (uint64)
  Ptr += 2;
  UINTN ParamsSize = (UINTN)(Ptr - ParamsStart);

  // D-102: Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));

  if (PblTpmIsSessionActive ()) {
    PblTpmEncryptCommandParams (ParamsStart, ParamsSize);
  }

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) + parameterSize(4) + TPM2B_MAX_BUFFER(2 + 8) + auth
  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, TPM_CC_NV_Read, &ParamSize);
  if (RespPtr == NULL || ParamSize < 10) {
    return EFI_DEVICE_ERROR;
  }

  // D-102: Decrypt response parameters if session is active
  if (PblTpmIsSessionActive ()) {
    PblTpmDecryptResponseParams (RespPtr, ParamSize);
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

  // TPM2_NV_Increment(0x01C00002) with session auth
  UINT32 IncHandles[] = { PBL_NV_POLICY_VERSION, PBL_NV_POLICY_VERSION };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Increment, 2, IncHandles);

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

  // TPM2_NV_Write(0x01C00001, offset=0, data=64 bytes) with HMAC session auth.
  // D-102: When HMAC session is active, command parameters (including the
  // data being written) are encrypted with AES-256-CFB before sending.
  UINT32 WriteHandles[] = { PBL_NV_LOCK_STATE, PBL_NV_LOCK_STATE };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Write, 2, WriteHandles);
  UINT8 *ParamsStart = Ptr;  // Save start of parameters for encryption
  // TPM2B_NV_BUFFER: 2-byte size + data
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);
  Ptr += 2;
  CopyMem (Ptr, Cache, PBL_LOCK_STATE_SIZE);
  Ptr += PBL_LOCK_STATE_SIZE;
  // offset
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;
  UINTN ParamsSize = (UINTN)(Ptr - ParamsStart);

  // D-102: Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));

  // D-102: Encrypt command parameters if HMAC session is active
  if (PblTpmIsSessionActive ()) {
    PblTpmEncryptCommandParams (ParamsStart, ParamsSize);
  }

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
  // D-102: Use HMAC session for PCR extends (C2 §3.3). If PCR session is
  // active, use it; otherwise fall back to no-session (scaffold).
  UINT8 *Ptr;
  if (PblTpmIsPcrSessionActive ()) {
    // Use PCR HMAC session with pcrHandle BEFORE the auth area.
    // TPM 2.0 wire format: header(10) + pcrHandle(4) + authAreaSize(4) + auth(73) + params
    mCurrentCmdHandleCount = 1;
    PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)CmdBuf;
    Hdr->Tag         = SwapBytes16 (TPM_ST_SESSIONS);
    Hdr->CommandSize = SwapBytes32 (sizeof (PBL_TPM2_COMMAND_HEADER));
    Hdr->CommandCode = SwapBytes32 ((UINT32)TPM_CC_PCR_Extend);
    Ptr = CmdBuf + sizeof (PBL_TPM2_COMMAND_HEADER);

    // pcrHandle goes before the auth area
    *(UINT32 *)Ptr = SwapBytes32 (PcrIndex);
    Ptr += 4;

    // Auth area: 73 bytes (handle(4) + nonce(2+32) + attrs(1) + hmac(2+32))
    *(UINT32 *)Ptr = SwapBytes32 (73);
    Ptr += 4;
    *(UINT32 *)Ptr = SwapBytes32 (PblTpmGetPcrSessionHandle ());
    Ptr += 4;
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;
    *Ptr = PBL_SESSION_ATTRS;
    Ptr += 1;
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;
  } else {
    // Fallback: no-session (TPM_ST_NO_SESSIONS)
    Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_PCR_Extend);
  }

  if (!PblTpmIsPcrSessionActive ()) {
    *(UINT32 *)Ptr = SwapBytes32 (PcrIndex);  // PCR handle (in no-session mode)
    Ptr += 4;
  }
  *(UINT32 *)Ptr = SwapBytes32 (1);  // digest count
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (TPM_ALG_SHA256);  // hash algorithm
  Ptr += 2;
  CopyMem (Ptr, Data, 32);  // digest
  Ptr += 32;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  // D-102: Fill PCR session HMAC into auth area (after params are written)
  if (PblTpmIsPcrSessionActive ()) {
    Status = PblTpmFillPcrCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));
    if (EFI_ERROR (Status)) {
      return Status;
    }
  }

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // D-102: Verify response HMAC for PCR session (fail-closed)
  if (PblTpmIsPcrSessionActive ()) {
    UINT32 ParamSize;
    UINT8 *RespPtr = PblTpmParsePcrSessionResponse (
                       RespBuf, RespSize, TPM_CC_PCR_Extend, &ParamSize);
    if (RespPtr == NULL) {
      return EFI_SECURITY_VIOLATION;
    }
  }

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
  //          alg(2) + sizeofSelect(1) + pcrSelect(3) = 21 bytes
  // TPMS_PCR_SELECTION: hash(2) + sizeofSelect(1) + pcrSelect(sizeofSelect)
  // For a single PCR: set the bit in the 3-byte bitmap
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_PCR_Read);
  *(UINT32 *)Ptr = SwapBytes32 (1);  // pcr selection count
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (TPM_ALG_SHA256);  // hash algorithm
  Ptr += 2;
  *Ptr = 3;  // sizeofSelect = 3 (UINT8, not UINT16 per TPM 2.0 spec)
  Ptr += 1;
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
  // pcrSelection = count(4) + [ hashAlg(2) + sizeofSelect(1) +
  //   pcrSelect(sizeofSelect) ] * count
  //
  // pcrValues = [ TPM2B_DIGEST ] * (number of selected PCRs)
  //   TPM2B_DIGEST = size(2) + digest(size bytes)
  //
  // We requested 1 PCR with SHA-256, so there should be exactly
  // one 32-byte digest in the response.
  if (RespSize < 10 + 4 + 4 + 2 + 1 + 3 + 2) {
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

  // Skip hashAlg(2) + sizeofSelect(1)
  RespPtr += 3;
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

/** D-111: Get TPM firmware version via TPM2_GetCapability.

  Sends TPM2_GetCapability(TPM_CAP_TPM_PROPERTIES,
  TPM_PT_FIRMWARE_VERSION_1, 1) and returns the firmware version
  as a UINT32. The version format is vendor-specific but typically
  major.minor packed as 0x00MMmm00.

  @param  Version  Output: firmware version (0 if TPM not present).

  @retval EFI_SUCCESS       Version retrieved.
  @retval EFI_NOT_FOUND     No TPM present.
  @retval EFI_DEVICE_ERROR  TPM command failed.
**/
EFI_STATUS
PblTpmGetFirmwareVersion (
  OUT UINT32  *Version
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[64];
  UINT8              RespBuf[128];
  UINT32             RespSize;
  UINT8             *Ptr;
  UINT8             *RespPtr;
  UINT32             CapResult;
  UINT32             PropCount;

  if (Version == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *Version = 0;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_GetCapability(capability=TPM_CAP_TPM_PROPERTIES,
  //                    property=TPM_PT_FIRMWARE_VERSION_1, propertyCount=1)
  Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_GetCapability);
  *(UINT32 *)Ptr = SwapBytes32 (TPM_CAP_TPM_PROPERTIES);  Ptr += 4;
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_PT_FIRMWARE_VERSION_1);  Ptr += 4;
  *(UINT32 *)Ptr = SwapBytes32 (1);  Ptr += 4;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse response: TPMI_ST_COMMAND_TAG(2) + UINT32(paramSize) +
  // UINT32(responseCode) + UINT32(capability) + UINT32(count) +
  // TPMS_TAGGED_PROPERTY(property + value)
  if (RespSize < 2 + 4 + 4 + 4 + 4 + 4 + 4) {
    return EFI_DEVICE_ERROR;
  }

  RespPtr = RespBuf;
  RespPtr += 2;   // tag
  RespPtr += 4;   // paramSize
  RespPtr += 4;   // responseCode (check for TPM_RC_SUCCESS = 0)
  if (*(UINT32 *)RespPtr != 0) {
    return EFI_DEVICE_ERROR;
  }
  RespPtr += 4;
  CapResult = SwapBytes32 (*(UINT32 *)RespPtr);
  RespPtr += 4;
  if (CapResult != TPM_CAP_TPM_PROPERTIES) {
    return EFI_DEVICE_ERROR;
  }
  PropCount = SwapBytes32 (*(UINT32 *)RespPtr);
  RespPtr += 4;
  if (PropCount < 1) {
    return EFI_DEVICE_ERROR;
  }
  RespPtr += 4;  // property (TPM_PT_FIRMWARE_VERSION_1)
  *Version = SwapBytes32 (*(UINT32 *)RespPtr);

  return EFI_SUCCESS;
}
