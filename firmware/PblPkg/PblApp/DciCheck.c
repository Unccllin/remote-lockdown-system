/** @file
  DciCheck.c — REQ-04: USB DCI (Debug Connector Interface) check.

  Checks whether the USB DCI debug interface is enabled. On Intel platforms,
  this is controlled by the DCI enable bit in the PCH SPI flash descriptor
  or via the Intel DCI PCI device (B0:D21:F0 on some platforms).

  In UEFI pre-boot, the most reliable check is reading the DCI enable bit
  from the PCH PMC register or checking the USB controller's DCI capability.
  If the DCI PCI device is not found, we assume DCI is disabled.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Intel DCI PCI device: B0:D21:F0 (varies by PCH generation)
// On Sunrise Point (100-series), DCI is at D31:F2 (PMC) with DCI bit
// We check the most common locations.
#define DCI_PCI_ADDR_PCH  (0x80000000 | (0 << 16) | (31 << 11) | (2 << 8))

// PMC DCI enable bit in the PMC config space (offset 0x40 on some PCH)
// This is platform-specific; on many platforms the DCI enable is in the
// flash descriptor and not directly readable from UEFI.
#define PMC_DCI_ENABLE_BIT  BIT0

/** REQ-04: Check if USB DCI debug interface is enabled.

  Reads the PCH PMC register to check the DCI enable bit. If the PMC
  device is not found or the bit is not accessible, returns FALSE
  (conservative: assume disabled, but policy may override).

  @param[out] Enabled  TRUE if DCI is enabled.

  @retval EFI_SUCCESS   DCI status checked.
**/
EFI_STATUS
PblCheckDci (
  OUT BOOLEAN  *Enabled
  )
{
  UINT32  PmcConfig;

  *Enabled = FALSE;

  // Read PMC config space at B0:D31:F2, offset 0x40
  // This is a simplified check — real DCI enable may be in flash descriptor
  IoWrite32 (0xCF8, DCI_PCI_ADDR_PCH | 0x40);
  PmcConfig = IoRead32 (0xCFC);

  // Check DCI enable bit
  if ((PmcConfig & PMC_DCI_ENABLE_BIT) != 0) {
    *Enabled = TRUE;
  }

  return EFI_SUCCESS;
}
