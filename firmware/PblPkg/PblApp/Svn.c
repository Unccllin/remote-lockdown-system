/** @file
  Svn.c — REQ-02: Security Version Number (SVN) check.

  Reads the boot manager Security Version Number from the UEFI variable
  "PblBootmgrSvn" (if set by firmware) or from the boot manager executable's
  Authenticode signature. The SVN is used to detect firmware rollback attacks.

  On Windows systems, the boot manager SVN is typically embedded in the
  bootmgfw.efi Authenticode signature and can also be read from the
  UEFI variable set by the firmware.

  NG-T4 / B-004: the PblBootmgrSvn variable is written WITHOUT authentication
  — any OS process or UEFI shell can plant it. The value is therefore
  treated as ADVISORY-ONLY (untrusted telemetry); callers receive a Trusted
  flag reflecting whether the variable carried TIME_BASED_AUTHENTICATED
  attributes. The real fix — parse the SVN from bootmgfw.efi's
  Authenticode certificate table — is a separate capability.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// EFI_GLOBAL_VARIABLE GUID
STATIC EFI_GUID mGlobalVariableGuid = EFI_GLOBAL_VARIABLE;

// Bootmgr SVN variable name (custom PBL variable — UNAUTHENTICATED,
// advisory-only; an attacker with variable access can plant it)
#define BOOTMGR_SVN_VARIABLE  L"PblBootmgrSvn"

/** REQ-02: Read the boot manager Security Version Number.

  Reads the "PblBootmgrSvn" UEFI variable (if set by firmware or a prior
  PBL run). If the variable doesn't exist, returns SVN=0 (unknown).

  NG-T4: also reports whether the variable is trustworthy — i.e., was
  written with EFI_VARIABLE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS. PBL's
  own writes are plain SetVariable (B-003), so Trusted will be FALSE for
  our own variable as well; the value must be treated as advisory-only.

  @param[out] Svn      The boot manager SVN.
  @param[out] Trusted  TRUE if the variable was authenticated; FALSE if
                       unauthenticated (advisory) or absent.

  @retval EFI_SUCCESS       SVN read (or default 0 if not set).
**/
EFI_STATUS
PblReadBootmgrSvn (
  OUT UINT32   *Svn,
  OUT BOOLEAN  *Trusted
  )
{
  UINTN       Size;
  UINT32      Attributes;
  EFI_STATUS  Status;

  *Svn = 0;
  if (Trusted != NULL) {
    *Trusted = FALSE;
  }

  Size = sizeof (UINT32);
  Status = gRT->GetVariable (
    BOOTMGR_SVN_VARIABLE,
    &mGlobalVariableGuid,
    &Attributes,
    &Size,
    Svn
    );

  // If the variable doesn't exist, SVN=0 (unknown — policy may treat as DEGRADED)
  if (EFI_ERROR (Status)) {
    *Svn = 0;
    return EFI_SUCCESS;
  }

  // Trusted only if the writer authenticated the variable (TBA). PBL's
  // own writes are unauthenticated, so this is advisory telemetry —
  // never a decision-grade trust input.
  if (Trusted != NULL) {
    *Trusted = ((Attributes & EFI_VARIABLE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS) != 0);
  }

  return EFI_SUCCESS;
}
