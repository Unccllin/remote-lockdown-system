/*
 * tpm.c — TPM 2.0 availability check
 *
 * Checks whether a TPM 2.0 device is present via the TCG2 protocol.
 * If available, the agent can use it for:
 * - Sealing the device key to PCR values (tamper detection)
 * - Unsealing the key on boot to decrypt sensitive data
 * - Extending PCRs to record agent state changes
 *
 * This is a lightweight check — full TPM seal/unseal from UEFI would
 * use the Tcg2Protocol's SubmitCommand to send TPM commands directly.
 */

#include "AntiTheftAgent.h"
#include <Library/UefiBootServicesTableLib.h>
#include <Protocol/Tcg2Protocol.h>

EFI_STATUS
CheckTpmAvailable (
  OUT BOOLEAN  *Available
  )
{
  EFI_STATUS                    Status;
  EFI_TCG2_PROTOCOL             *Tcg2Protocol;
  EFI_TCG2_BOOT_SERVICE_CAPABILITY Capability;

  if (Available == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *Available = FALSE;

  //
  // Try to locate the TCG2 protocol (TPM 2.0)
  //
  Status = gBS->LocateProtocol(
    &gEfiTcg2ProtocolGuid,
    NULL,
    (VOID **)&Tcg2Protocol
  );

  if (EFI_ERROR(Status)) {
    return EFI_NOT_FOUND;
  }

  //
  // Query TPM capabilities
  //
  ZeroMem(&Capability, sizeof(Capability));
  Capability.Size = sizeof(EFI_TCG2_BOOT_SERVICE_CAPABILITY);

  Status = Tcg2Protocol->GetCapability(Tcg2Protocol, &Capability);
  if (EFI_ERROR(Status)) {
    return Status;
  }

  if (Capability.TPMPresentFlag) {
    *Available = TRUE;
  }

  return EFI_SUCCESS;
}
