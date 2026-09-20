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
// D-206: Track current command code for per-command encrypt/decrypt decisions
STATIC TPM_CC mCurrentCmdCode = 0;

// NG-T7: forward declarations — the lock-epoch helpers are defined later
// in this file but used by PblTpmReadLockState/WriteLockState above them.
STATIC EFI_STATUS PblTpmNvIncrementCounter (IN UINT32 NvIndex);
STATIC EFI_STATUS PblTpmNvReadCounter (IN UINT32 NvIndex, OUT UINT64 *Value);

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

  // Always report the response size — callers need it to decode the TPM
  // return code on the error path.
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

// D-206: Session attributes must be set per-command based on what the TPM
// supports. Not all commands support both decrypt and encrypt. If the session
// has decrypt set but the command doesn't support decrypt (DecryptSize==0),
// the TPM returns TPM_RCS_ATTRIBUTES. Same for encrypt.
// TPMA_SESSION bits: bit0=continueSession, bit5=decrypt, bit6=encrypt
#define PBL_SESSION_CONTINUE  BIT0
#define PBL_SESSION_DECRYPT   BIT5
#define PBL_SESSION_ENCRYPT   BIT6

/** D-206: Compute session attributes for a given TPM command code.

  Returns continueSession plus decrypt/encrypt as appropriate for the command.
  The TPM rejects sessions with decrypt set for commands that don't support
  parameter decryption (DecryptSize==0), and similarly for encrypt.

  @param  CommandCode  The TPM_CC_* command code.

  @return TPMA_SESSION byte for the auth area.
**/
UINT8
PblTpmSessionAttrsForCommand (
  IN  TPM_CC  CommandCode
  )
{
  UINT8 Attrs = PBL_SESSION_CONTINUE;

  // D-206: When session key is empty (unbound, no salt), the TPM ignores
  // decrypt/encrypt attributes and returns plaintext. PBL's encrypt/decrypt
  // functions would corrupt data if applied to plaintext, so skip these
  // attributes entirely when SessionKeySize == 0.
  if (PblTpmGetSessionKeySize () == 0 || !PblTpmParameterEncryptionEnabled ()) {
    return Attrs;
  }

  switch ((UINT32)CommandCode) {
    // Commands that support parameter DECRYPTION (command params encrypted):
    // (PCR_Extend/PCR_Event are sent on the empty-key PCR session, which
    // uses continueSession only — see PblTpmExtendPcrWithSessionAuth.)
    case TPM_CC_NV_DefineSpace:
    case TPM_CC_NV_Write:
    case TPM_CC_NV_Extend:
    case TPM_CC_NV_ChangeAuth:
      Attrs |= PBL_SESSION_DECRYPT;
      break;

    // Commands that support parameter ENCRYPTION (response params encrypted):
    case TPM_CC_NV_Read:
      Attrs |= PBL_SESSION_ENCRYPT;
      break;

    // Commands that support BOTH decrypt and encrypt:
    // (none in the PBL command set currently)

    // Commands that support NEITHER (no parameters to encrypt):
    case TPM_CC_NV_Increment:
    default:
      // continueSession only
      break;
  }

  return Attrs;
}

// Legacy: continueSession | decrypt | encrypt (used by callers that haven't
// been updated to per-command attributes)
#define PBL_SESSION_ATTRS  (BIT0 | BIT5 | BIT6)

/** D-206: Check if a command supports parameter decryption (encrypt before sending).

  The TPM only decrypts command parameters if the session has the decrypt
  attribute set AND the command supports parameter decryption (DecryptSize > 0).
  Encrypting parameters for commands that don't support decrypt causes BAD_AUTH
  because the TPM computes cpHash over the encrypted (not decrypted) params.

  @param  CommandCode  The TPM_CC_* command code.

  @retval TRUE   Command supports decrypt — parameters should be encrypted.
  @retval FALSE  Command does not support decrypt — parameters sent in plaintext.
**/
STATIC
BOOLEAN
PblTpmCommandSupportsDecrypt (
  IN  TPM_CC  CommandCode
  )
{
  // Only encrypt when the session actually claims the decrypt attribute:
  // requires a non-empty sessionKey (PblTpmSessionAttrsForCommand skips the
  // attr for empty-key sessions) and the REQ-05 PCD.
  if (PblTpmGetSessionKeySize () == 0 || !PblTpmParameterEncryptionEnabled ()) {
    return FALSE;
  }
  switch ((UINT32)CommandCode) {
    case TPM_CC_NV_DefineSpace:
    case TPM_CC_NV_Write:
    case TPM_CC_NV_Extend:
    case TPM_CC_NV_ChangeAuth:
      return TRUE;
    default:
      return FALSE;
  }
}

/** D-206: Check if a command supports parameter encryption (response params encrypted).

  The TPM only encrypts response parameters if the session has the encrypt
  attribute set AND the command supports parameter encryption (EncryptSize > 0).

  @param  CommandCode  The TPM_CC_* command code.

  @retval TRUE   Command supports encrypt — response parameters are encrypted.
  @retval FALSE  Command does not support encrypt — response parameters in plaintext.
**/
STATIC
BOOLEAN
PblTpmCommandSupportsEncrypt (
  IN  TPM_CC  CommandCode
  )
{
  // D-215: Skip parameter encryption until CFB key/IV derivation is implemented.
  if (!PblTpmParameterEncryptionEnabled ()) {
    return FALSE;
  }
  switch ((UINT32)CommandCode) {
    case TPM_CC_NV_Read:
      return TRUE;
    default:
      return FALSE;
  }
}

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
  mCurrentCmdCode = CommandCode;

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
    // D-206: HMAC session auth. When the session key is empty (unbound, no salt)
    // and the entity auth is empty, the expected HMAC is empty (0 bytes).
    // Auth area layout:
    //   With 32-byte HMAC: handle(4) + nonceCaller(2+32) + attrs(1) + hmac(2+32) = 73
    //   With  0-byte HMAC: handle(4) + nonceCaller(2+32) + attrs(1) + hmac(2+0)  = 41
    UINT8 HmacSize = PblTpmGetSessionKeySize ();
    UINT32 AuthAreaSize = (UINT32)(4 + 2 + 32 + 1 + 2 + HmacSize);
    *(UINT32 *)Ptr = SwapBytes32 (AuthAreaSize);
    Ptr += 4;

    // sessionHandle = active session handle
    *(UINT32 *)Ptr = SwapBytes32 (PblTpmGetSessionHandle ());
    Ptr += 4;

    // nonceCaller = placeholder TPM2B(32 bytes), filled by PblTpmFillCommandHmac
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;

    // sessionAttributes = continueSession + per-command decrypt/encrypt
    // D-206: TPM rejects decrypt/encrypt attributes for commands that don't
    // support parameter encryption. Compute attributes per command code.
    *Ptr = PblTpmSessionAttrsForCommand (CommandCode);
    Ptr += 1;

    // hmac = placeholder TPM2B(HmacSize bytes), filled by PblTpmFillCommandHmac
    *(UINT16 *)Ptr = SwapBytes16 (HmacSize);
    Ptr += 2;
    if (HmacSize > 0) {
      ZeroMem (Ptr, HmacSize);
      Ptr += HmacSize;
    }
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

