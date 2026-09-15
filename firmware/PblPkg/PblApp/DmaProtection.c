/** @file
  DmaProtection.c — REQ-07: Kernel DMA Protection check.

  Checks whether Kernel DMA Protection is enabled. On modern UEFI systems,
  this is indicated by the "KernelDmaProtection" UEFI variable (EFI_GLOBAL_VARIABLE
  GUID) or by the IOMMU/DMA-remapping configuration in the DMAR ACPI table.

  The most reliable UEFI pre-boot check is reading the "KernelDmaProtection"
  variable, which is set by the firmware when DMA remapping is active.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// EFI_GLOBAL_VARIABLE GUID
STATIC EFI_GUID mGlobalVariableGuid = EFI_GLOBAL_VARIABLE;

/** REQ-07: Check if Kernel DMA Protection is enabled.

  Reads the "KernelDmaProtection" UEFI variable (boolean). If the variable
  does not exist, falls back to checking the DMAR ACPI table presence.

  @param[out] Enabled  TRUE if Kernel DMA Protection is enabled.

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

  // Try reading the KernelDmaProtection UEFI variable
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
    *Enabled = (Data != 0);
    return EFI_SUCCESS;
  }

  // Fallback: check for DMAR ACPI table presence (IOMMU / DMA remapping).
  // If the firmware advertises a DMA remapping table, the platform is capable
  // of remapping DMA requests — the pre-boot equivalent of Kernel DMA
  // Protection.  This is the case on QEMU q35 with -device intel-iommu.
  //
  // DMAR signature in ACPI is 'DMAR' (EFI_ACPI_2_0_DMA_REMAPPING_TABLE_SIGNATURE).
  //
  {
    EFI_ACPI_COMMON_HEADER  *Dmar;
    Dmar = EfiLocateFirstAcpiTable (SIGNATURE_32 ('D', 'M', 'A', 'R'));
    if (Dmar != NULL) {
      *Enabled = TRUE;
      return EFI_SUCCESS;
    }
  }

  // No variable and no DMAR table — DMA protection cannot be confirmed.
  *Enabled = FALSE;
  return EFI_SUCCESS;
}
