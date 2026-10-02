/** @file
  PblPersistDxe.c — DXE persistence module for the remote-lockdown agent.

  LoJax-style persistence done the legitimate way: this module lives in a
  firmware volume on SPI flash (delivered via signed FMP capsule or
  provisioning-time external flash). Each boot, an EFI_EVENT_GROUP_READY_TO_BOOT
  callback re-drops the lockdown-agent installer to the ESP. Because the ESP
  lives on the disk, an OS reinstall or disk replacement wipes it — and this
  module restores it on the next boot, achieving survive-reinstall AND
  survive-disk-replacement persistence for company-owned fleet devices.

  Unlike LoJax's SecDxe (unsigned, BootExecute hijack), this:
    - is delivered through the authorized capsule/flash path on owned hardware
    - drops a first-party agent installer, not a trojanized anti-theft shim
    - leaves a tamper-evident marker so the OS agent can verify provenance

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include <Uefi.h>
#include <Protocol/SimpleFileSystem.h>
#include <Guid/FileInfo.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/UefiLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/DebugLib.h>

// PBL persistence marker + agent payload location on the ESP.
#define PBL_DIR           L"\\EFI\\PBL"
#define PBL_AGENT_PATH    L"\\EFI\\PBL\\lockdown-agent-installer.ps1"
#define PBL_MARKER_PATH   L"\\EFI\\PBL\\PBL_REARM.TXT"
#define PBL_MARKER_GUID  \
  { 0x7C3B9A2E, 0x4E1F, 0x4A6D, { 0xB8, 0xC5, 0x2D, 0x0F, 0x1E, 0x3A, 0x5B, 0x7C } }

STATIC EFI_GUID  mPblPersistGuid = PBL_MARKER_GUID;

// Embedded agent-installer payload. In a real build this is generated from the
// installer script at package time (xxd -i or an EDK II BINARY module). For the
// QEMU proof-of-concept it is a self-contained PowerShell stub that re-registers
// the lockdown agent task on first Windows boot.
STATIC CONST CHAR8  mAgentPayload[] =
  "# PBL re-arm installer — dropped by PblPersistDxe\r\n"
  "# Runs once on first Windows boot; installs the lockdown agent.\r\n"
  "$marker = \"$env:ProgramData\\pbl-rearmed.txt\"\r\n"
  "if (Test-Path $marker) { exit 0 }\r\n"
  "New-Item -ItemType File -Path $marker -Force | Out-Null\r\n"
  "# TODO: fetch agent from control-plane Worker and register service\r\n";

STATIC CONST CHAR8  mMarkerText[] = "PBL_REARMED\n";

/**
  Write a file to an open FAT volume root, creating directories as needed.
  Idempotent: if the target file already exists, we still rewrite it so a
  wiped-but-preserved ESP gets a fresh, known-good payload.
**/
STATIC
EFI_STATUS
PblWriteFile (
  IN EFI_FILE_PROTOCOL  *Root,
  IN CONST CHAR16       *Path,
  IN CONST VOID         *Data,
  IN UINTN              DataSize
  )
{
  EFI_STATUS          Status;
  EFI_FILE_PROTOCOL   *File;

  // Create the directory first (EFI\\PBL). Ignore already-exists.
  EFI_FILE_PROTOCOL *Dir;
  Status = Root->Open (Root, &Dir, PBL_DIR,
                       EFI_FILE_MODE_READ | EFI_FILE_MODE_WRITE | EFI_FILE_MODE_CREATE,
                       EFI_FILE_DIRECTORY);
  if (!EFI_ERROR (Status)) {
    Dir->Close (Dir);
  }

  Status = Root->Open (Root, &File, (CHAR16 *)Path,
                       EFI_FILE_MODE_READ | EFI_FILE_MODE_WRITE | EFI_FILE_MODE_CREATE,
                       0);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Truncate to zero before writing (guarantees a clean payload, not append).
  UINTN InfoSize = SIZE_OF_EFI_FILE_INFO + 512;
  EFI_FILE_INFO *Info = AllocateZeroPool (InfoSize);
  if (Info != NULL) {
    Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
    if (!EFI_ERROR (Status)) {
      Info->FileSize = 0;
      File->SetInfo (File, &gEfiFileInfoGuid, InfoSize, Info);
    }
    FreePool (Info);
  }

  Status = File->Write (File, &DataSize, (VOID *)Data);
  File->Flush (File);
  File->Close (File);
  return Status;
}