// ============================================================================
// D-206: NV index name computation
// ============================================================================
// TPM 2.0 Part 1 §16: The NAME of an NV index is:
//   nameAlg(2 bytes) || H(nameAlg, TPMS_NV_PUBLIC)
// where TPMS_NV_PUBLIC is serialized as:
//   nvIndex(4) + nameAlg(2) + attributes(4) + authPolicy(TPM2B) + dataSize(2)
// For hierarchy handles (TPM_RH_OWNER, etc.), the name IS the handle (4 bytes).

#define PBL_NV_NAME_MAX  34  // 2 (nameAlg) + 32 (SHA-256 digest)

// TPMA_NV_WRITTEN (bit 29) — SET by the TPM after the first successful write.
// It is part of the NV index's public area, so it changes the entity Name.
#define PBL_TPMA_NV_WRITTEN  0x20000000

typedef struct {
  UINT32   NvIndex;
  UINT32   Attributes;   // current TPMA_NV (WRITTEN updated after writes)
  UINT16   DataSize;
  BOOLEAN  Valid;
} PBL_NV_NAME_ENTRY;

STATIC PBL_NV_NAME_ENTRY mNvNameCache[3] = { 0 };

/** D-206: Compute the TPM NAME for an NV index.

  The name is nameAlg || H(nameAlg, TPMS_NV_PUBLIC) where TPMS_NV_PUBLIC
  is the serialized public info (14 bytes for our indices).

  @param  NvIndex    The NV index handle.
  @param  Attributes The TPMA_NV attributes.
  @param  DataSize   The data size.
  @param  Name       Output buffer (at least 34 bytes).
  @param  NameSize   Output: name size (34 for SHA-256).

  @retval EFI_SUCCESS  Name computed.
**/
STATIC
EFI_STATUS
PblTpmComputeNvName (
  IN  UINT32  NvIndex,
  IN  UINT32  Attributes,
  IN  UINT16  DataSize,
  OUT UINT8  *Name,
  OUT UINT8  *NameSize
  )
{
  // Serialize TPMS_NV_PUBLIC (14 bytes):
  // nvIndex(4) + nameAlg(2) + attributes(4) + authPolicy(2+0) + dataSize(2)
  UINT8 NvPublic[14];
  UINT8 *Ptr = NvPublic;

  *(UINT32 *)Ptr = SwapBytes32 (NvIndex);
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (0x000B);  // nameAlg = TPM_ALG_SHA256
  Ptr += 2;
  *(UINT32 *)Ptr = SwapBytes32 (Attributes);
  Ptr += 4;
  *(UINT16 *)Ptr = SwapBytes16 (0);  // authPolicy size = 0
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (DataSize);
  Ptr += 2;

  // Name = nameAlg(2) || SHA256(TPMS_NV_PUBLIC)
  *(UINT16 *)Name = SwapBytes16 (0x000B);  // nameAlg = TPM_ALG_SHA256
  if (!Sha256HashAll (NvPublic, sizeof (NvPublic), Name + 2)) {
    return EFI_DEVICE_ERROR;
  }
  *NameSize = 34;
  return EFI_SUCCESS;
}

/** D-206: Cache the name for a provisioned NV index.

  Called after successful NV_DefineSpace to register the name for later
  use in cpHash computation.

  @param  NvIndex    The NV index handle.
  @param  Attributes The TPMA_NV attributes used to define the index.
  @param  DataSize   The data size.
**/
VOID
PblTpmCacheNvName (
  IN UINT32  NvIndex,
  IN UINT32  Attributes,
  IN UINT16  DataSize
  )
{
  UINTN i;
  // Update an existing entry or claim a free slot.
  for (i = 0; i < ARRAY_SIZE (mNvNameCache); i++) {
    if (mNvNameCache[i].Valid && mNvNameCache[i].NvIndex == NvIndex) {
      mNvNameCache[i].Attributes = Attributes;
      mNvNameCache[i].DataSize   = DataSize;
      return;
    }
  }
  for (i = 0; i < ARRAY_SIZE (mNvNameCache); i++) {
    if (!mNvNameCache[i].Valid) {
      mNvNameCache[i].NvIndex    = NvIndex;
      mNvNameCache[i].Attributes = Attributes;
      mNvNameCache[i].DataSize   = DataSize;
      mNvNameCache[i].Valid      = TRUE;
      return;
    }
  }
}

/** D-206: Mark an NV index written (sets TPMA_NV_WRITTEN in cached attributes).

  Must be called after a successful TPM2_NV_Write / TPM2_NV_Increment so the
  entity Name used in cpHash and the bound-session includeAuth decision
  reflects the post-write public area.

  @param  NvIndex  The NV index that was written.
**/
VOID
PblTpmNvMarkWritten (
  IN UINT32  NvIndex
  )
{
  UINTN i;
  for (i = 0; i < ARRAY_SIZE (mNvNameCache); i++) {
    if (mNvNameCache[i].Valid && mNvNameCache[i].NvIndex == NvIndex) {
      mNvNameCache[i].Attributes |= PBL_TPMA_NV_WRITTEN;
      return;
    }
  }
}

/** D-206: Get the TPM NAME for a handle.

  For NV indices in our cache, returns the computed name (34 bytes).
  For hierarchy handles (TPM_RH_OWNER, etc.), the name is the handle (4 bytes).

  @param  Handle    The TPM handle.
  @param  Name      Output buffer (at least 34 bytes).
  @param  NameSize  Output: name size.

  @retval EFI_SUCCESS  Name retrieved.
**/
EFI_STATUS
PblTpmGetHandleName (
  IN  UINT32  Handle,
  OUT UINT8  *Name,
  OUT UINT8  *NameSize
  )
{
  UINTN i;

  // Check NV index name cache — recompute from the current attributes so the
  // name reflects TPMA_NV_WRITTEN / lock bits as they change.
  for (i = 0; i < ARRAY_SIZE (mNvNameCache); i++) {
    if (mNvNameCache[i].Valid && mNvNameCache[i].NvIndex == Handle) {
      return PblTpmComputeNvName (Handle, mNvNameCache[i].Attributes,
                                  mNvNameCache[i].DataSize, Name, NameSize);
    }
  }

  // For hierarchy handles, the name IS the handle (4 bytes, big-endian)
  *(UINT32 *)Name = SwapBytes32 (Handle);
  *NameSize = 4;
  return EFI_SUCCESS;
}

