/** @file
  Sbat.c — SBAT variable check.

  SBAT (Secure Boot Advanced Targeting) is a mechanism used by GRUB and
  shim to revoke vulnerable bootloaders via a UEFI variable. The SBAT
  variable is a text file stored as a UEFI variable with the Shim/GUID.

  PBL reads the SBAT variable to verify it exists and has a non-zero
  version, indicating that SBAT-based revocation is active.

  ADVISORY ONLY (B-004 class): the Sbat variable is unauthenticated —
  any OS process or UEFI shell can plant or erase it. This reader has
  no decision consumer; any future caller must treat the value as
  untrusted telemetry, never as a gate.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// SBAT variable GUID (same as Shim's GUID)
// {0x55c5d1f8, 0x04af, 0x491d, {0xb0, 0x3c, 0x29, 0x72, 0x88, 0x88, 0x11, 0x60}}
STATIC EFI_GUID mSbatGuid = {
  0x55c5d1f8, 0x04af, 0x491d,
  { 0xb0, 0x3c, 0x29, 0x72, 0x88, 0x88, 0x11, 0x60 }
};

#define SBAT_VARIABLE_NAME  L"Sbat"
#define SBAT_MIN_SIZE       10  // Minimum meaningful SBAT data size

/** Read the SBAT variable version.

  Reads the "Sbat" UEFI variable and extracts the version number.
  The SBAT variable is a text file with lines like:
    sbat,1
    grub,2
  The first field is the component name, the second is the version.
  We extract the overall SBAT version (first line, second field).

  @param[out] SbatVersion  The SBAT version (0 if not found).

  @retval EFI_SUCCESS       SBAT version read (or 0 if not set).
**/
EFI_STATUS
PblGetSbatVersion (
  OUT UINT32  *SbatVersion
  )
{
  UINT8       *Buf;
  UINTN       Size;
  EFI_STATUS  Status;
  UINTN       Index;

  *SbatVersion = 0;

  // Query size first
  Size = 0;
  Status = gRT->GetVariable (
    SBAT_VARIABLE_NAME,
    &mSbatGuid,
    NULL,
    &Size,
    NULL
    );

  if (Status != EFI_BUFFER_TOO_SMALL || Size < SBAT_MIN_SIZE) {
    // SBAT variable not present or too small — SBAT revocation not active
    return EFI_SUCCESS;
  }

  // Allocate buffer
  Buf = AllocatePool (Size);
  if (Buf == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  // Read the variable
  Status = gRT->GetVariable (
    SBAT_VARIABLE_NAME,
    &mSbatGuid,
    NULL,
    &Size,
    Buf
    );

  if (EFI_ERROR (Status)) {
    FreePool (Buf);
    return EFI_SUCCESS;
  }

  // Parse the first line to extract the version
  // Format: "sbat,N\n..."
  // Find the comma after "sbat"
  for (Index = 0; Index < Size - 1; Index++) {
    if (Buf[Index] == ',') {
      // Parse the number after the comma
      UINT32 Version = 0;
      Index++;
      while (Index < Size && Buf[Index] >= '0' && Buf[Index] <= '9') {
        Version = Version * 10 + (Buf[Index] - '0');
        Index++;
      }
      *SbatVersion = Version;
      break;
    }
    if (Buf[Index] == '\n' || Buf[Index] == '\r') {
      // First line ended without a comma — malformed SBAT
      break;
    }
  }

  FreePool (Buf);
  return EFI_SUCCESS;
}
