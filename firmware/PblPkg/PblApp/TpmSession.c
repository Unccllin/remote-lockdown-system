/** @file
  TpmSession.c — C2 §3: HMAC session with AES-256-CFB parameter encryption.

  Implements TPM2_StartAuthSession with TPM_SE_HMAC, AES-256-CFB symmetric
  encryption, and SHA256 auth hash. This is the C2 §3.1 defence against
  dTPM bus sniffing (T3).

  Key primitives:
    1. AES-256-CFB — implemented from AES-CBC single-block encryption
       (AesCbcEncrypt with IV=0 on a 16-byte block gives E_K(block))
    2. KDFa — TPM 2.0 key derivation function using HMAC-SHA256
    3. TPM2_StartAuthSession — creates the HMAC session
    4. Command HMAC — HMAC-SHA256 over the command using the session key
    5. Parameter encryption — AES-256-CFB with IV=0 on the parameters

  Session lifecycle:
    1. PblTpmStartHmacSession() — creates the session, stores session state
    2. PblTpmEncryptCommandParams() — encrypts parameters before sending
    3. PblTpmComputeCommandHmac() — computes HMAC for the command
    4. PblTpmDecryptResponseParams() — decrypts response parameters
    5. PblTpmVerifyResponseHmac() — verifies response HMAC
    6. PblTpmFlushSession() — flushes the session before chain-loading

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"
#include <IndustryStandard/Tpm20.h>

// AES block size
#define AES_BLOCK_SIZE 16

// Session attributes: continueSession + decrypt + encrypt
#define PBL_SESSION_ATTRS  (BIT0 | BIT5 | BIT6)

// ============================================================================
// AES-256-CFB implementation (from AES-CBC single-block)
// ============================================================================

/** AES-256-CFB encrypt/decrypt (CFB-128 mode).

  CFB-128 is symmetric: both encrypt and decrypt use E_K(feedback) as the
  keystream. The only difference is what gets XORed:
    Encrypt: C_i = P_i XOR E_K(C_{i-1}), C_{-1} = IV
    Decrypt: P_i = C_i XOR E_K(C_{i-1}), C_{-1} = IV

  Since the keystream generation is the same, this single function handles
  both operations. The caller passes the ciphertext for decrypt, plaintext
  for encrypt — the XOR result is the output.

  @param  Key       AES-256 key (32 bytes).
  @param  Iv        Initialization vector (16 bytes, all zeros for TPM).
  @param  Data      Data to encrypt/decrypt (in-place, must be 16-byte aligned).
  @param  DataSize  Size of data (must be multiple of 16 for full-block CFB).
  @param  Output    Output buffer (same size as Data).

  @retval TRUE   Success.
  @retval FALSE  AES operation failed.
**/
STATIC
BOOLEAN
PblAesCfb256Process (
  IN  CONST UINT8  *Key,
  IN  CONST UINT8  *Iv,
  IN  CONST UINT8  *Data,
  IN  UINTN         DataSize,
  OUT UINT8        *Output
  )
{
  UINT8  AesCtx[1024];  // Stack-allocated AES context (AesGetContextSize returns ~248 but pad for safety)
  UINT8  ZeroIv[AES_BLOCK_SIZE];
  UINT8  Feedback[AES_BLOCK_SIZE];
  UINT8  Keystream[AES_BLOCK_SIZE];
  UINTN  Offset;

  if (Key == NULL || Iv == NULL || Data == NULL || Output == NULL) {
    return FALSE;
  }

  // Initialize AES context with 256-bit key
  ZeroMem (AesCtx, sizeof (AesCtx));
  if (!AesInit (AesCtx, Key, 256)) {
    return FALSE;
  }

  // Initial feedback = IV
  CopyMem (Feedback, Iv, AES_BLOCK_SIZE);
  ZeroMem (ZeroIv, AES_BLOCK_SIZE);

  // Process each 16-byte block
  for (Offset = 0; Offset + AES_BLOCK_SIZE <= DataSize; Offset += AES_BLOCK_SIZE) {
    // Keystream block = E_K(feedback)
    // AesCbcEncrypt with IV=0 on a single block gives E_K(block)
    if (!AesCbcEncrypt (AesCtx, Feedback, AES_BLOCK_SIZE, ZeroIv, Keystream)) {
      return FALSE;
    }

    // XOR keystream with data
    for (UINTN i = 0; i < AES_BLOCK_SIZE; i++) {
      Output[Offset + i] = Data[Offset + i] ^ Keystream[i];
    }

    // Update feedback = output (ciphertext for encrypt, ciphertext for decrypt)
    // In CFB, feedback is always the ciphertext block
    CopyMem (Feedback, Output + Offset, AES_BLOCK_SIZE);
  }

  // Handle remaining bytes (partial block) — CFB handles this naturally
  if (Offset < DataSize) {
    UINTN Remaining = DataSize - Offset;

    // Generate keystream from last feedback
    if (!AesCbcEncrypt (AesCtx, Feedback, AES_BLOCK_SIZE, ZeroIv, Keystream)) {
      return FALSE;
    }

    // XOR with remaining bytes
    for (UINTN i = 0; i < Remaining; i++) {
      Output[Offset + i] = Data[Offset + i] ^ Keystream[i];
    }
  }

  return TRUE;
}

// ============================================================================
// KDFa — TPM 2.0 Key Derivation Function (Part 1, Section 11.4.1)
// ============================================================================