/** D-206: Determine includeAuth and the authorized entity's authValue for a
  command's session-0 authorization.

  Per TPM 2.0 Part 1 and libtpms SessionProcess.c:
    includeAuth = !IsSessionBindEntity(associatedHandle, session)
  When an HMAC session is bound to the entity it authorizes, the entity's
  authValue is already folded into sessionKey by KDFa, so it is NOT appended
  to the HMAC key. For every other entity the authValue is appended.

  The bound entity is Name || authValue captured at StartAuthSession. Since
  an NV index's Name contains TPMA_NV_WRITTEN, the bound match holds only
  while the Name is unchanged — the first write breaks it.

  @param  Session      The session being used for authorization.
  @param  AssocHandle  The handle authorized by session 0 (first handle).
**/
STATIC
VOID
PblTpmSetupSessionAuth (
  IN OUT PBL_TPM_SESSION  *Session,
  IN     UINT32            AssocHandle
  )
{
  UINT8  CurName[PBL_NV_NAME_MAX];
  UINT8  CurNameSize = 0;

  Session->IncludeAuth = TRUE;
  if (Session->BoundEntityNameSize > 0
      && AssocHandle == Session->BindHandle
      && !EFI_ERROR (PblTpmGetHandleName (AssocHandle, CurName, &CurNameSize))
      && CurNameSize == Session->BoundEntityNameSize
      && CompareMem (CurName, Session->BoundEntityName, CurNameSize) == 0) {
    Session->IncludeAuth = FALSE;
  }

  // authValue of the authorized entity. All PBL NV indices share the
  // configured NV auth value; hierarchy and PCR handles use an empty
  // authValue in the dev/swtpm profile.
  Session->CmdAuthValueSize = 0;
  if ((AssocHandle >> 24) == 0x01) {  // TPM_HT_NV_INDEX
    CONST UINT8 *NvAuth = (CONST UINT8 *)FixedPcdGetPtr (PcdPblTpmNvAuthValue);
    UINTN        NvAuthSize = FixedPcdGetSize (PcdPblTpmNvAuthValue);
    if (NvAuthSize > sizeof (Session->CmdAuthValue)) {
      NvAuthSize = sizeof (Session->CmdAuthValue);
    }
    if (NvAuth != NULL && NvAuthSize > 0) {
      CopyMem (Session->CmdAuthValue, NvAuth, NvAuthSize);
      Session->CmdAuthValueSize = (UINT8)NvAuthSize;
    }
  }
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
  // Auth area layout: authAreaSize(4) + sessionHandle(4) + nonceCaller(2+32) + attrs(1) + hmac(2+HmacSize)
  // nonceCaller TPM2B: size(2) at AuthOffset+8, data(32) at AuthOffset+10
  Nonce = PblTpmGetNonceCaller ();
  if (Nonce != NULL) {
    *(UINT16 *)(CommandBuffer + AuthOffset + 8) = SwapBytes16 (32);
    CopyMem (CommandBuffer + AuthOffset + 10, Nonce, 32);
  }

  // D-206: When session key is empty (unbound, no salt) and entity auth is empty,
  // the expected HMAC is empty (0 bytes). The auth area was built with a 0-byte
  // HMAC placeholder. Just write 0x0000 for the HMAC size and skip computation.
  UINT8 HmacSize = PblTpmGetSessionKeySize ();
  if (HmacSize == 0) {
    // HMAC size field is at AuthOffset + 4 + 4 + 2 + 32 + 1 = AuthOffset + 43
    *(UINT16 *)(CommandBuffer + AuthOffset + 43) = SwapBytes16 (0);
    return EFI_SUCCESS;
  }

  // Parameters start after: header(10) + handles(4*N) + authAreaSize(4) + authArea(41+HmacSize)
  // The auth area content occupies 45 + HmacSize bytes from the authAreaSize field,
  // so parameters start at AuthOffset + 4 + (41 + HmacSize) = AuthOffset + 45 + HmacSize.
  UINT32 ParamsOffset = AuthOffset + 45 + HmacSize;
  ParamsStart = CommandBuffer + ParamsOffset;
  ParamsSize = TotalSize - ParamsOffset;

  // D-206: Build pHash input: handle NAMES + parameters (per TPM 2.0 Part 1 §18.1,
  // cpHash = H(TPM_CC || authName1 || ... || authNameN || params))
  // The TPM uses entity NAMES, not raw handle values. For NV indices, the name
  // is nameAlg || H(nameAlg, TPMS_NV_PUBLIC) = 34 bytes. For hierarchy handles,
  // the name IS the handle (4 bytes).
  // D-206: Set includeAuth + the authorized entity's authValue on the session.
  // Session 0 authorizes the first handle (the authHandle). For a session bound
  // to that entity whose Name is unchanged, the HMAC key is sessionKey alone.
  if (mCurrentCmdHandleCount > 0) {
    PBL_TPM_SESSION *Session = PblTpmGetSession ();
    if (Session != NULL) {
      UINT32 AssocHandle = SwapBytes32 (*(UINT32 *)(CommandBuffer + 10));
      PblTpmSetupSessionAuth (Session, AssocHandle);
    }
  }

  // C2 §3 REQ-05: when the session has the decrypt attribute for this
  // command, encrypt the first TPM2B parameter's buffer BEFORE the HMAC —
  // the TPM computes cpHash over the marshalled (encrypted) parameters.
  // Requires CmdAuthValue (the CFB extraKey), so it runs after
  // PblTpmSetupSessionAuth.
  if (PblTpmCommandSupportsDecrypt (CommandCode) && ParamsSize >= 2) {
    Status = PblTpmEncryptCommandParams (ParamsStart, ParamsSize);
    if (EFI_ERROR (Status)) {
      return Status;
    }
  }

  UINT8  HandleName[PBL_NV_NAME_MAX];
  UINT8  HandleNameSize;
  UINTN  NamesSize = 0;
  UINTN  i;

  // First pass: compute total name size
  for (i = 0; i < mCurrentCmdHandleCount; i++) {
    UINT32 Handle = SwapBytes32 (*(UINT32 *)(CommandBuffer + 10 + 4 * i));
    PblTpmGetHandleName (Handle, HandleName, &HandleNameSize);
    NamesSize += HandleNameSize;
  }

  UINTN HashInputSize = NamesSize + ParamsSize;
  UINT8 *HashInput = AllocatePool (HashInputSize);
  if (HashInput == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  // Second pass: copy names + params into hash input
  UINT8 *HPtr = HashInput;
  for (i = 0; i < mCurrentCmdHandleCount; i++) {
    UINT32 Handle = SwapBytes32 (*(UINT32 *)(CommandBuffer + 10 + 4 * i));
    PblTpmGetHandleName (Handle, HandleName, &HandleNameSize);
    CopyMem (HPtr, HandleName, HandleNameSize);
    HPtr += HandleNameSize;
  }
  CopyMem (HPtr, ParamsStart, ParamsSize);  // params (encrypted if decrypt attr set)

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

    // D-206: When session key is empty (unbound, no salt) and entity auth is empty,
    // the response HMAC is empty (0 bytes). Skip HMAC verification but still
    // update nonceTPM for the next command.
    if (RespHmacSize == 0) {
      // Update nonceTPM from response for next command's HMAC
      PblTpmUpdateNonceTpm (NonceTpmPtr, NonceTpmSize);
    } else if (RespHmacSize == 32 && (AuthPtr + 32) <= (RespBuf + RespSize)) {
      // D-206: The response HMAC is computed with the new nonceTPM from this
      // response. Update it before verification so the check uses the correct
      // nonce. If verification fails, the session is still fail-closed.
      PblTpmUpdateNonceTpm (NonceTpmPtr, NonceTpmSize);

      // D-102: Fail-closed — return NULL on HMAC mismatch.
      // rpHash = SHA256(responseCode(4) || commandCode(4) || responseParameters)
      // The parameterSize field is NOT part of rpHash (TPM 2.0 Part 1 §18.1) —
      // it is a transport field. responseCode is at RespBuf+6 and the
      // parameters are at RespBuf+14, so stage them into a contiguous buffer
      // (responseCode || params) for PblTpmVerifyResponseHmacEx.
      UINT8  *RpInput = AllocatePool (4 + Param);
      if (RpInput == NULL) {
        return NULL;
      }
      CopyMem (RpInput, RespBuf + 6, 4);               // responseCode
      CopyMem (RpInput + 4, RespBuf + 14, Param);      // responseParameters
      EFI_STATUS HmacStatus = PblTpmVerifyResponseHmacEx (
                                CommandCode,
                                RpInput,
                                (UINTN)(4 + Param),
                                AuthPtr);
      FreePool (RpInput);
      if (EFI_ERROR (HmacStatus)) {
        return NULL;
      }
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

  // D-206: When PCR session key is empty (unbound, no salt), the expected HMAC
  // is empty (0 bytes). Write 0x0000 for the HMAC size and skip computation.
  PBL_TPM_SESSION *PcrSession = PblTpmGetPcrSession ();
  if (PcrSession == NULL) {
    return EFI_NOT_STARTED;
  }
  // D-206: PCR session is unbound (bind=TPM_RH_NULL), so includeAuth is always
  // SET and the PCR handle's authValue is empty — the HMAC key is the session
  // key alone.
  PcrSession->IncludeAuth      = TRUE;
  PcrSession->CmdAuthValueSize = 0;

  if (PcrSession->SessionKeySize == 0) {
    // HMAC size field is at PcrAuthOffset + 4 + 4 + 2 + 32 + 1 = PcrAuthOffset + 43
    *(UINT16 *)(CommandBuffer + PcrAuthOffset + 43) = SwapBytes16 (0);
    return EFI_SUCCESS;
  }

  // Parameters start after: header(10) + handles(4*N) + authAreaSize(4) + authArea(41+HmacSize)
  // The auth area content occupies 45 + HmacSize bytes from the authAreaSize field.
  UINT32 PcrParamsOffset = PcrAuthOffset + 45 + PcrSession->SessionKeySize;
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

    // D-206: When PCR session key is empty, response HMAC is empty (0 bytes).
    // Skip HMAC verification but still update nonceTPM.
    if (RespHmacSize == 0) {
      PblTpmUpdatePcrNonceTpm (NonceTpmPtr, NonceTpmSize);
    } else if (RespHmacSize == 32 && (AuthPtr + 32) <= (RespBuf + RespSize)) {
      PBL_TPM_SESSION *PcrSession = PblTpmGetPcrSession ();
      if (PcrSession == NULL) {
        return NULL;
      }
      // D-206: Update nonceTPM before verification.
      PblTpmUpdatePcrNonceTpm (NonceTpmPtr, NonceTpmSize);

      // rpHash = SHA256(responseCode(4) || commandCode(4) || parameterSize(4) || params(Param))
      EFI_STATUS HmacStatus = PblTpmVerifyResponseHmacSession (
                                PcrSession,
                                CommandCode,
                                RespBuf + 6,
                                (UINTN)(8 + Param),
                                AuthPtr);
      if (EFI_ERROR (HmacStatus)) {
        return NULL;
      }
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
// C2 §5.4: NV index provisioning (first-boot self-provisioning)
// ============================================================================

/** Define a single TPM NV index using TPM2_NV_DefineSpace.

  Authorizes with TPM_RH_PLATFORM (empty password in dev/swtpm).
  If the index already exists, returns EFI_ALREADY_STARTED (caller ignores).

  @param  NvIndex     The NV index handle (e.g., PBL_NV_LOCK_STATE).
  @param  DataSize    Size of the NV space in bytes.
  @param  IsCounter   TRUE for TPMA_NV_COUNTER, FALSE for regular NV.

  @retval EFI_SUCCESS           NV space defined.
  @retval EFI_ALREADY_STARTED  NV space already exists (TPM_RC_NV_DEFINED).
  @retval EFI_DEVICE_ERROR      TPM command failed.
**/
STATIC
EFI_STATUS
PblTpmNvDefineSpace (
  IN UINT32   NvIndex,
  IN UINT16   DataSize,
  IN BOOLEAN  IsCounter
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

  // C2 §5.4: Bind the NV index to the platform hierarchy when possible.
  // Production builds set PcdPblTpmUsePlatformHierarchy=TRUE, which uses
  // TPM_RH_PLATFORM and adds PPREAD/PPWRITE so the lock state survives
  // TPM2_Clear(RH_OWNER). Dev/swtpm builds may set it to FALSE if the
  // platform auth has been randomized by the firmware.
  UINT32 NvAuthHierarchy;
  if (FixedPcdGetBool (PcdPblTpmUsePlatformHierarchy)) {
    NvAuthHierarchy = (UINT32)TPM_RH_PLATFORM;
  } else {
    NvAuthHierarchy = (UINT32)TPM_RH_OWNER;
  }

  // D-102: debug removed; the hierarchy is now always TPM_RH_PLATFORM in
  // production builds (PcdPblTpmUsePlatformHierarchy defaults to TRUE).

  UINT32 DefHandles[] = { NvAuthHierarchy };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (
                 CmdBuf, sizeof (CmdBuf), TPM_CC_NV_DefineSpace, 1, DefHandles);

  // D-206: TPM2_NV_DefineSpace wire parameter order (per NV_DefineSpace_In):
  //   1. TPM2B_AUTH        auth        (the index auth value)
  //   2. TPM2B_NV_PUBLIC   publicInfo  (the NV index public info)
  // The firmware previously serialized publicInfo before auth, which caused
  // the TPM to read the publicInfo size prefix (0x000E) as the auth size,
  // consume 14 bytes of "auth", and then read the actual auth (0x0000) as the
  // publicInfo size — triggering TPM_RC_SIZE on publicInfo (0x2D5).

  // TPM2B_AUTH: index auth value (PBL NV auth, provisioned at enrolment).
  // In development this comes from PcdPblTpmNvAuthValue. The HMAC session
  // started later is bound to the lock-state index using the same auth.
  CONST UINT8 *NvAuthValue = (CONST UINT8 *)FixedPcdGetPtr (PcdPblTpmNvAuthValue);
  UINTN      NvAuthValueSize = FixedPcdGetSize (PcdPblTpmNvAuthValue);
  if (NvAuthValueSize > 64) {
    NvAuthValueSize = 64;
  }
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)NvAuthValueSize);
  Ptr += 2;
  if (NvAuthValueSize > 0 && NvAuthValue != NULL) {
    CopyMem (Ptr, NvAuthValue, NvAuthValueSize);
    Ptr += NvAuthValueSize;
  }

  // TPM2B_NV_PUBLIC: UINT16 size + TPMS_NV_PUBLIC
  // TPMS_NV_PUBLIC:
  //   nvIndex (UINT32) + nameAlg (UINT16) + attributes (UINT32) +
  //   authPolicy (TPM2B: UINT16 size=0) + dataSize (UINT16)
  // Total TPMS_NV_PUBLIC = 4+2+4+2+2 = 14 bytes
  *(UINT16 *)Ptr = SwapBytes16 (14);  // TPM2B_NV_PUBLIC size
  Ptr += 2;

  *(UINT32 *)Ptr = SwapBytes32 (NvIndex);  // nvIndex
  Ptr += 4;

  *(UINT16 *)Ptr = SwapBytes16 (0x000B);  // nameAlg = TPM_ALG_SHA256
  Ptr += 2;

  // C2 §5.4: TPMA_NV attributes depend on the chosen hierarchy.
  // Production (platform) attributes: PPWRITE|AUTHWRITE|POLICYWRITE|
  //                                    PPREAD |AUTHREAD |POLICYREAD |
  //                                    NO_DA | PLATFORMCREATE
  // The PLATFORMCREATE bit is required by the TPM when authHandle is
  // TPM_RH_PLATFORM. It prevents the owner hierarchy from deleting the index.
  // Dev/swtpm (owner) attributes:     AUTHWRITE|AUTHREAD|NO_DA
  // TPM_NT=COUNTER is set for the policy-version counter.
  UINT32 Attr;
  if (FixedPcdGetBool (PcdPblTpmUsePlatformHierarchy)) {
    Attr = 0x420D000D;  // PPWRITE|AUTHWRITE|POLICYWRITE|PPREAD|AUTHREAD|POLICYREAD|NO_DA|PLATFORMCREATE
  } else {
    Attr = 0x02040004;  // AUTHWRITE|AUTHREAD|NO_DA (owner-dev fallback)
  }
  if (IsCounter) {
    Attr |= (1 << 4);  // TPM_NT_COUNTER = 1 (bits 4-7)
  }
  *(UINT32 *)Ptr = SwapBytes32 (Attr);
  Ptr += 4;

  *(UINT16 *)Ptr = SwapBytes16 (0);  // authPolicy size = 0 (empty)
  Ptr += 2;

  *(UINT16 *)Ptr = SwapBytes16 (DataSize);  // dataSize
  Ptr += 2;

  // Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));


  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    // Check if the TPM returned TPM_RC_NV_DEFINED (0x14C) — already exists
    if (RespSize >= 10) {
      UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
      if (Rc == 0x14C) {
        return EFI_ALREADY_STARTED;
      }
      Print (L"  [WARN] NV_DefineSpace(0x%x) RC=0x%x\n", NvIndex, Rc);
    }
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Provision all three PBL NV indices (C2 §5.4).

  Called on first boot when NV reads fail. Defines:
    - PBL_NV_LOCK_STATE (64 bytes, regular NV)
    - PBL_NV_POLICY_VERSION (8 bytes, counter)
    - PBL_NV_AK_NAME (34 bytes, regular NV)

  If an index already exists, the error is ignored.

  @retval EFI_SUCCESS  All indices provisioned (or already existed).
**/
EFI_STATUS
PblTpmProvisionNvIndices (
  VOID
  )
{
  EFI_STATUS Status;

  // C2 §5.4: Use the platform hierarchy to define NV indices when
  // PcdPblTpmUsePlatformHierarchy is TRUE. This binds the lock state to the
  // hardware root (PH) and survives TPM2_Clear(RH_OWNER). Dev builds may fall
  // back to owner hierarchy if the firmware randomizes platform auth.
  UINT32 NvAttr;
  if (FixedPcdGetBool (PcdPblTpmUsePlatformHierarchy)) {
    // PPWRITE|AUTHWRITE|POLICYWRITE|PPREAD|AUTHREAD|POLICYREAD|NO_DA|PLATFORMCREATE
    NvAttr = 0x420D000D;
  } else {
    NvAttr = 0x02040004;  // AUTHWRITE|AUTHREAD|NO_DA
  }

  // Lock state: 64 bytes, regular NV
  Status = PblTpmNvDefineSpace (PBL_NV_LOCK_STATE, PBL_LOCK_STATE_SIZE, FALSE);
  if (EFI_ERROR (Status) && Status != EFI_ALREADY_STARTED) {
    Print (L"  [WARN] NV_DefineSpace(LOCK_STATE): %r\n", Status);
    return Status;
  }
  PblTpmCacheNvName (PBL_NV_LOCK_STATE, NvAttr, PBL_LOCK_STATE_SIZE);

  // Policy version: 8 bytes, counter
  Status = PblTpmNvDefineSpace (PBL_NV_POLICY_VERSION, 8, TRUE);
  if (EFI_ERROR (Status) && Status != EFI_ALREADY_STARTED) {
    Print (L"  [WARN] NV_DefineSpace(POLICY_VERSION): %r\n", Status);
    return Status;
  }
  PblTpmCacheNvName (PBL_NV_POLICY_VERSION, NvAttr | (1 << 4), 8);

  // AK name: 34 bytes, regular NV
  Status = PblTpmNvDefineSpace (PBL_NV_AK_NAME, 34, FALSE);
  if (EFI_ERROR (Status) && Status != EFI_ALREADY_STARTED) {
    Print (L"  [WARN] NV_DefineSpace(AK_NAME): %r\n", Status);
    return Status;
  }
  PblTpmCacheNvName (PBL_NV_AK_NAME, NvAttr, 34);

  // NG-T7: Lock-epoch counter — 8 bytes, monotonic. Incremented on every
  // lock-state write; the cache stores the epoch so a rolled-back NV state
  // is detectable at read time.
  Status = PblTpmNvDefineSpace (PBL_NV_LOCK_EPOCH, 8, TRUE);
  if (EFI_ERROR (Status) && Status != EFI_ALREADY_STARTED) {
    Print (L"  [WARN] NV_DefineSpace(LOCK_EPOCH): %r\n", Status);
    return Status;
  }
  PblTpmCacheNvName (PBL_NV_LOCK_EPOCH, NvAttr | (1 << 4), 8);

  // D-206: Refresh the cached names from NV_ReadPublic so the attributes
  // reflect the actual index state — in particular TPMA_NV_WRITTEN on an
  // index that persisted from a previous boot. The Name feeds both cpHash
  // and the bound-session includeAuth decision.
  PblTpmNvRefreshName (PBL_NV_LOCK_STATE);
  PblTpmNvRefreshName (PBL_NV_POLICY_VERSION);
  PblTpmNvRefreshName (PBL_NV_AK_NAME);

  return EFI_SUCCESS;
}

/** D-206: Refresh a cached NV index name from TPM2_NV_ReadPublic.

  NV_ReadPublic requires no authorization and returns the authoritative
  TPMS_NV_PUBLIC (including TPMA_NV_WRITTEN). The cached attributes are
  updated so PblTpmGetHandleName computes the current entity Name.

  @param  NvIndex  The NV index handle.

  @retval EFI_SUCCESS       Name refreshed from the TPM.
  @retval EFI_NOT_FOUND     No TPM present.
  @retval EFI_DEVICE_ERROR  TPM command failed or malformed response.
**/
EFI_STATUS
PblTpmNvRefreshName (
  IN UINT32  NvIndex
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[64];
  UINT8              RespBuf[256];
  UINT32             RespSize;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_NV_ReadPublic: TPM_ST_NO_SESSIONS, one handle (nvIndex), no params.
  UINT8 *Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_ReadPublic);
  *(UINT32 *)Ptr = SwapBytes32 (NvIndex);
  Ptr += 4;
  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Response: header(10) | TPM2B_NV_PUBLIC | TPM2B_NAME
  // TPMS_NV_PUBLIC inside the TPM2B: nvIndex(4) nameAlg(2) attributes(4)
  // authPolicy(TPM2B: 2+N) dataSize(2). attributes at offset 10+2+4+2 = 18.
  if (RespSize < 10 + 2 + 14) {
    return EFI_DEVICE_ERROR;
  }
  UINT16 NvPublicSize = SwapBytes16 (*(UINT16 *)(RespBuf + 10));
  if (NvPublicSize < 14 || ((UINT32)NvPublicSize + 12) > RespSize) {
    return EFI_DEVICE_ERROR;
  }
  UINT8  *NvPublic = RespBuf + 12;
  UINT32  Attrs    = SwapBytes32 (*(UINT32 *)(NvPublic + 6));
  UINT16  PolSize  = SwapBytes16 (*(UINT16 *)(NvPublic + 10));
  if (NvPublicSize < (UINT16)(12 + PolSize + 2)) {
    return EFI_DEVICE_ERROR;
  }
  UINT16  DataSize = SwapBytes16 (*(UINT16 *)(NvPublic + 12 + PolSize));

  PblTpmCacheNvName (NvIndex, Attrs, DataSize);
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

  // TPM2_NV_Read(0x01C00001, size=64, offset=0) with HMAC session auth.
  // D-102: When HMAC session is active, command parameters are encrypted
  // with AES-256-CFB before sending, and response parameters are decrypted.
  // NV_Read has two handles: authHandle + nvIndex (both = NV index).
  // NV_Read_In wire order: size (UINT16) then offset (UINT16).
  UINT32 NvHandles[] = { PBL_NV_LOCK_STATE, PBL_NV_LOCK_STATE };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read, 2, NvHandles);
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);  // size
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  // D-102: Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));


  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    if (RespSize >= 10) {
      UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
      Print (L"  [WARN] NV_Read(LOCK_STATE) RC=0x%x\n", Rc);
      // D-206: TPM_RC_NV_UNINITIALIZED (0x14A) means the index was defined but
      // never written. This is the expected state on first boot — treat as
      // "no cached value" (EFI_NOT_FOUND), not a device error.
      if (Rc == 0x14A) {
        return EFI_NOT_FOUND;
      }
    }
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
  if (PblTpmIsSessionActive () && PblTpmGetSessionKeySize () > 0 && PblTpmCommandSupportsEncrypt (mCurrentCmdCode)) {
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

  // NG-T7: freshness check. The lock-epoch counter is monotonic — a cache
  // written under an epoch lower than the live counter was rolled back
  // (a stale pre-lock 'unlocked' state replayed over the current NV).
  // Distrust it: report EFI_NOT_FOUND so the caller falls back to a fresh
  // verdict fetch. Epoch==0 means the write predates epoch stamping
  // (old firmware) — treat as no freshness info, don't fail closed.
  if (Cache->Epoch != 0) {
    UINT64 LiveEpoch = 0;
    EFI_STATUS EpochStatus = PblTpmNvReadCounter (PBL_NV_LOCK_EPOCH, &LiveEpoch);
    if (!EFI_ERROR (EpochStatus) && Cache->Epoch < LiveEpoch) {
      Print (L"  [WARN] lock-state epoch stale (cache=%lu live=%lu) — rolled back?\n",
             Cache->Epoch, LiveEpoch);
      ZeroMem (Cache, sizeof (PBL_LOCK_STATE_CACHE));
      return EFI_NOT_FOUND;
    }
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

  // TPM2_NV_Read(0x01C00002, size=8, offset=0) with HMAC session auth.
  // D-102: Encrypt command parameters if session is active.
  // NV_Read_In wire order: size (UINT16) then offset (UINT16).
  UINT32 PvHandles[] = { PBL_NV_POLICY_VERSION, PBL_NV_POLICY_VERSION };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read, 2, PvHandles);
  *(UINT16 *)Ptr = SwapBytes16 (8);   // size (uint64)
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  // D-102: Fill HMAC into auth area (parameter encryption, when enabled,
  // happens inside FillCommandHmac before cpHash).
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    if (RespSize >= 10) {
      UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
      Print (L"  [WARN] NV_Read(POLICY_VERSION) RC=0x%x\n", Rc);
      // D-206: TPM_RC_NV_UNINITIALIZED (0x14A) — counter not yet incremented
      if (Rc == 0x14A) {
        return EFI_NOT_FOUND;
      }
    }
    return Status;
  }

  // Response: header(10) + parameterSize(4) + TPM2B_MAX_BUFFER(2 + 8) + auth
  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, TPM_CC_NV_Read, &ParamSize);
  if (RespPtr == NULL || ParamSize < 10) {
    return EFI_DEVICE_ERROR;
  }

  // D-102: Decrypt response parameters if session is active
  if (PblTpmIsSessionActive () && PblTpmGetSessionKeySize () > 0 && PblTpmCommandSupportsEncrypt (mCurrentCmdCode)) {
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

/** Roll mSession.NonceTpm from a TPM_ST_SESSIONS response that carries no
  parameters (NV_Write, NV_Increment).

  The TPM returns a fresh nonceTPM in every session response; the next
  command's HMAC must use it. These callers skip PblTpmParseSessionResponse
  because they have no response params to consume — this helper updates
  just the nonce so a subsequent NV-session command does not compute its
  HMAC with a stale nonceTPM (which would fail with TPM_RC_BAD_AUTH).

  Response layout: header(10) + parameterSize(4) + params(parameterSize)
  + nonceTPM TPM2B + attributes(1) + hmac TPM2B.

  @param RespBuf   Response buffer.
  @param RespSize  Response size.
**/
STATIC
VOID
PblTpmRollNonceFromSessionResponse (
  IN UINT8   *RespBuf,
  IN UINT32  RespSize
  )
{
  UINT32 ParamSize;
  UINT8  *NoncePtr;
  UINT16 NonceSize;

  if (!PblTpmIsSessionActive () || RespBuf == NULL || RespSize < 16) {
    return;
  }
  ParamSize = SwapBytes32 (*(UINT32 *)(RespBuf + 10));
  if (14 + ParamSize + 2 > RespSize) {
    return;
  }
  NoncePtr  = RespBuf + 14 + ParamSize;
  NonceSize = SwapBytes16 (*(UINT16 *)NoncePtr);
  if ((UINT32)(NoncePtr + 2 - RespBuf) + NonceSize > RespSize) {
    return;
  }
  PblTpmUpdateNonceTpm (NoncePtr + 2, NonceSize);
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
  // NV_Increment has no command parameters (just two handles), but the
  // HMAC must still be computed and filled into the auth area.
  UINT32 IncHandles[] = { PBL_NV_POLICY_VERSION, PBL_NV_POLICY_VERSION };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Increment, 2, IncHandles);

  // D-206: Fill HMAC into auth area (no params to encrypt, but HMAC is required)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status) && RespSize >= 10) {
    UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
    Print (L"  [WARN] NV_Increment(POLICY_VERSION) RC=0x%x\n", Rc);
  }
  if (!EFI_ERROR (Status)) {
    // D-206: First increment sets TPMA_NV_WRITTEN — keep the Name cache current.
    PblTpmNvMarkWritten (PBL_NV_POLICY_VERSION);
    // Roll nonceTPM so a subsequent session command uses the fresh nonce.
    PblTpmRollNonceFromSessionResponse (RespBuf, RespSize);
  }
  return Status;
}

