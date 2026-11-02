/** @file
  EnrollKeys.c — Secure Boot key enrolment helper (test/provisioning only).

  Why this exists
  ---------------
  D-130 and D-133 both need a varstore whose db holds the real Windows UEFI CA
  2023 and our own signing certificate, and whose dbx holds the 2011 revocation.
  Nothing on the Linux side can produce that: `virt-fw-vars --set-dbx` requires an
  EFI_VARIABLE_AUTHENTICATION_2 blob (timestamp + PKCS#7 + ESL) rather than a bare
  ESL, and the authenticated-variable signatures cannot be produced without the
  platform's KEK private key. Unsigned writes are legal only while the platform is
  in Setup Mode, and that is exactly the window this application uses:
  SetVariable("db"/"dbx"/"kek") is permitted in Setup Mode, and enrolling PK is
  what leaves it.

  It is a provisioning tool, not part of the product's boot path. It reads raw
  EFI_SIGNATURE_LIST files from the ESP and writes them verbatim, so the caller
  decides the contents and nothing is synthesised here.

  Expected ESP layout (any volume):
    \EFI\PBL\dbx.esl    EFI_SIGNATURE_LIST for dbx
    \EFI\PBL\db.esl     EFI_SIGNATURE_LIST for db
    \EFI\PBL\kek.esl    EFI_SIGNATURE_LIST for KEK   (optional)
    \EFI\PBL\pk.esl     EFI_SIGNATURE_LIST for PK    (optional; enrolling it
                                                      leaves Setup Mode)

  Order matters: everything that needs Setup Mode is written first, PK last. Each
  write is reported, and a failed write is reported as a failure rather than
  ignored, because a half-enrolled platform is worse than an unenrolled one.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include <Uefi.h>
#include <Library/BaseLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/PrintLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Guid/ImageAuthentication.h>
#include <Guid/FileInfo.h>
#include <Protocol/SimpleFileSystem.h>

#define ENROLL_MAX_FILE  (64 * 1024)

/** EFI_VARIABLE_AUTHENTICATION_2 without a PKCS#7 signature.

  PK/KEK/db/dbx are time-based authenticated variables, so the variable driver
  demands BOTH the attribute flag and this header *even in Setup Mode* —
  `AuthService.c:ProcessVarWithPk()` returns EFI_INVALID_PARAMETER otherwise and
  then takes the payload from `Data + AUTHINFO2_SIZE(Data)`. Setup Mode skips the
  signature *verification* (OvmfPkg sets PcdRequireSelfSignedPk=FALSE), so a
  zero-length signature is accepted: the shape is required, the signature is not.
  This is the same construction OvmfPkg/EnrollDefaultKeys uses.

  dwLength is the header length below the timestamp, matching edk2's own
  (non-spec-literal) choice — see EnrollDefaultKeys.c, which documents it.
**/
#pragma pack (1)
typedef struct {
  EFI_TIME  TimeStamp;
  UINT32    dwLength;
  UINT16    wRevision;
  UINT16    wCertificateType;
  EFI_GUID  CertType;
} PBL_AUTH2_HEADER;
#pragma pack ()

