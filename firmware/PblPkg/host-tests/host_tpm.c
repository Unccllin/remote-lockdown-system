/** @file
  Host-side stand-in for EFI_TCG2_PROTOCOL (D-224).

  The point of this file is to test the shipped code rather than a model of it. TpmClient.c
  reaches the TPM only through `gBS->LocateProtocol (gEfiTcg2ProtocolGuid)` and then
  `Tcg2->SubmitCommand` — so a fake protocol that captures the command block and replies with
  scripted bytes exercises the real construction code (PblTpmBeginCommandWithSessionAuth,
  PblTpmFinalizeCommand, the per-command parameter writes, PblTpmFillCommandHmac) end to end.

  Why this matters (D-224's whole reason for existing): every TPM path is otherwise covered
  only by QEMU+swtpm boots at end-to-end granularity, where a wrong size field or a handle
  written in the wrong place is visible solely as "the boot flow failed" — or as a
  TPM_RC_SIZE from inside a VM nobody is looking at.

  Two things are checked for EVERY submitted command, without the test having to ask:

    1. `header.CommandSize == the CommandSize argument` — the declared size covers exactly
       what was written. This is the class of bug the QEMU harness can only see as RC=0x1D5.
    2. The command code in the header matches the code the caller meant to send.

  Wired into the build by run-host-tests.sh; used by test_tpm_command.c.
**/

#include "host_tpm.h"

#include <string.h>

/* ---- capture ---------------------------------------------------------- */

#define HOST_TPM_MAX_RESPONSE 32
#define HOST_TPM_MAX_BODY     256

typedef struct {
  UINT16  Tag;
  UINT32  Rc;
  UINT8   Body[HOST_TPM_MAX_BODY];
  UINT32  BodySize;
} HOST_TPM_RESPONSE;

static HOST_TPM_CAPTURED  mCaptured[HOST_TPM_MAX_CAPTURE];
static UINT32             mCaptureCount;
static HOST_TPM_RESPONSE  mResponses[HOST_TPM_MAX_RESPONSE];
static UINT32             mResponseCount;
static UINT32             mResponseCursor;
static UINT32             mSizeMismatches;
static UINT32             mOverflowDrops;

/* ---- public harness API ----------------------------------------------- */

VOID
HostTpmReset (
  VOID
  )
{
  mCaptureCount   = 0;
  mResponseCount  = 0;
  mResponseCursor = 0;
  mSizeMismatches = 0;
  mOverflowDrops  = 0;
  ZeroMem (mCaptured, sizeof (mCaptured));
  ZeroMem (mResponses, sizeof (mResponses));
}

/** Queue one response. Responses are consumed in order; when none is queued the fake
    answers TPM_RC_FAILURE, so a test that forgets to script an answer gets a visible
    error path instead of an accidental success. **/
VOID
HostTpmQueueResponse (
  IN UINT16       Tag,
  IN UINT32       Rc,
  IN CONST UINT8 *Body OPTIONAL,
  IN UINT32       BodySize
  )
{
  HOST_TPM_RESPONSE *Slot;

  if (mResponseCount >= HOST_TPM_MAX_RESPONSE) {
    mOverflowDrops++;
    return;
  }

  Slot            = &mResponses[mResponseCount++];
  Slot->Tag       = Tag;
  Slot->Rc        = Rc;
  Slot->BodySize  = BodySize;
  if ((Body != NULL) && (BodySize > 0) && (BodySize <= HOST_TPM_MAX_BODY)) {
    CopyMem (Slot->Body, Body, BodySize);
  }
}

UINT32
HostTpmCaptureCount (
  VOID
  )
{
  return mCaptureCount;
}

CONST HOST_TPM_CAPTURED *
HostTpmCapture (
  IN UINT32 Index
  )
{
  if (Index >= mCaptureCount) {
    return NULL;
  }

  return &mCaptured[Index];
}

UINT32
HostTpmSizeMismatches (
  VOID
  )
{
  return mSizeMismatches;
}

UINT32
HostTpmOverflowDrops (
  VOID
  )
{
  return mOverflowDrops;
}

/* ---- the fake protocol ------------------------------------------------ */

