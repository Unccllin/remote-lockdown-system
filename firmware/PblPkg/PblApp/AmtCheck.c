/** @file
  AmtCheck.c — REQ-04: Intel AMT (Active Management Technology) check.

  Checks whether Intel AMT is provisioned. AMT is a hardware-level remote
  management feature that can be a security risk if provisioned on a
  stolen device.

  In UEFI pre-boot, AMT provisioning state can be checked via:
  1. The ME (Management Engine) PCI device (B0:D22:F0) status register
  2. The AMT HECI (Host Embedded Controller Interface) PCI device
  3. An SMBIOS Type 38 (Management Device) entry

  This implementation checks for the HECI PCI device presence, which
  indicates ME is present. Provisioning state requires HECI protocol
  communication which is complex for pre-boot.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Intel ME HECI PCI device: B0:D22:F0
#define HECI_PCI_ADDR  (0x80000000 | (0 << 16) | (22 << 11) | (0 << 8))

// PCI vendor ID offset
#define PCI_VENDOR_ID_OFFSET  0x00

// Intel vendor ID
#define INTEL_VENDOR_ID  0x8086

/** REQ-04: Check if Intel AMT is provisioned.

  Checks for the presence of the Intel ME HECI PCI device. If the device
  is present, AMT may be provisioned (we can't definitively determine
  provisioning state without HECI protocol communication).

  @param[out] Provisioned  TRUE if AMT appears to be provisioned.

  @retval EFI_SUCCESS    AMT status checked.
**/
EFI_STATUS
PblCheckAmt (
  OUT BOOLEAN  *Provisioned
  )
{
  UINT16  VendorId;

  *Provisioned = FALSE;

  // Check for HECI PCI device at B0:D22:F0
  IoWrite32 (0xCF8, HECI_PCI_ADDR | PCI_VENDOR_ID_OFFSET);
  VendorId = (UINT16)IoRead32 (0xCFC);

  if (VendorId != INTEL_VENDOR_ID) {
    // No Intel ME device at B0:D22:F0 — AMT not present
    return EFI_SUCCESS;
  }

  // Intel ME is present at B0:D22:F0 — AMT may be provisioned.
  // Without HECI protocol communication, we can't determine provisioning
  // state definitively. We set Provisioned=TRUE as a conservative default
  // (policy can override with an allowlist).
  *Provisioned = TRUE;

  return EFI_SUCCESS;
}