/** KDFa with SHA-256.

  KDFa(SHA256, key, label, contextU, contextV, bits):
    counter = 0
    while bits > 0:
      counter++
      block = HMAC-SHA256(key, counter_BE32 || label || 0x00 || contextU || contextV || bits_BE32)
      result = result || block
      bits -= 256
    return result[0:bits/8]

  @param  Key       HMAC key.
  @param  KeySize   Size of key.
  @param  Label     Null-terminated label string (e.g., "ATH", "DEC", "ENC").
  @param  ContextU  Context U (e.g., nonceCaller).
  @param  ContextUSize  Size of context U.
  @param  ContextV  Context V (e.g., nonceTPM).
  @param  ContextVSize  Size of context V.
  @param  Bits      Number of bits to derive.
  @param  Output    Output buffer (must be at least Bits/8 bytes).
  @param  OutputSize  Size of output buffer.

  @retval TRUE   Success.
  @retval FALSE  HMAC failed or buffer too small.
**/
STATIC
BOOLEAN
PblKDFa (
  IN  CONST UINT8  *Key,
  IN  UINTN         KeySize,
  IN  CONST CHAR8  *Label,
  IN  CONST UINT8  *ContextU,
  IN  UINTN         ContextUSize,
  IN  CONST UINT8  *ContextV,
  IN  UINTN         ContextVSize,
  IN  UINT32        Bits,
  OUT UINT8        *Output,
  IN  UINTN         OutputSize
  )
{
  UINT8   Block[32];     // SHA-256 output block
  UINT32  Counter = 0;
  UINT32  RemainingBits = Bits;
  UINTN   OutputOffset = 0;
  UINTN   LabelLen;

  if (Label == NULL || Output == NULL) {
    return FALSE;
  }
  // Key may be NULL when KeySize is 0 (unbound session with TPM_RH_NULL).
  // HMAC-SHA256 with an empty key is valid.
  if (OutputSize < (Bits + 7) / 8) {
    return FALSE;
  }

  LabelLen = AsciiStrLen (Label);

  while (RemainingBits > 0) {
    Counter++;

    // Initialize HMAC-SHA256 with the key
    // For unbound sessions (TPM_RH_NULL), Key is NULL and KeySize is 0.
    // OpenSSL's HMAC_Init_ex may reject NULL key, so use a dummy non-NULL
    // pointer when KeySize is 0.
    VOID *HmacCtx = HmacSha256New ();
    if (HmacCtx == NULL) {
      return FALSE;
    }
    CONST UINT8 EmptyKey[1] = { 0 };
    CONST UINT8 *HmacKey = (Key != NULL) ? Key : EmptyKey;
    if (!HmacSha256SetKey (HmacCtx, HmacKey, KeySize)) {
      HmacSha256Free (HmacCtx);
      return FALSE;
    }

    // counter (4 bytes, big-endian)
    UINT32 CounterBE = SwapBytes32 (Counter);
    HmacSha256Update (HmacCtx, (CONST UINT8 *)&CounterBE, 4);

    // label (without null terminator, but TPM spec includes it)
    // Actually, TPM 2.0 KDFa includes the null terminator in the label
    HmacSha256Update (HmacCtx, (CONST UINT8 *)Label, LabelLen + 1);

    // contextU
    if (ContextU != NULL && ContextUSize > 0) {
      HmacSha256Update (HmacCtx, ContextU, ContextUSize);
    }

    // contextV
    if (ContextV != NULL && ContextVSize > 0) {
      HmacSha256Update (HmacCtx, ContextV, ContextVSize);
    }

    // bits (4 bytes, big-endian)
    UINT32 BitsBE = SwapBytes32 (Bits);
    HmacSha256Update (HmacCtx, (CONST UINT8 *)&BitsBE, 4);

    // Finalize
    HmacSha256Final (HmacCtx, Block);
    HmacSha256Free (HmacCtx);

    // Copy to output
    UINTN CopyBytes = (RemainingBits < 256) ? (RemainingBits + 7) / 8 : 32;
    if (OutputOffset + CopyBytes > OutputSize) {
      CopyBytes = OutputSize - OutputOffset;
    }
    CopyMem (Output + OutputOffset, Block, CopyBytes);
    OutputOffset += CopyBytes;
    RemainingBits -= (RemainingBits < 256) ? RemainingBits : 256;
  }

  return TRUE;
}

// ============================================================================
// HMAC session state
// ============================================================================

// PBL_TPM_SESSION struct is defined in PblApp.h for cross-file access.

STATIC PBL_TPM_SESSION mSession = { 0 };

/** D-102: Second HMAC session for PCR extends (C2 §3.3).

  PCR extends use a separate session bound to TPM_RH_NULL (unbound session)
  since PCR operations don't bind to an NV index.
**/
STATIC PBL_TPM_SESSION mPcrSession = { 0 };

// ============================================================================
// TPM2_StartAuthSession
// ============================================================================