/** Read a whole file from any SimpleFileSystem volume.

  @param[in]  Path      UEFI path, e.g. L"\\EFI\\PBL\\db.esl".
  @param[out] Buffer    Allocated buffer holding the file (caller frees).
  @param[out] Size      Bytes read.

  @retval EFI_NOT_FOUND        No volume contains the file.
  @retval EFI_BAD_BUFFER_SIZE  File is larger than ENROLL_MAX_FILE.
**/
STATIC
EFI_STATUS
ReadFileFromAnyVolume (
  IN  CONST CHAR16  *Path,
  OUT UINT8        **Buffer,
  OUT UINTN         *Size
  )
{
  EFI_STATUS                        Status;
  EFI_HANDLE                       *Handles = NULL;
  UINTN                             HandleCount = 0;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL  *Fs;
  EFI_FILE_PROTOCOL                *Root;
  EFI_FILE_PROTOCOL                *File;
  EFI_FILE_INFO                    *Info;
  UINTN                             InfoSize;
  UINT8                            *Data;

  *Buffer = NULL;
  *Size   = 0;

  Status = gBS->LocateHandleBuffer (
                  ByProtocol,
                  &gEfiSimpleFileSystemProtocolGuid,
                  NULL,
                  &HandleCount,
                  &Handles
                  );
  if (EFI_ERROR (Status)) {
    return Status;
  }

  for (UINTN i = 0; i < HandleCount; i++) {
    Status = gBS->HandleProtocol (
                    Handles[i],
                    &gEfiSimpleFileSystemProtocolGuid,
                    (VOID **)&Fs
                    );
    if (EFI_ERROR (Status)) {
      continue;
    }
    Status = Fs->OpenVolume (Fs, &Root);
    if (EFI_ERROR (Status)) {
      continue;
    }
    Status = Root->Open (Root, &File, (CHAR16 *)Path, EFI_FILE_MODE_READ, 0);
    if (EFI_ERROR (Status)) {
      Root->Close (Root);
      continue;   // not on this volume
    }

    // Query the size through GetInfo rather than guessing.
    InfoSize = 0;
    Status   = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, NULL);
    if (Status != EFI_BUFFER_TOO_SMALL) {
      File->Close (File);
      Root->Close (Root);
      continue;
    }
    Info = AllocatePool (InfoSize);
    if (Info == NULL) {
      File->Close (File);
      Root->Close (Root);
      FreePool (Handles);
      return EFI_OUT_OF_RESOURCES;
    }
    Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
    if (EFI_ERROR (Status) || Info->FileSize > ENROLL_MAX_FILE) {
      FreePool (Info);
      File->Close (File);
      Root->Close (Root);
      continue;
    }

    Data = AllocatePool ((UINTN)Info->FileSize + 1);
    if (Data == NULL) {
      FreePool (Info);
      File->Close (File);
      Root->Close (Root);
      FreePool (Handles);
      return EFI_OUT_OF_RESOURCES;
    }

    *Size  = (UINTN)Info->FileSize;
    Status = File->Read (File, Size, Data);
    FreePool (Info);
    File->Close (File);
    Root->Close (Root);

    if (EFI_ERROR (Status)) {
      FreePool (Data);
      FreePool (Handles);
      return Status;
    }

    FreePool (Handles);
    *Buffer = Data;
    return EFI_SUCCESS;
  }

  FreePool (Handles);
  return EFI_NOT_FOUND;
}

/** Vendor GUID a Secure Boot variable lives under.

  PK and KEK are globals; db/dbx/dbt are image-security-database entries. Using
  the wrong one is not harmless: the variable driver does not recognise the
  variable as authenticated, and the write fails with EFI_INVALID_PARAMETER (the
  first QEMU run wrote PK/KEK under the image GUID and hit exactly that).

  @param[in]  Name  Variable name.

  @return  The vendor GUID the variable must be written under.
**/
STATIC
EFI_GUID *
EnrollVendorGuid (
  IN CONST CHAR16  *Name
  )
{
  if ((StrCmp ((CHAR16 *)Name, L"PK") == 0) ||
      (StrCmp ((CHAR16 *)Name, L"KEK") == 0))
  {
    return &gEfiGlobalVariableGuid;
  }
  return &gEfiImageSecurityDatabaseGuid;
}

