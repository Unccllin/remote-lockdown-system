/** @file
  DmaProtection.c — REQ-07: Kernel DMA Protection check.

  Checks whether Kernel DMA Protection is enabled. The authoritative
  pre-boot signal is the firmware's ACPI tables: DMAR (Intel VT-d) or
  IVRS (AMD-Vi) — both are firmware-authored and advertise that the
  platform remaps DMA.

  The "KernelDmaProtection" UEFI variable (EFI_GLOBAL_VARIABLE GUID) is
  unauthenticated — any OS process or UEFI shell can plant it to
  spoof-to-pass the Decision.c BLOCK gate (B-004 class). It is read for
  advisory telemetry only and never drives the result.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// EFI_GLOBAL_VARIABLE GUID
STATIC EFI_GUID mGlobalVariableGuid = EFI_GLOBAL_VARIABLE;

/** REQ-07: Check if Kernel DMA Protection is enabled.

  Authoritative check: DMAR (Intel VT-d) / IVRS (AMD-Vi) ACPI tables —
  firmware-authored evidence that the platform remaps DMA. The
  KernelDmaProtection variable is then read for advisory telemetry; it
  is unauthenticated and can be planted (spoof-to-pass), so it never
  elevates the result.

  @param[out] Enabled  TRUE if firmware advertises DMA remapping.

  @retval EFI_SUCCESS   DMA protection status checked.
**/
EFI_STATUS
PblCheckDmaProtection (
  OUT BOOLEAN  *Enabled
  )
{
  UINT8       Data;
  UINTN       Size;
  EFI_STATUS  Status;

  *Enabled = FALSE;

  // Firmware-authored ACPI tables are the authoritative signal:
  // DMAR = Intel VT-d remapping, IVRS = AMD-Vi remapping.
  if (EfiLocateFirstAcpiTable (SIGNATURE_32 ('D', 'M', 'A', 'R')) != NULL ||
      EfiLocateFirstAcpiTable (SIGNATURE_32 ('I', 'V', 'R', 'S')) != NULL) {
    *Enabled = TRUE;
  }

  // Advisory only: report what the variable claims, never trust it.
  Data = 0;
  Size = sizeof (Data);
  Status = gRT->GetVariable (
    L"KernelDmaProtection",
    &mGlobalVariableGuid,
    NULL,
    &Size,
    &Data
    );
  if (!EFI_ERROR (Status)) {
    Print (L"  [INFO] KernelDmaProtection variable claims %u (advisory, unauthenticated)\n", Data);
  }

  return EFI_SUCCESS;
}