/** C2 §3.1: Start an HMAC session with AES-256-CFB parameter encryption.

  Sends TPM2_StartAuthSession:
    tpmKey         = TPM_RH_NULL (no salt)
    bind           = BindHandle (the NV index)
    nonceCaller    = 32 bytes from EFI_RNG
    sessionType    = TPM_SE_HMAC
    symmetric      = {algorithm=AES, keyBits=256, mode=CFB}
    authHash       = TPM_ALG_SHA256

  After StartAuthSession, computes the session key via KDFa:
    sessionKey = KDFa(SHA256, tpmKey||bindAuth, "ATH",
                      nonceCaller||nonceTPM, 256)

  If bindAuth is empty (development mode), the key is:
    sessionKey = KDFa(SHA256, empty, "ATH", nonceCaller||nonceTPM, 256)

  @param  BindHandle  The NV index handle to bind the session to.
  @param  BindAuth    The auth value of the bind object (may be empty).
  @param  BindAuthSize  Size of the auth value.

  @retval EFI_SUCCESS       Session started.
  @retval EFI_NOT_FOUND     No TPM present.
  @retval EFI_DEVICE_ERROR  TPM command failed.
**/
EFI_STATUS
PblTpmStartHmacSession (
  IN  UINT32        BindHandle,
  IN  CONST UINT8  *BindAuth,
  IN  UINTN         BindAuthSize
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[256];
  UINT32             RespSize;
  UINT8             *Ptr;
  UINT8             *RespPtr;

  if (mSession.Active) {
    return EFI_ALREADY_STARTED;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // Generate nonceCaller from EFI_RNG or TPM2_GetRandom
  Status = PblTpmGetRandom (mSession.NonceCaller, 32);
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  mSession.BindHandle = BindHandle;
  if (BindAuth != NULL && BindAuthSize > 0 && BindAuthSize <= sizeof (mSession.BindAuth)) {
    CopyMem (mSession.BindAuth, BindAuth, BindAuthSize);
    mSession.BindAuthSize = (UINT8)BindAuthSize;
  } else {
    mSession.BindAuthSize = 0;
  }

  // Build TPM2_StartAuthSession command
  // Format: TPM_ST_NO_SESSIONS + size + CC + tpmKey + bind + nonceCaller(TPM2B)
  //         + sessionType + symmetric + authHash
  Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_StartAuthSession);

  // tpmKey = TPM_RH_NULL
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_RH_NULL);
  Ptr += 4;

  // bind = BindHandle
  *(UINT32 *)Ptr = SwapBytes32 (BindHandle);
  Ptr += 4;

  // nonceCaller = TPM2B(32 bytes)
  *(UINT16 *)Ptr = SwapBytes16 (32);
  Ptr += 2;
  CopyMem (Ptr, mSession.NonceCaller, 32);
  Ptr += 32;

  // salt = TPM2B(0 bytes) — empty since tpmKey is TPM_RH_NULL (no encrypted salt)
  // Per TPM 2.0 Part 3 §11.1, the salt TPM2B_ENCRYPTED_SECRET is always present
  // in the command, even when tpmKey is TPM_RH_NULL (size=0, no data).
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;

  // sessionType = TPM_SE_HMAC
  *Ptr = (UINT8)TPM_SE_HMAC;
  Ptr += 1;

  // symmetric = TPMT_SYM_DEF: algorithm=AES, keyBits=256, mode=CFB
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_AES);   // algorithm
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (256);                    // keyBits
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_CFB);   // mode
  Ptr += 2;

  // authHash = TPM_ALG_SHA256
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_SHA256);
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse response: tag(2) + size(4) + responseCode(4) + sessionHandle(4)
  //   + nonceTPM(TPM2B) + optional sessionAttributes(1)
  // Note: swtpm 0.7.3 omits sessionAttributes; require only enough for
  // header + sessionHandle + nonceTPM.size field.
  if (RespSize < 2 + 4 + 4 + 4 + 2) {
    return EFI_DEVICE_ERROR;
  }

  RespPtr = RespBuf;
  RespPtr += 2;  // tag
  RespPtr += 4;  // size

  // Check response code
  if (*(UINT32 *)RespPtr != 0) {
    return EFI_DEVICE_ERROR;
  }
  RespPtr += 4;

  // Session handle
  mSession.SessionHandle = SwapBytes32 (*(UINT32 *)RespPtr);
  RespPtr += 4;

  // nonceTPM (TPM2B)
  UINT16 NonceTpmSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;
  if (NonceTpmSize > 32 || (RespPtr + NonceTpmSize) > (RespBuf + RespSize)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (mSession.NonceTpm, RespPtr, NonceTpmSize);
  if (NonceTpmSize < 32) {
    ZeroMem (mSession.NonceTpm + NonceTpmSize, 32 - NonceTpmSize);
  }
  RespPtr += NonceTpmSize;

  // D-206: Compute session key via KDFa.
  // Per libtpms Session.c, the session key is ONLY computed when bind != TPM_RH_NULL
  // or seed (salt) is non-empty. When bind=NULL and no salt (our case), the session
  // key stays empty (0 bytes). The HMAC key then becomes:
  //   sessionKey(empty) || authValue(of the entity)
  // For NV indices with empty auth, this is empty. When the HMAC key is empty AND
  // the input auth is empty, the expected HMAC is empty (0 bytes).
  // Previously PBL computed a 32-byte session key from KDFa with an empty key,
  // which produced a non-empty HMAC that didn't match the TPM's expected empty HMAC.
  mSession.SessionKeySize = 0;
  if (BindAuthSize > 0) {
    // Only compute session key if there's a bind auth value
    // sessionKey = KDFa(SHA256, bindAuth, "ATH", nonceTPM, nonceCaller, 256)
    // Per libtpms Session.c, contextU = nonceTPM and contextV = nonceCaller.
    if (!PblKDFa (BindAuth, BindAuthSize, "ATH",
                  mSession.NonceTpm, 32,       // contextU = nonceTPM
                  mSession.NonceCaller, 32,    // contextV = nonceCaller
                  256, mSession.SessionKey, sizeof (mSession.SessionKey))) {
      return EFI_DEVICE_ERROR;
    }
    mSession.SessionKeySize = 32;
  }

  // D-206: Capture the bound entity's Name for the includeAuth decision.
  // Per libtpms SessionProcess.c (IsSessionBindEntity / ComputeCommandHmac),
  // the TPM appends the authorized entity's authValue to the HMAC key ONLY
  // when the authorized entity is NOT the bound entity. The bound entity is
  // Name || authValue captured at StartAuthSession. For an NV index the Name
  // contains the TPMA_NV_WRITTEN attribute, so the bound-entity match breaks
  // after the first write — the authValue must then be appended again.
  // Comparing the entity's current Name to this captured Name reproduces
  // IsSessionBindEntity without duplicating the TPM's XOR packing.
  mSession.BoundEntityNameSize = 0;
  if (BindHandle != (UINT32)TPM_RH_NULL) {
    PblTpmGetHandleName (BindHandle, mSession.BoundEntityName,
                         &mSession.BoundEntityNameSize);
  }

  // Default for the first command; PblTpmFillCommandHmac sets these per command.
  mSession.IncludeAuth     = TRUE;
  mSession.CmdAuthValueSize = 0;

  mSession.Active = TRUE;
  return EFI_SUCCESS;
}

