/** @file
  PblPersistLoader.c — QEMU test loader for PblPersistDxe.

  DXE_DRIVER modules are not boot targets, so the QEMU harness boots this
  UEFI_APPLICATION as BOOTX64.EFI. It loads PblPersistDxe.efi off the ESP via
  LoadImage/StartImage — running the driver's entry point, which registers the
  ReadyToBoot callback — then signals the event group itself:

    Per UEFI spec §7.1 (CreateEventEx): when ANY member event of a named
    event group is signaled, ALL events in the group are notified. BDS
    signals gEfiEventReadyToBootGuid *before* StartImage on the boot target,
    so a driver loaded from inside the boot target misses the real signal.
    Creating a member event in the group and calling SignalEvent on it
    delivers the notification to PblOnReadyToBoot — the same delivery the
    firmware would have used had the driver been resident from DXE dispatch.

  The loader then verifies the dropped files on the ESP and prints
  PASS/FAIL on the serial console for the harness to grep.

  Test-only — not part of the production firmware volume.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include <Uefi.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/LoadedImage.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/DevicePathLib.h>
#include <Library/DebugLib.h>

#define PERSIST_DRIVER  L"\\EFI\\PBL\\PblPersistDxe.efi"
#define EXPECT_MARKER   L"\\EFI\\PBL\\PBL_REARM.TXT"
#define EXPECT_AGENT    L"\\EFI\\PBL\\lockdown-agent-installer.ps1"

/** Dummy notify — required for EVT_NOTIFY_SIGNAL; does nothing. The point
    is membership in the group so SignalEvent fans out to the driver. */
STATIC
VOID
EFIAPI
PblTestNoopNotify (
  IN EFI_EVENT  Event,
  IN VOID       *Context
  )
{
}

STATIC
BOOLEAN
FileExistsOnEsp (
  IN EFI_SIMPLE_FILE_SYSTEM_PROTOCOL  *Sfs,
  IN CONST CHAR16                     *Path
  )
{
  EFI_FILE_PROTOCOL  *Root, *F;
  EFI_STATUS          St;

  if (EFI_ERROR (Sfs->OpenVolume (Sfs, &Root))) return FALSE;
  St = Root->Open (Root, &F, (CHAR16 *)Path, EFI_FILE_MODE_READ, 0);
  if (EFI_ERROR (St)) { Root->Close (Root); return FALSE; }
  F->Close (F);
  Root->Close (Root);
  return TRUE;
}

EFI_STATUS
EFIAPI
PblPersistLoaderEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS                        Status;
  EFI_LOADED_IMAGE_PROTOCOL         *Loaded;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL   *Sfs;
  EFI_HANDLE                        DrvHandle = NULL;
  EFI_DEVICE_PATH_PROTOCOL          *Dp;
  EFI_EVENT                         RtbEvent = NULL;
  BOOLEAN                           Marker, Agent;

  Print (L"[PersistTest] loading %s\n", PERSIST_DRIVER);

  Status = gBS->HandleProtocol (ImageHandle, &gEfiLoadedImageProtocolGuid,
                                (VOID **)&Loaded);
  if (EFI_ERROR (Status)) {
    Print (L"[PersistTest] FAIL no LoadedImage %r\n", Status);
    return Status;
  }
  Status = gBS->HandleProtocol (Loaded->DeviceHandle,
                                &gEfiSimpleFileSystemProtocolGuid,
                                (VOID **)&Sfs);
  if (EFI_ERROR (Status)) {
    Print (L"[PersistTest] FAIL no SFS %r\n", Status);
    return Status;
  }

  Dp = FileDevicePath (Loaded->DeviceHandle, PERSIST_DRIVER);
  if (Dp == NULL) {
    Print (L"[PersistTest] FAIL FileDevicePath\n");
    return EFI_OUT_OF_RESOURCES;
  }

  Status = gBS->LoadImage (FALSE, ImageHandle, Dp, NULL, 0, &DrvHandle);
  FreePool (Dp);
  if (EFI_ERROR (Status)) {
    Print (L"[PersistTest] FAIL LoadImage %r\n", Status);
    return Status;
  }
  Status = gBS->StartImage (DrvHandle, NULL, NULL);
  if (EFI_ERROR (Status)) {
    Print (L"[PersistTest] FAIL StartImage %r\n", Status);
    return Status;
  }
  Print (L"[PersistTest] driver started — callback registered\n");

  // Signal the ReadyToBoot event group via a member event. This fans out to
  // the driver's PblOnReadyToBoot (registered during StartImage above).
  Status = gBS->CreateEventEx (EVT_NOTIFY_SIGNAL, TPL_CALLBACK,
                               PblTestNoopNotify, NULL,
                               &gEfiEventReadyToBootGuid, &RtbEvent);
  if (EFI_ERROR (Status)) {
    Print (L"[PersistTest] FAIL CreateEventEx %r\n", Status);
    return Status;
  }
  gBS->SignalEvent (RtbEvent);
  gBS->CloseEvent (RtbEvent);
  Print (L"[PersistTest] ReadyToBoot group signaled\n");

  // Verify the re-arm landed on the ESP.
  Marker = FileExistsOnEsp (Sfs, EXPECT_MARKER);
  Agent  = FileExistsOnEsp (Sfs, EXPECT_AGENT);
  Print (L"[PersistTest] marker=%s agent=%s\n",
         Marker ? L"PRESENT" : L"MISSING",
         Agent  ? L"PRESENT" : L"MISSING");

  if (Marker && Agent) {
    Print (L"[PersistTest] PASS — agent re-armed on ESP\n");
    return EFI_SUCCESS;
  }
  Print (L"[PersistTest] FAIL — files not written\n");
  return EFI_NOT_FOUND;
}
