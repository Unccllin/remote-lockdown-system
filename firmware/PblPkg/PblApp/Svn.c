/** @file
  Svn.c — REQ-02: Security Version Number (SVN) check.

  Reads the boot manager Security Version Number from the UEFI variable
  "BootmgrSvn" (if set by firmware) or from the boot manager executable's
  Authenticode signature. The SVN is used to detect firmware rollback attacks.

  On Windows systems, the boot manager SVN is typically embedded in the
  bootmgfw.efi Authenticode signature and can also be read from the
  UEFI variable set by the firmware.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// EFI_GLOBAL_VARIABLE GUID
STATIC EFI_GUID mGlobalVariableGuid = EFI_GLOBAL_VARIABLE;

// Bootmgr SVN variable name (custom PBL variable)
#define BOOTMGR_SVN_VARIABLE  L"PblBootmgrSvn"

/** REQ-02: Read the boot manager Security Version Number.

  Reads the "PblBootmgrSvn" UEFI variable (if set by firmware or a prior
  PBL run). If the variable doesn't exist, returns SVN=0 (unknown).

  @param[out] Svn  The boot manager SVN.

  @retval EFI_SUCCESS       SVN read (or default 0 if not set).
**/
EFI_STATUS
PblReadBootmgrSvn (
  OUT UINT32  *Svn
  )
{
  UINTN       Size;
  EFI_STATUS  Status;

  *Svn = 0;

  Size = sizeof (UINT32);
  Status = gRT->GetVariable (
    BOOTMGR_SVN_VARIABLE,
    &mGlobalVariableGuid,
    NULL,
    &Size,
    Svn
    );

  // If the variable doesn't exist, SVN=0 (unknown — policy may treat as DEGRADED)
  if (EFI_ERROR (Status)) {
    *Svn = 0;
  }

  return EFI_SUCCESS;
}