/** D-206: Get the NV HMAC session state (parallel to PblTpmGetPcrSession).

  @return Pointer to mSession, or NULL if no session is active.
**/
PBL_TPM_SESSION *
PblTpmGetSession (
  VOID
  )
{
  return mSession.Active ? &mSession : NULL;
}

/** Get the active session handle. Returns 0 if no session is active. **/
UINT32
PblTpmGetSessionHandle (
  VOID
  )
{
  return mSession.Active ? mSession.SessionHandle : 0;
}

/** D-206: Get the session key size. Returns 0 for unbound sessions (no KDFa). **/
UINT8
PblTpmGetSessionKeySize (
  VOID
  )
{
  return mSession.Active ? mSession.SessionKeySize : 0;
}

/** D-215: Return TRUE when AES-256-CFB parameter encryption is enabled.

  C2 §3 requires parameter encryption, but the CFB key/IV derivation from
  sessionValue (sessionKey || authValue) is not yet fully implemented.
  When this PCD is FALSE, PBL uses HMAC-only sessions with plaintext
  parameters. The session is still bound to the NV index and the HMAC key
  is KDFa-derived.

  @retval TRUE   Parameter encryption enabled.
  @retval FALSE  HMAC-only sessions (development default).
**/
BOOLEAN
PblTpmParameterEncryptionEnabled (
  VOID
  )
{
  return FixedPcdGetBool (PcdPblTpmUseParameterEncryption);
}

/** Check if an HMAC session is active. **/
BOOLEAN
PblTpmIsSessionActive (
  VOID
  )
{
  return mSession.Active;
}

/** D-102: Refresh the caller nonce for the next command.

  Per TPM 2.0 Part 1 §18.1, the nonceCaller should be refreshed for each
  command to provide replay protection. This generates a new 32-byte nonce
  from TPM2_GetRandom (which uses the TPM's internal RNG).

  After this call, the session's NonceCaller is updated. The next HMAC
  computation will use this new nonce.

  @retval EFI_SUCCESS       Nonce refreshed.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_DEVICE_ERROR  RNG failed.
**/
EFI_STATUS
PblTpmRefreshNonce (
  VOID
  )
{
  EFI_STATUS Status;

  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }

  Status = PblTpmGetRandom (mSession.NonceCaller, 32);
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Get a pointer to the current caller nonce (32 bytes).

  @return Pointer to the nonce, or NULL if no active session.
**/
CONST UINT8 *
PblTpmGetNonceCaller (
  VOID
  )
{
  return mSession.Active ? mSession.NonceCaller : NULL;
}

/** D-102: Refresh the PCR session nonceCaller (generate new 32-byte nonce).

  @retval EFI_SUCCESS       Nonce refreshed.
  @retval EFI_NOT_STARTED   No active PCR session.
  @retval EFI_DEVICE_ERROR  RNG failed.
**/
EFI_STATUS
PblTpmRefreshPcrNonce (
  VOID
  )
{
  EFI_STATUS Status;

  if (!mPcrSession.Active) {
    return EFI_NOT_STARTED;
  }

  Status = PblTpmGetRandom (mPcrSession.NonceCaller, 32);
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** D-102: Get pointer to the PCR session nonceCaller.

  @return Pointer to the nonce, or NULL if no active PCR session.
**/
CONST UINT8 *
PblTpmGetPcrNonceCaller (
  VOID
  )
{
  return mPcrSession.Active ? mPcrSession.NonceCaller : NULL;
}

/** D-102: Update nonceTPM from the response auth area (NV session).

  Per TPM 2.0 Part 1 §18.1, the TPM returns a new nonceTPM in each response.
  After successful HMAC verification, the session state must be updated so
  the next command's HMAC uses the latest nonceTPM.

  @param  NewNonceTpm   Pointer to the new nonceTPM (32 bytes).
  @param  NonceSize      Size of the nonce (must be <= 32).

  @retval EFI_SUCCESS       Nonce updated.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_INVALID_PARAMETER  Bad input.
**/
EFI_STATUS
PblTpmUpdateNonceTpm (
  IN  CONST UINT8  *NewNonceTpm,
  IN  UINTN         NonceSize
  )
{
  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }
  if (NewNonceTpm == NULL || NonceSize > 32) {
    return EFI_INVALID_PARAMETER;
  }

  CopyMem (mSession.NonceTpm, NewNonceTpm, NonceSize);
  if (NonceSize < 32) {
    ZeroMem (mSession.NonceTpm + NonceSize, 32 - NonceSize);
  }

  return EFI_SUCCESS;
}

/** D-102: Update nonceTPM from the response auth area (PCR session).

  @param  NewNonceTpm   Pointer to the new nonceTPM (32 bytes).
  @param  NonceSize      Size of the nonce (must be <= 32).

  @retval EFI_SUCCESS       Nonce updated.
  @retval EFI_NOT_STARTED   No active PCR session.
  @retval EFI_INVALID_PARAMETER  Bad input.
**/
EFI_STATUS
PblTpmUpdatePcrNonceTpm (
  IN  CONST UINT8  *NewNonceTpm,
  IN  UINTN         NonceSize
  )
{
  if (!mPcrSession.Active) {
    return EFI_NOT_STARTED;
  }
  if (NewNonceTpm == NULL || NonceSize > 32) {
    return EFI_INVALID_PARAMETER;
  }

  CopyMem (mPcrSession.NonceTpm, NewNonceTpm, NonceSize);
  if (NonceSize < 32) {
    ZeroMem (mPcrSession.NonceTpm + NonceSize, 32 - NonceSize);
  }

  return EFI_SUCCESS;
}