/** NG-T7: Increment an arbitrary NV counter index with session auth.

  Generalises PblTpmIncrementPolicyVersion for any TPMA_NV_COUNTER index.

  @param  NvIndex  The counter NV index to increment.
  @retval EFI_SUCCESS  Counter incremented (and Name cache refreshed).
**/
STATIC
EFI_STATUS
PblTpmNvIncrementCounter (
  IN UINT32  NvIndex
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

  UINT32 IncHandles[] = { NvIndex, NvIndex };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Increment, 2, IncHandles);
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));
  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status) && RespSize >= 10) {
    UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
    Print (L"  [WARN] NV_Increment(0x%x) RC=0x%x\n", NvIndex, Rc);
  }
  if (!EFI_ERROR (Status)) {
    PblTpmNvMarkWritten (NvIndex);
    PblTpmRollNonceFromSessionResponse (RespBuf, RespSize);
  }
  return Status;
}

/** NG-T7: Read an NV counter index's current value (uint64).

  Generalises PblTpmReadPolicyVersion for any TPMA_NV_COUNTER index.

  @param  NvIndex  The counter NV index to read.
  @param  Value    Output counter value (host order).
  @retval EFI_SUCCESS    Counter read.
  @retval EFI_NOT_FOUND  Index never written (TPM_RC_NV_UNINITIALIZED).
**/
STATIC
EFI_STATUS
PblTpmNvReadCounter (
  IN  UINT32   NvIndex,
  OUT UINT64  *Value
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[512];
  UINT32             RespSize;

  if (Value == NULL) {
    return EFI_INVALID_PARAMETER;
  }
  *Value = 0;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  UINT32 Handles[] = { NvIndex, NvIndex };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Read, 2, Handles);
  *(UINT16 *)Ptr = SwapBytes16 (8);   // size (uint64)
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (0);   // offset
  Ptr += 2;
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));
  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    if (RespSize >= 10) {
      UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
      if (Rc == 0x14A) {  // TPM_RC_NV_UNINITIALIZED
        return EFI_NOT_FOUND;
      }
      Print (L"  [WARN] NV_Read(counter 0x%x) RC=0x%x\n", NvIndex, Rc);
    }
    return Status;
  }

  UINT32 ParamSize;
  UINT8 *RespPtr = PblTpmParseSessionResponse (RespBuf, RespSize, TPM_CC_NV_Read, &ParamSize);
  if (RespPtr == NULL || ParamSize < 10) {
    return EFI_DEVICE_ERROR;
  }
  if (PblTpmIsSessionActive () && PblTpmGetSessionKeySize () > 0 && PblTpmCommandSupportsEncrypt (mCurrentCmdCode)) {
    PblTpmDecryptResponseParams (RespPtr, ParamSize);
  }

  UINT16 DataSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;
  if (DataSize < 8) {
    return EFI_DEVICE_ERROR;
  }
  UINT64 BeValue;
  CopyMem (&BeValue, RespPtr, 8);
  *Value = SwapBytes64 (BeValue);
  return EFI_SUCCESS;
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

  // NG-T7: stamp the record with a fresh lock-epoch. Increment the
  // monotonic counter, read the new value into a mutable copy, and write
  // that — a rolled-back NV state will carry an epoch lower than the live
  // counter and be rejected on read. If the epoch index is unavailable
  // (unprovisioned / old TPM), the write proceeds with Epoch=0 — which a
  // read treats as "no freshness info" rather than failing closed.
  PBL_LOCK_STATE_CACHE Stamped = *Cache;
  UINT64 NewEpoch = 0;
  if (!EFI_ERROR (PblTpmNvIncrementCounter (PBL_NV_LOCK_EPOCH)) &&
      !EFI_ERROR (PblTpmNvReadCounter (PBL_NV_LOCK_EPOCH, &NewEpoch))) {
    Stamped.Epoch = NewEpoch;
  } else {
    Stamped.Epoch = 0;
  }

  // TPM2_NV_Write(0x01C00001, offset=0, data=64 bytes) with HMAC session auth.
  // D-102: When HMAC session is active, command parameters (including the
  // data being written) are encrypted with AES-256-CFB before sending.
  UINT32 WriteHandles[] = { PBL_NV_LOCK_STATE, PBL_NV_LOCK_STATE };
  UINT8 *Ptr = PblTpmBeginCommandWithSessionAuth (CmdBuf, sizeof (CmdBuf), TPM_CC_NV_Write, 2, WriteHandles);
  // TPM2B_NV_BUFFER: 2-byte size + data
  *(UINT16 *)Ptr = SwapBytes16 (PBL_LOCK_STATE_SIZE);
  Ptr += 2;
  CopyMem (Ptr, &Stamped, PBL_LOCK_STATE_SIZE);
  Ptr += PBL_LOCK_STATE_SIZE;
  // offset
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;
  // D-102: Fill HMAC into auth area (over plaintext params, before encryption)
  PblTpmFillCommandHmac (CmdBuf, (UINT32)(Ptr - CmdBuf));


  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status) && RespSize >= 10) {
    UINT32 Rc = SwapBytes32 (*(UINT32 *)(RespBuf + 6));
    Print (L"  [WARN] NV_Write(LOCK_STATE) RC=0x%x\n", Rc);
  }
  if (!EFI_ERROR (Status)) {
    // D-206: The write set TPMA_NV_WRITTEN, mutating the entity Name. Update
    // the cached attributes so cpHash and the bound-session includeAuth
    // decision use the post-write Name.
    PblTpmNvMarkWritten (PBL_NV_LOCK_STATE);
    // Roll nonceTPM so a subsequent session command uses the fresh nonce.
    PblTpmRollNonceFromSessionResponse (RespBuf, RespSize);
  }
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
    // TPM 2.0 wire format: header(10) + pcrHandle(4) + authAreaSize(4) + auth + params
    // D-206: PCR session is unbound (SessionKeySize=0), so auth area uses
    // 41-byte layout with 0-byte HMAC (same pattern as main NV session).
    mCurrentCmdHandleCount = 1;
    mCurrentCmdCode = TPM_CC_PCR_Extend;
    PBL_TPM_SESSION *PcrSession = PblTpmGetPcrSession ();
    UINT8 PcrHmacSize = PcrSession ? PcrSession->SessionKeySize : 0;
    UINT32 PcrAuthAreaSize = (UINT32)(4 + 2 + 32 + 1 + 2 + PcrHmacSize);
    PBL_TPM2_COMMAND_HEADER *Hdr = (PBL_TPM2_COMMAND_HEADER *)CmdBuf;
    Hdr->Tag         = SwapBytes16 (TPM_ST_SESSIONS);
    Hdr->CommandSize = SwapBytes32 (sizeof (PBL_TPM2_COMMAND_HEADER));
    Hdr->CommandCode = SwapBytes32 ((UINT32)TPM_CC_PCR_Extend);
    Ptr = CmdBuf + sizeof (PBL_TPM2_COMMAND_HEADER);

    // pcrHandle goes before the auth area
    *(UINT32 *)Ptr = SwapBytes32 (PcrIndex);
    Ptr += 4;

    // Auth area: handle(4) + nonce(2+32) + attrs(1) + hmac(2+PcrHmacSize)
    *(UINT32 *)Ptr = SwapBytes32 (PcrAuthAreaSize);
    Ptr += 4;
    *(UINT32 *)Ptr = SwapBytes32 (PblTpmGetPcrSessionHandle ());
    Ptr += 4;
    *(UINT16 *)Ptr = SwapBytes16 (32);
    Ptr += 2;
    ZeroMem (Ptr, 32);
    Ptr += 32;
    // PCR session has an empty sessionKey — continueSession only. Parameter
    // encryption (decrypt attr) is NV-session-only; a decrypt attr here would
    // make the TPM CFB-decrypt the digest list with an empty sessionValue.
    *Ptr = PBL_SESSION_CONTINUE;
    Ptr += 1;
    *(UINT16 *)Ptr = SwapBytes16 (PcrHmacSize);
    Ptr += 2;
    if (PcrHmacSize > 0) {
      ZeroMem (Ptr, PcrHmacSize);
      Ptr += PcrHmacSize;
    }
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