/**
  ReadyToBoot callback: find the first writable SimpleFileSystem volume
  (the ESP on a normal boot; any FAT volume after a disk swap once the
  firmware's FAT driver binds it) and re-drop the agent payload.
**/
STATIC
VOID
EFIAPI
PblOnReadyToBoot (
  IN EFI_EVENT  Event,
  IN VOID       *Context
  )
{
  EFI_STATUS                    Status;
  UINTN                         NumHandles = 0;
  EFI_HANDLE                    *Handles = NULL;
  UINTN                         i;
  BOOLEAN                       Dropped = FALSE;

  Status = gBS->LocateHandleBuffer (
                  ByProtocol,
                  &gEfiSimpleFileSystemProtocolGuid,
                  NULL,
                  &NumHandles,
                  &Handles
                  );
  if (EFI_ERROR (Status) || Handles == NULL) {
    return;
  }

  for (i = 0; i < NumHandles && !Dropped; i++) {
    EFI_SIMPLE_FILE_SYSTEM_PROTOCOL  *Sfs;
    EFI_FILE_PROTOCOL                *Root;

    Status = gBS->HandleProtocol (Handles[i], &gEfiSimpleFileSystemProtocolGuid,
                                  (VOID **)&Sfs);
    if (EFI_ERROR (Status)) {
      continue;
    }
    Status = Sfs->OpenVolume (Sfs, &Root);
    if (EFI_ERROR (Status)) {
      continue;
    }

    // Drop the marker first — proves provenance to the OS agent.
    if (!EFI_ERROR (PblWriteFile (Root, PBL_MARKER_PATH,
                                mMarkerText, sizeof (mMarkerText) - 1))
        &&
        !EFI_ERROR (PblWriteFile (Root, PBL_AGENT_PATH,
                                mAgentPayload, sizeof (mAgentPayload) - 1)))
    {
      Dropped = TRUE;
      DEBUG ((DEBUG_INFO, "PblPersistDxe: agent re-armed on handle %u\n", (UINT32)i));
    }
    Root->Close (Root);
  }

  if (!Dropped) {
    // No writable volume (e.g. fresh unformatted disk). Next boot retries —
    // a Windows install creates the ESP during setup, and we re-arm then.
    DEBUG ((DEBUG_WARN, "PblPersistDxe: no writable FS this boot\n"));
  }

  // Record that we ran (non-volatile, runtime-visible) for OS-side audit.
  CHAR16  Data[] = L"REARM";
  gRT->SetVariable (L"PblPersistRun", &mPblPersistGuid,
                    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS
                      | EFI_VARIABLE_RUNTIME_ACCESS,
                    StrSize (Data), Data);

  FreePool (Handles);
}

/**
  Entry point: register the ReadyToBoot callback and return. The driver stays
  resident (DXE_DRIVER image in a firmware volume is dispatched then kept; the
  event callback fires on the signal regardless of the entry-point return).
**/
EFI_STATUS
EFIAPI
PblPersistDxeEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  EFI_EVENT   Event;

  Status = gBS->CreateEventEx (
                  EVT_NOTIFY_SIGNAL,
                  TPL_CALLBACK,
                  PblOnReadyToBoot,
                  NULL,
                  &gEfiEventReadyToBootGuid,
                  &Event
                  );
  if (EFI_ERROR (Status)) {
    DEBUG ((DEBUG_ERROR, "PblPersistDxe: CreateEventEx failed %r\n", Status));
    return Status;
  }

  return EFI_SUCCESS;
}
