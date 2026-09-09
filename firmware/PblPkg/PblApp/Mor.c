/** @file
  Mor.c — REQ-07: Memory Overwrite Request (MOR) control.

  Sets the MOR bit in the ACPI Memory Overwrite Request Control UEFI variable
  to request that firmware clears memory on the next boot. This is a security
  measure to prevent cold-boot attacks from recovering sensitive data.

  The MOR variable is at EFI_GLOBAL_VARIABLE GUID, name "MemoryOverwriteRequestControl".
  Bit 0 (MOR bit) = 1 means firmware should clear memory on next boot.
  Bit 1 (MOR lock) = 1 means the MOR bit is locked and cannot be cleared by the OS.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// EFI_GLOBAL_VARIABLE GUID
STATIC EFI_GUID mGlobalVariableGuid = EFI_GLOBAL_VARIABLE;

// MOR control variable name
#define MOR_VARIABLE_NAME  L"MemoryOverwriteRequestControl"

// MOR bit definitions
#define MOR_BIT_CLEAR       0x01  // Bit 0: Set to request memory clear on next boot
#define MOR_BIT_LOCK        0x02  // Bit 1: Lock the MOR bit

/** REQ-07: Set the Memory Overwrite Request (MOR) bit.

  Sets bit 0 of the MemoryOverwriteRequestControl UEFI variable to request
  that firmware clears volatile memory on the next boot. This should be
  called when PBL decides to block boot or when a security violation is
  detected.

  @retval EFI_SUCCESS           MOR bit set.
  @retval EFI_DEVICE_ERROR      Failed to set MOR variable.
**/
EFI_STATUS
PblRequestMor (
  VOID
  )
{
  UINT8       MorControl;
  UINTN       Size;
  EFI_STATUS  Status;

  // Read current MOR value
  MorControl = 0;
  Size = sizeof (MorControl);
  Status = gRT->GetVariable (
    MOR_VARIABLE_NAME,
    &mGlobalVariableGuid,
    NULL,
    &Size,
    &MorControl
    );

  // If the variable doesn't exist, start with 0
  if (EFI_ERROR (Status)) {
    MorControl = 0;
  }

  // Set the MOR clear bit
  MorControl |= MOR_BIT_CLEAR;

  // Write it back
  Status = gRT->SetVariable (
    MOR_VARIABLE_NAME,
    &mGlobalVariableGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof (MorControl),
    &MorControl
    );

  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  return EFI_SUCCESS;
}