/** S1.1: Read TPM reset/restart counters via TPM2_ReadClock.

  Sends TPM2_ReadClock and parses TPMS_TIME_INFO. Per TPM 2.0 Part 1:
    - resetCount   increments on every TPM reset (cold boot /
                   TPM2_Startup CLEAR) — the hardware boot-ID anchor the
                   server uses to correlate a PBL boot with an agent
                   check-in; unreadable and rollback-proof from the OS.
    - restartCount increments on every TPM restart from saved state
                   (TPM_SU_STATE / S3 resume) — the resume signal.
    - safe         reports the clock's reliability.

  TPM2_ReadClock requires no authorization and no session.

  Response layout (TPM 2.0 Part 3 §23.4):
    header(10) + TPMS_TIME_INFO
    TPMS_TIME_INFO   = time(8) + TPMS_CLOCK_INFO
    TPMS_CLOCK_INFO  = clock(8) + resetCount(4) + restartCount(4) + safe(1)

  @param[out]  ResetCount    TPM reset counter (cold-boot count = boot-ID).
  @param[out]  RestartCount  TPM restart counter (S3-resume count).
  @param[out]  ClockSafe     TRUE if the clock is reliable (safe=YES).

  @retval EFI_SUCCESS          Counters read.
  @retval EFI_INVALID_PARAMETER Null output pointer.
  @retval EFI_NOT_FOUND        No TPM present.
  @retval EFI_DEVICE_ERROR     TPM command failed or malformed response.
**/
EFI_STATUS
PblTpmReadRestartCounter (
  OUT UINT32   *ResetCount,
  OUT UINT32   *RestartCount,
  OUT BOOLEAN  *ClockSafe
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[64];
  UINT8              RespBuf[128];
  UINT32             RespSize;
  UINT8             *Ptr;
  UINT8             *RespPtr;

  if (ResetCount == NULL || RestartCount == NULL || ClockSafe == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *ResetCount   = 0;
  *RestartCount = 0;
  *ClockSafe    = FALSE;

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // TPM2_ReadClock — no handles, no parameters, no session.
  Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_ReadClock);
  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Minimum response: header(10) + time(8) + clock(8) + resetCount(4) +
  // restartCount(4) + safe(1) = 35 bytes.
  if (RespSize < 10 + 8 + 8 + 4 + 4 + 1) {
    return EFI_DEVICE_ERROR;
  }

  RespPtr = RespBuf;
  // Response header: tag(2) + size(4) + responseCode(4)
  if (SwapBytes32 (*(UINT32 *)(RespPtr + 6)) != 0) {
    return EFI_DEVICE_ERROR;  // non-TPM_RC_SUCCESS
  }
  RespPtr += 10;

  RespPtr += 8;  // time (UINT64) — unused
  RespPtr += 8;  // clock (UINT64) — unused

  *ResetCount   = SwapBytes32 (*(UINT32 *)RespPtr);  RespPtr += 4;
  *RestartCount = SwapBytes32 (*(UINT32 *)RespPtr);  RespPtr += 4;
  *ClockSafe    = (*RespPtr != 0);

  return EFI_SUCCESS;
}