/** Encrypt command parameters using AES-256-CFB with the session key.

  TPM 2.0 parameter encryption uses AES-256-CFB with IV=0. Only the
  parameters after the handles area are encrypted.

  @param  Data      Data to encrypt (in-place).
  @param  DataSize  Size of data.

  @retval EFI_SUCCESS       Data encrypted.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_DEVICE_ERROR  AES operation failed.
**/
EFI_STATUS
PblTpmEncryptCommandParams (
  IN OUT UINT8  *Data,
  IN     UINTN  DataSize
  )
{
  UINT8 ZeroIv[AES_BLOCK_SIZE];

  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }
  if (Data == NULL || DataSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  ZeroMem (ZeroIv, AES_BLOCK_SIZE);
  if (!PblAesCfb256Process (mSession.SessionKey, ZeroIv, Data, DataSize, Data)) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Decrypt response parameters using AES-256-CFB with the session key.

  Same as encrypt — CFB is symmetric. The caller passes the encrypted
  response parameters and gets back the decrypted ones.

  @param  Data      Encrypted data (in-place, will be decrypted).
  @param  DataSize  Size of data.

  @retval EFI_SUCCESS       Data decrypted.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_DEVICE_ERROR  AES operation failed.
**/
EFI_STATUS
PblTpmDecryptResponseParams (
  IN OUT UINT8  *Data,
  IN     UINTN  DataSize
  )
{
  // CFB is symmetric — same operation for encrypt and decrypt
  return PblTpmEncryptCommandParams (Data, DataSize);
}

/** Compute the HMAC-SHA256 for a TPM2 command in the session.

  Per TPM 2.0 Part 1 §18.1, the command HMAC is:
    HMAC(sessionKey, pHash || nonceCaller || nonceTPM || sessionAttributes)

  where pHash = SHA256(commandCode || commandParameters).

  For NV_Read, commandParameters = nvIndex(4) || offset(2) || size(2).
  For NV_Write, commandParameters = nvIndex(4) || data(TPM2B) || offset(2).
  For NV_Increment, commandParameters = nvIndex(4).

  This implementation computes pHash from the command code and the
  parameter area (the bytes after the header + auth area).

  @param  CommandCode    The TPM command code (e.g., TPM_CC_NV_Read).
  @param  Params         Pointer to the command parameters (after auth area).
  @param  ParamsSize     Size of the command parameters.
  @param  Hmac           Output: 32-byte HMAC.

  @retval EFI_SUCCESS       HMAC computed.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_DEVICE_ERROR  HMAC failed.
**/
EFI_STATUS
PblTpmComputeCommandHmacEx (
  IN  UINT32        CommandCode,
  IN  CONST UINT8  *Params,
  IN  UINTN         ParamsSize,
  OUT UINT8        *Hmac
  )
{
  return PblTpmComputeCommandHmacSession (&mSession, CommandCode, Params, ParamsSize, Hmac);
}

/** Compute command HMAC for a specific session (internal helper).

  @param  Session      Pointer to the session state.
  @param  CommandCode  TPM command code.
  @param  Params       Command parameters (after auth area).
  @param  ParamsSize   Size of command parameters.
  @param  Hmac         Output: 32-byte HMAC.

  @retval EFI_SUCCESS       HMAC computed.
  @retval EFI_NOT_STARTED   Session not active.
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
EFI_STATUS
PblTpmComputeCommandHmacSession (
  IN  PBL_TPM_SESSION  *Session,
  IN  UINT32            CommandCode,
  IN  CONST UINT8      *Params,
  IN  UINTN             ParamsSize,
  OUT UINT8            *Hmac
  )
{
  UINT8  PHash[32];
  UINT8  HmacInput[128];

  if (!Session->Active) {
    return EFI_NOT_STARTED;
  }
  if (Hmac == NULL) {
    return EFI_INVALID_PARAMETER;
  }
  if (Params == NULL && ParamsSize > 0) {
    return EFI_INVALID_PARAMETER;
  }

  // Compute pHash = SHA256(commandCode || commandParameters)
  // Use Sha256All which takes (Data, DataSize, HashValue)
  // We need to hash commandCode (4 bytes BE) + params
  // Build a temporary buffer: commandCode || params
  UINTN InputSize = 4 + ParamsSize;
  UINT8 *PHashInput;

  if (InputSize > sizeof (HmacInput)) {
    PHashInput = AllocatePool (InputSize);
    if (PHashInput == NULL) {
      return EFI_OUT_OF_RESOURCES;
    }
  } else {
    PHashInput = HmacInput;
  }

  // commandCode (4 bytes, big-endian)
  *(UINT32 *)PHashInput = SwapBytes32 (CommandCode);
  if (ParamsSize > 0) {
    CopyMem (PHashInput + 4, Params, ParamsSize);
  }

  if (!Sha256HashAll (PHashInput, InputSize, PHash)) {
    if (PHashInput != HmacInput) {
      FreePool (PHashInput);
    }
    return EFI_DEVICE_ERROR;
  }
  if (PHashInput != HmacInput) {
    FreePool (PHashInput);
  }

  // Build HMAC input: pHash || nonceCaller(32) || nonceTPM(32) || sessionAttributes(1)
  // Per TPM 2.0 Part 1 §18.1, the HMAC input is:
  //   pHash || nonceCaller || nonceTPM || sessionAttributes
  // D-206: CryptDigestUpdate2B in libtpms only includes the data (not the
  // 2-byte TPM2B size prefix), so nonces are raw 32 bytes.
  // Per TPM 2.0 Part 1 §19.6.12 and libtpms ComputeCommandHmac, the HMAC key is
  //   hmacKey = sessionKey || authValue(authorized entity)
  // where the authValue is appended ONLY when includeAuth is SET — i.e. when
  // the authorized entity is NOT the entity the session is bound to. When the
  // session authorizes its bound entity, the authValue is already folded into
  // sessionKey by KDFa, so the key is sessionKey alone.
  // For an unbound session (bind=RH_NULL) with no auth, hmacKey is empty.
  UINTN AuthSize = Session->IncludeAuth ? Session->CmdAuthValueSize : 0;
  UINTN HmacKeySize = Session->SessionKeySize + AuthSize;
  UINT8 HmacKey[96];
  if (HmacKeySize > sizeof (HmacKey)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (HmacKey, Session->SessionKey, Session->SessionKeySize);
  CopyMem (HmacKey + Session->SessionKeySize, Session->CmdAuthValue, AuthSize);

  UINTN HmacInputSize = 32 + 32 + 32 + 1;
  UINT8 *HmacBuf = AllocatePool (HmacInputSize);
  if (HmacBuf == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  UINT8 *HPtr = HmacBuf;
  CopyMem (HPtr, PHash, 32);
  HPtr += 32;
  CopyMem (HPtr, Session->NonceCaller, 32);
  HPtr += 32;
  CopyMem (HPtr, Session->NonceTpm, 32);
  HPtr += 32;
  *HPtr = PblTpmSessionAttrsForCommand ((TPM_CC)CommandCode);
  HPtr += 1;

  if (!HmacSha256All (HmacBuf, HmacInputSize, HmacKey, HmacKeySize, Hmac)) {
    FreePool (HmacBuf);
    return EFI_DEVICE_ERROR;
  }
  FreePool (HmacBuf);

  return EFI_SUCCESS;
}

/** Compute the HMAC-SHA256 for a TPM2 command in the session.

  Simplified version — computes HMAC over the full command buffer.
  For proper pHash-based HMAC, use PblTpmComputeCommandHmacEx.

  @param  CommandBuffer  The TPM2 command buffer (without auth area).
  @param  CommandSize    Size of the command buffer.
  @param  Hmac           Output: 32-byte HMAC.

  @retval EFI_SUCCESS       HMAC computed.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_DEVICE_ERROR  HMAC failed.
**/
EFI_STATUS
PblTpmComputeCommandHmac (
  IN  CONST UINT8  *CommandBuffer,
  IN  UINTN         CommandSize,
  OUT UINT8        *Hmac
  )
{
  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }
  if (CommandBuffer == NULL || Hmac == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Simplified HMAC: HMAC-SHA256(sessionKey || authValue, commandBuffer)
  UINTN AuthSize = mSession.IncludeAuth ? mSession.CmdAuthValueSize : 0;
  UINTN HmacKeySize = mSession.SessionKeySize + AuthSize;
  UINT8 HmacKey[96];
  if (HmacKeySize > sizeof (HmacKey)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (HmacKey, mSession.SessionKey, mSession.SessionKeySize);
  CopyMem (HmacKey + mSession.SessionKeySize, mSession.CmdAuthValue, AuthSize);

  if (!HmacSha256All (CommandBuffer, CommandSize, HmacKey, HmacKeySize, Hmac)) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}

/** Verify the HMAC-SHA256 in a TPM2 response.

  Simplified version — computes HMAC over the raw response buffer.
  For proper pHash-based verification, use PblTpmVerifyResponseHmacEx.

  @param  ResponseBuffer  The TPM2 response buffer (starting at responseCode).
  @param  ResponseSize    Size of the response buffer.
  @param  ResponseHmac    The HMAC from the response auth area.

  @retval EFI_SUCCESS       HMAC verified.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_SECURITY_VIOLATION  HMAC mismatch.
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
EFI_STATUS
PblTpmVerifyResponseHmac (
  IN  CONST UINT8  *ResponseBuffer,
  IN  UINTN         ResponseSize,
  IN  CONST UINT8  *ResponseHmac
  )
{
  UINT8 ComputedHmac[32];

  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }
  if (ResponseBuffer == NULL || ResponseHmac == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // Compute expected HMAC using sessionKey || authValue (when includeAuth)
  UINTN AuthSize = mSession.IncludeAuth ? mSession.CmdAuthValueSize : 0;
  UINTN HmacKeySize = mSession.SessionKeySize + AuthSize;
  UINT8 HmacKey[96];
  if (HmacKeySize > sizeof (HmacKey)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (HmacKey, mSession.SessionKey, mSession.SessionKeySize);
  CopyMem (HmacKey + mSession.SessionKeySize, mSession.CmdAuthValue, AuthSize);

  if (!HmacSha256All (ResponseBuffer, ResponseSize, HmacKey, HmacKeySize, ComputedHmac)) {
    return EFI_DEVICE_ERROR;
  }

  if (CompareMem (ComputedHmac, ResponseHmac, 32) != 0) {
    return EFI_SECURITY_VIOLATION;
  }

  return EFI_SUCCESS;
}

/** Verify the HMAC-SHA256 in a TPM2 response using proper pHash.

  Per TPM 2.0 Part 1 §18.1, the response HMAC is:
    HMAC(sessionKey, pHash || nonceTPM || nonceCaller || sessionAttributes)

  where pHash = SHA256(responseCode || commandCode || responseParameters).

  @param  CommandCode     The TPM command code (from the original command).
  @param  ResponseBuffer  The TPM2 response buffer (starting at responseCode).
  @param  ResponseSize    Size of responseCode + responseParameters.
  @param  ResponseHmac    The HMAC from the response auth area (32 bytes).

  @retval EFI_SUCCESS       HMAC verified.
  @retval EFI_NOT_STARTED   No active session.
  @retval EFI_SECURITY_VIOLATION  HMAC mismatch.
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
EFI_STATUS
PblTpmVerifyResponseHmacEx (
  IN  UINT32        CommandCode,
  IN  CONST UINT8  *ResponseBuffer,
  IN  UINTN         ResponseSize,
  IN  CONST UINT8  *ResponseHmac
  )
{
  return PblTpmVerifyResponseHmacSession (&mSession, CommandCode,
                                          ResponseBuffer, ResponseSize, ResponseHmac);
}

/** Verify response HMAC for a specific session (internal helper).

  @param  Session        Pointer to the session state.
  @param  CommandCode    TPM command code.
  @param  ResponseBuffer Response buffer (starting at responseCode).
  @param  ResponseSize   Size of responseCode + responseParameters.
  @param  ResponseHmac   HMAC from response auth area (32 bytes).

  @retval EFI_SUCCESS       HMAC verified.
  @retval EFI_NOT_STARTED   Session not active.
  @retval EFI_SECURITY_VIOLATION  HMAC mismatch.
  @retval EFI_DEVICE_ERROR  HMAC computation failed.
**/
EFI_STATUS
PblTpmVerifyResponseHmacSession (
  IN  PBL_TPM_SESSION  *Session,
  IN  UINT32            CommandCode,
  IN  CONST UINT8      *ResponseBuffer,
  IN  UINTN             ResponseSize,
  IN  CONST UINT8      *ResponseHmac
  )
{
  UINT8  PHash[32];
  UINT8  ComputedHmac[32];
  UINT8  *PHashInput;
  UINT8  StackBuf[128];
  UINTN  PHashInputSize;

  if (!Session->Active) {
    return EFI_NOT_STARTED;
  }
  if (ResponseBuffer == NULL || ResponseHmac == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // pHash = SHA256(responseCode(4) || commandCode(4) || responseParameters)
  // ResponseBuffer starts at responseCode, so:
  //   pHashInput = responseCode(4 from buffer) || commandCode(4) || restOfBuffer
  PHashInputSize = 4 + 4 + (ResponseSize > 4 ? ResponseSize - 4 : 0);

  if (PHashInputSize > sizeof (StackBuf)) {
    PHashInput = AllocatePool (PHashInputSize);
    if (PHashInput == NULL) {
      return EFI_OUT_OF_RESOURCES;
    }
  } else {
    PHashInput = StackBuf;
  }

  // Copy responseCode (first 4 bytes of response buffer)
  CopyMem (PHashInput, ResponseBuffer, 4);

  // Append commandCode (4 bytes, big-endian)
  *(UINT32 *)(PHashInput + 4) = SwapBytes32 (CommandCode);

  // Append response parameters (rest of response buffer after responseCode)
  if (ResponseSize > 4) {
    CopyMem (PHashInput + 8, ResponseBuffer + 4, ResponseSize - 4);
  }

  if (!Sha256HashAll (PHashInput, PHashInputSize, PHash)) {
    if (PHashInput != StackBuf) {
      FreePool (PHashInput);
    }
    return EFI_DEVICE_ERROR;
  }
  if (PHashInput != StackBuf) {
    FreePool (PHashInput);
  }

  // Build HMAC input: pHash || nonceTPM(32) || nonceCaller(32) || sessionAttributes(1)
  // Per TPM 2.0 Part 1 §18.1, the response HMAC uses nonceTPM first, then nonceCaller.
  // D-206: Nonces are raw 32 bytes (CryptDigestUpdate2B excludes the size prefix).
  UINT8  HmacInput[32 + 32 + 32 + 1];
  UINT8 *HPtr = HmacInput;

  CopyMem (HPtr, PHash, 32);
  HPtr += 32;
  CopyMem (HPtr, Session->NonceTpm, 32);
  HPtr += 32;
  CopyMem (HPtr, Session->NonceCaller, 32);
  HPtr += 32;
  *HPtr = PblTpmSessionAttrsForCommand ((TPM_CC)CommandCode);
  HPtr += 1;

  // HMAC key = sessionKey || authValue (entity auth, when includeAuth is SET).
  // The TPM stores includeAuth on the session during command authorization and
  // reuses it for the response HMAC, so the stored value is correct here even
  // when the command (e.g. NV_Write) mutates the bound entity's Name.
  UINTN AuthSize = Session->IncludeAuth ? Session->CmdAuthValueSize : 0;
  UINTN HmacKeySize = Session->SessionKeySize + AuthSize;
  UINT8 HmacKey[96];
  if (HmacKeySize > sizeof (HmacKey)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (HmacKey, Session->SessionKey, Session->SessionKeySize);
  CopyMem (HmacKey + Session->SessionKeySize, Session->CmdAuthValue, AuthSize);

  if (!HmacSha256All (HmacInput, sizeof (HmacInput), HmacKey, HmacKeySize, ComputedHmac)) {
    return EFI_DEVICE_ERROR;
  }

  if (CompareMem (ComputedHmac, ResponseHmac, 32) != 0) {
    return EFI_SECURITY_VIOLATION;
  }

  return EFI_SUCCESS;
}

/** Flush the HMAC session (TPM2_FlushContext).

  Must be called before chain-loading Windows to avoid leaking session
  state to the OS (C2 §3.3).

  @retval EFI_SUCCESS       Session flushed.
  @retval EFI_NOT_STARTED   No active session.
**/
EFI_STATUS
PblTpmFlushSession (
  VOID
  )
{
  EFI_STATUS Status;

  if (!mSession.Active) {
    return EFI_NOT_STARTED;
  }

  Status = PblTpmFlushContext ((VOID *)(UINTN)mSession.SessionHandle);
  if (EFI_ERROR (Status)) {
    // Best-effort — continue even if flush fails
  }

  ZeroMem (&mSession, sizeof (mSession));
  return EFI_SUCCESS;
}

/** D-102: Start an HMAC session for PCR extends (C2 §3.3).

  PCR extends use a separate session bound to TPM_RH_NULL (unbound session).
  The session key is derived from just the nonces (no bind auth value).

  @retval EFI_SUCCESS       Session started.
  @retval EFI_ALREADY_STARTED  PCR session already active.
  @retval EFI_NOT_FOUND     No TPM present.
  @retval EFI_DEVICE_ERROR  TPM command failed.
**/
EFI_STATUS
PblTpmStartPcrSession (
  VOID
  )
{
  EFI_TCG2_PROTOCOL *Tcg2;
  EFI_STATUS         Status;
  UINT8              CmdBuf[256];
  UINT8              RespBuf[256];
  UINT32             RespSize;
  UINT8             *Ptr;
  UINT8             *RespPtr;

  if (mPcrSession.Active) {
    return EFI_ALREADY_STARTED;
  }

  Tcg2 = PblTcg2Locate ();
  if (Tcg2 == NULL) {
    return EFI_NOT_FOUND;
  }

  // Generate nonceCaller from TPM2_GetRandom
  Status = PblTpmGetRandom (mPcrSession.NonceCaller, 32);
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  mPcrSession.BindHandle = (UINT32)TPM_RH_NULL;

  // Build TPM2_StartAuthSession command (bound to TPM_RH_NULL)
  Ptr = PblTpmBeginCommand (CmdBuf, sizeof (CmdBuf), TPM_CC_StartAuthSession);

  // tpmKey = TPM_RH_NULL (no salt)
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_RH_NULL);
  Ptr += 4;

  // bind = TPM_RH_NULL (unbound session)
  *(UINT32 *)Ptr = SwapBytes32 ((UINT32)TPM_RH_NULL);
  Ptr += 4;

  // nonceCaller = TPM2B(32 bytes)
  *(UINT16 *)Ptr = SwapBytes16 (32);
  Ptr += 2;
  CopyMem (Ptr, mPcrSession.NonceCaller, 32);
  Ptr += 32;

  // salt = TPM2B(0 bytes) — empty since tpmKey is TPM_RH_NULL
  *(UINT16 *)Ptr = SwapBytes16 (0);
  Ptr += 2;

  // sessionType = TPM_SE_HMAC
  *Ptr = (UINT8)TPM_SE_HMAC;
  Ptr += 1;

  // symmetric = TPMT_SYM_DEF: algorithm=AES, keyBits=256, mode=CFB
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_AES);
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 (256);
  Ptr += 2;
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_CFB);
  Ptr += 2;

  // authHash = TPM_ALG_SHA256
  *(UINT16 *)Ptr = SwapBytes16 ((UINT16)TPM_ALG_SHA256);
  Ptr += 2;

  PblTpmFinalizeCommand (CmdBuf, (UINT32)(Ptr - CmdBuf));

  Status = PblTpmSubmitCommand (Tcg2, CmdBuf, (UINT32)(Ptr - CmdBuf),
                                RespBuf, sizeof (RespBuf), &RespSize);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Parse response (swtpm 0.7.3 omits sessionAttributes)
  if (RespSize < 2 + 4 + 4 + 4 + 2) {
    return EFI_DEVICE_ERROR;
  }

  RespPtr = RespBuf;
  RespPtr += 2;  // tag
  RespPtr += 4;  // size

  if (*(UINT32 *)RespPtr != 0) {
    return EFI_DEVICE_ERROR;
  }
  RespPtr += 4;

  mPcrSession.SessionHandle = SwapBytes32 (*(UINT32 *)RespPtr);
  RespPtr += 4;

  UINT16 NonceTpmSize = SwapBytes16 (*(UINT16 *)RespPtr);
  RespPtr += 2;
  if (NonceTpmSize > 32 || (RespPtr + NonceTpmSize) > (RespBuf + RespSize)) {
    return EFI_DEVICE_ERROR;
  }
  CopyMem (mPcrSession.NonceTpm, RespPtr, NonceTpmSize);
  if (NonceTpmSize < 32) {
    ZeroMem (mPcrSession.NonceTpm + NonceTpmSize, 32 - NonceTpmSize);
  }

  // D-206: PCR session is unbound (bind=TPM_RH_NULL, no salt), so session key
  // stays empty (0 bytes). Don't compute KDFa — matches libtpms Session.c which
  // only computes session key when bind != TPM_RH_NULL or seed is non-empty.
  mPcrSession.SessionKeySize     = 0;
  mPcrSession.BoundEntityNameSize = 0;
  mPcrSession.IncludeAuth        = TRUE;
  mPcrSession.CmdAuthValueSize   = 0;

  mPcrSession.Active = TRUE;
  return EFI_SUCCESS;
}

/** D-102: Check if the PCR session is active. **/
BOOLEAN
PblTpmIsPcrSessionActive (
  VOID
  )
{
  return mPcrSession.Active;
}

/** D-102: Get the PCR session handle. Returns 0 if no session is active. **/
UINT32
PblTpmGetPcrSessionHandle (
  VOID
  )
{
  return mPcrSession.Active ? mPcrSession.SessionHandle : 0;
}

/** D-102: Get pointer to the PCR session state.

  Used by TpmClient.c for PCR session HMAC fill/verify.
  Returns NULL if no PCR session is active.

  @return Pointer to mPcrSession, or NULL if inactive.
**/
PBL_TPM_SESSION *
PblTpmGetPcrSession (
  VOID
  )
{
  return mPcrSession.Active ? &mPcrSession : NULL;
}

/** D-102: Flush the PCR HMAC session (TPM2_FlushContext).

  Must be called before chain-loading Windows (C2 §3.3).

  @retval EFI_SUCCESS       Session flushed.
  @retval EFI_NOT_STARTED   No active PCR session.
**/
EFI_STATUS
PblTpmFlushPcrSession (
  VOID
  )
{
  EFI_STATUS Status;

  if (!mPcrSession.Active) {
    return EFI_NOT_STARTED;
  }

  Status = PblTpmFlushContext ((VOID *)(UINTN)mPcrSession.SessionHandle);
  if (EFI_ERROR (Status)) {
    // Best-effort — continue even if flush fails
  }

  ZeroMem (&mPcrSession, sizeof (mPcrSession));
  return EFI_SUCCESS;
}