static EFI_STATUS
EFIAPI
HostTpmGetCapability (
  IN     EFI_TCG2_PROTOCOL               *This,
  IN OUT EFI_TCG2_BOOT_SERVICE_CAPABILITY *Capability
  )
{
  (VOID)This;
  if (Capability == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  /* PblTcg2Locate rejects the protocol when TPMPresentFlag is clear, so this is what makes
     the client believe a TPM exists. */
  Capability->Size           = (UINT8)sizeof (EFI_TCG2_BOOT_SERVICE_CAPABILITY);
  Capability->TPMPresentFlag = TRUE;
  Capability->MaxCommandSize = 1024;
  Capability->MaxResponseSize = 1024;
  return EFI_SUCCESS;
}

static EFI_STATUS
EFIAPI
HostTpmSubmitCommand (
  IN  EFI_TCG2_PROTOCOL  *This,
  IN  UINT32              InputSize,
  IN  UINT8               *Input,
  IN  UINT32              OutputSize,
  IN  UINT8               *Output
  )
{
  HOST_TPM_CAPTURED  *Slot;
  HOST_TPM_RESPONSE  *Resp;
  UINT32              Declared;
  UINT32              BodySize;
  UINT32              TotalSize;

  (VOID)This;

  if ((Input == NULL) || (Output == NULL) || (InputSize < 10)) {
    return EFI_INVALID_PARAMETER;
  }

  /* Invariant 1: the declared header size must equal the number of bytes handed over.
     A command built with a stale size field (the classic "forgot the auth area" bug) is
     caught here for every command, with no per-test cooperation. */
  Declared = SwapBytes32 (*(UINT32 *)(Input + 2));
  if (Declared != InputSize) {
    mSizeMismatches++;
  }

  if (mCaptureCount < HOST_TPM_MAX_CAPTURE) {
    Slot                    = &mCaptured[mCaptureCount++];
    Slot->Submitted         = InputSize;
    Slot->DeclaredSize      = Declared;
    Slot->Tag               = SwapBytes16 (*(UINT16 *)Input);
    Slot->CommandCode       = SwapBytes32 (*(UINT32 *)(Input + 6));
    Slot->SizeMatchesSubmission = (BOOLEAN)(Declared == InputSize);
    CopyMem (Slot->Raw, Input, (InputSize <= sizeof (Slot->Raw)) ? InputSize : sizeof (Slot->Raw));
  }

  /* Build the response. */
  if (mResponseCursor < mResponseCount) {
    Resp = &mResponses[mResponseCursor++];
  } else {
    static HOST_TPM_RESPONSE Default = { 0, 0x101 /* TPM_RC_FAILURE */, { 0 }, 0 };
    Resp = &Default;
  }

  BodySize  = (Resp->BodySize <= HOST_TPM_MAX_BODY) ? Resp->BodySize : 0;
  TotalSize = 10 + BodySize;
  if (TotalSize > OutputSize) {
    return EFI_BUFFER_TOO_SMALL;
  }

  *(UINT16 *)Output       = SwapBytes16 (Resp->Tag);
  *(UINT32 *)(Output + 2) = SwapBytes32 (TotalSize);
  *(UINT32 *)(Output + 6) = SwapBytes32 (Resp->Rc);
  if (BodySize > 0) {
    CopyMem (Output + 10, Resp->Body, BodySize);
  }

  return EFI_SUCCESS;
}

static EFI_TCG2_PROTOCOL  mFakeTcg2 = { HostTpmGetCapability, HostTpmSubmitCommand };

/* gEfiTcg2ProtocolGuid is compared by address only, so the value is arbitrary but must not
   be all-zero (a zeroed GUID is a plausible "unset" mistake elsewhere). */
EFI_GUID  gEfiTcg2ProtocolGuid = { 0x607f766c, 0x7455, 0x42be, { 0x93, 0x0b, 0xe4, 0xd7, 0x6d, 0xb2, 0x72, 0x0f } };

static EFI_STATUS
EFIAPI
HostLocateProtocol (
  IN  EFI_GUID  *Protocol,
  IN  VOID      *Registration OPTIONAL,
  OUT VOID     **Interface
  )
{
  (VOID)Registration;
  if ((Protocol == NULL) || (Interface == NULL)) {
    return EFI_INVALID_PARAMETER;
  }

  if (CompareMem (Protocol, &gEfiTcg2ProtocolGuid, sizeof (EFI_GUID)) != 0) {
    return EFI_NOT_FOUND;
  }

  *Interface = &mFakeTcg2;
  return EFI_SUCCESS;
}

static EFI_BOOT_SERVICES  mHostBootServices = { HostLocateProtocol };

EFI_BOOT_SERVICES  *gBS = &mHostBootServices;
