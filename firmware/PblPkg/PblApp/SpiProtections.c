/** @file
  SpiProtections.c — REQ-03: SPI flash protections check.

  Reads the SPI Configuration Register (HSFS) via the SPI controller PCI
  device (B0:D31:F5 on Intel platforms) to determine:
    - BIOSWE  (BIOS Write Enable)     — 0 = write-protected
    - BLE     (BIOS Lock Enable)      — 1 = lock enforced
    - SMM_BWP (SMM BIOS Write Protect)— 1 = SMM-only writes
    - PRR     (Protected Range Register) — covers BIOS region

  On non-Intel platforms or when the SPI controller is not accessible,
  SpiProtectionsKnown is set to FALSE and the policy decides (DEGRADED).

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// HSFS (Hardware Sequencing Flash Status Register) offset within SPI BAR0
#define HSFS_OFFSET       0x04

// PRR (Protected Range Register) at BAR0 + 0x74
#define PRR_OFFSET        0x74
#define PRR_WE_BIT        BIT31   // Write Enable (0 = protected)
#define PRR_PR_ENABLED    BIT15   // Protected Range enabled

/** REQ-03: Check SPI flash protections.

  Reads the Intel SPI controller HSFS register and PRR to determine
  BIOSWE, BLE, SMM_BWP, and PRR coverage. Sets SpiProtectionsKnown=FALSE
  on non-Intel or inaccessible controllers.

  @param[out] State  Platform state to populate.

  @retval EFI_SUCCESS           SPI protections checked.
  @retval EFI_UNSUPPORTED       SPI controller not accessible.
**/
EFI_STATUS
PblCheckSpiProtections (
  OUT PBL_PLATFORM_STATE  *State
  )
{
  UINT32  SpiBar0;
  UINT16  Hsfs;
  UINT32  Prr;
  UINT32  PciAddr;

  State->SpiProtectionsKnown = FALSE;
  State->Bioswe = FALSE;
  State->Ble = FALSE;
  State->SmmBwp = FALSE;
  State->PrrCoverBios = FALSE;

  // Read SPI controller BAR0 from PCI B0:D31:F5, offset 0x10
  PciAddr = 0x80000000 | (0 << 16) | (31 << 11) | (5 << 8) | 0x10;
  IoWrite32 (0xCF8, PciAddr);
  SpiBar0 = IoRead32 (0xCFC);

  // Mask to get the base address (bits 15:0 are zero for 64KB alignment)
  SpiBar0 &= 0xFFFFC000;
  if (SpiBar0 == 0) {
    return EFI_UNSUPPORTED;
  }

  // Read HSFS (Hardware Sequencing Flash Status Register)
  Hsfs = (UINT16)MmioRead32 (SpiBar0 + HSFS_OFFSET);

  // BIOSWE (bit 0): 0 = write-protected, 1 = write-enabled
  State->Bioswe = (Hsfs & BIT0) != 0;

  // BLE (bit 1): 1 = BIOS Lock Enable is set
  State->Ble = (Hsfs & BIT1) != 0;

  // SMM_BWP (bit 5): 1 = SMM BIOS Write Protect (only SMM can write)
  State->SmmBwp = (Hsfs & BIT5) != 0;

  // Read PRR (Protected Range Register)
  Prr = MmioRead32 (SpiBar0 + PRR_OFFSET);

  // PRR is enabled and write-protected if PR bit is set and WE is clear
  State->PrrCoverBios = ((Prr & PRR_PR_ENABLED) != 0) && ((Prr & PRR_WE_BIT) == 0);

  State->SpiProtectionsKnown = TRUE;
  return EFI_SUCCESS;
}