/** Write one EFI_SIGNATURE_LIST file to a Secure Boot variable.

  @param[in] Name   Variable name (L"db", L"dbx", L"kek", L"PK").
  @param[in] Path   ESP path holding the ESL.

  @retval EFI_SUCCESS           Written (or the optional file was absent).
  @retval others                Read or SetVariable failure.
**/
STATIC
EFI_STATUS
EnrollOne (
  IN CONST CHAR16  *Name,
  IN CONST CHAR16  *Path
  )
{
  EFI_STATUS         Status;
  UINT8             *Data = NULL;
  UINTN              Size = 0;
  UINT8             *Payload;
  UINTN              PayloadSize;
  PBL_AUTH2_HEADER  *Header;

  Status = ReadFileFromAnyVolume (Path, &Data, &Size);
  if (Status == EFI_NOT_FOUND) {
    Print (L"  [skip] %s: %s not present\n", Name, Path);
    return EFI_SUCCESS;
  }
  if (EFI_ERROR (Status)) {
    Print (L"  [FAIL] %s: read %s -> %r\n", Name, Path, Status);
    return Status;
  }

  PayloadSize = sizeof (PBL_AUTH2_HEADER) + Size;
  Payload     = AllocatePool (PayloadSize);
  if (Payload == NULL) {
    FreePool (Data);
    return EFI_OUT_OF_RESOURCES;
  }
  ZeroMem (Payload, PayloadSize);

  Header = (PBL_AUTH2_HEADER *)Payload;
  Status = gRT->GetTime (&Header->TimeStamp, NULL);
  if (EFI_ERROR (Status)) {
    Print (L"  [FAIL] %s: GetTime() -> %r\n", Name, Status);
    FreePool (Payload);
    FreePool (Data);
    return Status;
  }
  Header->TimeStamp.Pad1       = 0;
  Header->TimeStamp.Nanosecond = 0;
  Header->TimeStamp.TimeZone   = 0;
  Header->TimeStamp.Daylight   = 0;
  Header->TimeStamp.Pad2       = 0;
  Header->dwLength             = (UINT32)(sizeof (PBL_AUTH2_HEADER) - sizeof (EFI_TIME));
  Header->wRevision            = 0x0200;
  Header->wCertificateType     = WIN_CERT_TYPE_EFI_GUID;
  CopyGuid (&Header->CertType, &gEfiCertPkcs7Guid);
  CopyMem (Payload + sizeof (PBL_AUTH2_HEADER), Data, Size);

  // TIME_BASED_AUTHENTICATED_WRITE_ACCESS is mandatory for these variables even
  // in Setup Mode; without it ProcessVarWithPk rejects the write outright.
  Status = gRT->SetVariable (
                  (CHAR16 *)Name,
                  EnrollVendorGuid (Name),
                  EFI_VARIABLE_NON_VOLATILE |
                  EFI_VARIABLE_BOOTSERVICE_ACCESS |
                  EFI_VARIABLE_RUNTIME_ACCESS |
                  EFI_VARIABLE_TIME_BASED_AUTHENTICATED_WRITE_ACCESS,
                  PayloadSize,
                  Payload
                  );
  if (EFI_ERROR (Status)) {
    Print (L"  [FAIL] %s: SetVariable(%d bytes) -> %r\n", Name, (UINT32)Size, Status);
  } else {
    Print (L"  [OK] %s: %d bytes enrolled\n", Name, (UINT32)Size);
  }

  FreePool (Payload);
  FreePool (Data);
  return Status;
}

/** Read the SecureBoot/SetupMode state so the log says which mode was used.

  @param[in]  Label  L"before" or L"after" — the state means opposite things.
**/
STATIC
VOID
PrintSecureBootState (
  IN CONST CHAR16  *Label
  )
{
  UINT8       SecureBoot = 0;
  UINT8       SetupMode  = 0;
  UINTN       Size;
  EFI_STATUS  Status;

  Size   = sizeof (SecureBoot);
  Status = gRT->GetVariable (L"SecureBoot", &gEfiGlobalVariableGuid, NULL, &Size, &SecureBoot);
  if (EFI_ERROR (Status)) {
    SecureBoot = 0xFF;
  }
  Size   = sizeof (SetupMode);
  Status = gRT->GetVariable (L"SetupMode", &gEfiGlobalVariableGuid, NULL, &Size, &SetupMode);
  if (EFI_ERROR (Status)) {
    SetupMode = 0xFF;
  }
  Print (L"  [INFO] %s: SecureBoot=%d SetupMode=%d\n", Label, SecureBoot, SetupMode);
}

/**
  Entry point: enrol dbx, db, KEK (if present), then PK last.

  @retval EFI_SUCCESS  Every requested variable was written.
  @retval others       The first failure, after reporting it.
**/
EFI_STATUS
EFIAPI
EnrollKeysEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;

  (VOID)ImageHandle;
  (VOID)SystemTable;

  Print (L"\n=== PBL Secure Boot key enrolment ===\n");
  Print (L"  ESP files: \\EFI\\PBL\\{db,dbx,kek,pk}.esl\n");
  PrintSecureBootState (L"before");

  // Items that require Setup Mode first; PK last, because enrolling PK is what
  // leaves Setup Mode and would make the rest impossible.
  Status = EnrollOne (L"dbx", L"\\EFI\\PBL\\dbx.esl");
  if (!EFI_ERROR (Status)) {
    Status = EnrollOne (L"db", L"\\EFI\\PBL\\db.esl");
  }
  if (!EFI_ERROR (Status)) {
    Status = EnrollOne (L"KEK", L"\\EFI\\PBL\\kek.esl");
  }
  if (!EFI_ERROR (Status)) {
    Status = EnrollOne (L"PK", L"\\EFI\\PBL\\pk.esl");
  }

  PrintSecureBootState (L"after");
  Print (L"=== enrolment %a ===\n\n", EFI_ERROR (Status) ? "FAILED" : "complete");

  return Status;
}
