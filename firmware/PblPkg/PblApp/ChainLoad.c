/** @file
  ChainLoad.c — Locate and load the Windows Boot Manager (bootmgfw.efi).

  PBL runs in the BDS phase before Windows. On PASS or DEGRADED, PBL
  chain-loads \EFI\Microsoft\Boot\bootmgfw.efi from the ESP using
  gBS->LoadImage() + gBS->StartImage().

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Standard Windows Boot Manager path on the ESP
#define PBL_BOOTMGR_PATH  L"\\EFI\\Microsoft\\Boot\\bootmgfw.efi"

/** Find the ESP by locating a filesystem that contains bootmgfw.efi.

  @param  EspHandle  Output: handle of the ESP device.

  @retval EFI_SUCCESS     ESP found.
  @retval EFI_NOT_FOUND   No filesystem has bootmgfw.efi.
**/
STATIC
EFI_STATUS
PblFindEsp (
  OUT EFI_HANDLE  *EspHandle
  )
{
  EFI_HANDLE                      *Handles;
  UINTN                           NumHandles;
  UINTN                           Index;
  EFI_STATUS                      Status;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *Fs;
  EFI_FILE_PROTOCOL               *Root;
  EFI_FILE_PROTOCOL               *BootMgr;

  if (EspHandle == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  Status = gBS->LocateHandleBuffer (
    ByProtocol,
    &gEfiSimpleFileSystemProtocolGuid,
    NULL,
    &NumHandles,
    &Handles
  );
  if (EFI_ERROR (Status)) {
    return Status;
  }

  for (Index = 0; Index < NumHandles; Index++) {
    Status = gBS->HandleProtocol (
      Handles[Index],
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

    Status = Root->Open (Root, &BootMgr, PBL_BOOTMGR_PATH,
                         EFI_FILE_MODE_READ, 0);
    Root->Close (Root);

    if (!EFI_ERROR (Status)) {
      BootMgr->Close (BootMgr);
      *EspHandle = Handles[Index];
      gBS->FreePool (Handles);
      return EFI_SUCCESS;
    }
  }

  gBS->FreePool (Handles);
  return EFI_NOT_FOUND;
}

/** Load and start the Windows Boot Manager.

  @param  ImageHandle  PBL's own image handle (parent for LoadImage).

  @retval EFI_SUCCESS     Boot manager loaded and started.
  @retval EFI_NOT_FOUND   bootmgfw.efi not found on any filesystem.
  @retval EFI_LOAD_ERROR  LoadImage or StartImage failed.
**/
EFI_STATUS
PblChainLoadWindows (
  IN EFI_HANDLE  ImageHandle
  )
{
  EFI_HANDLE              EspHandle;
  EFI_HANDLE              BootMgrImage;
  EFI_STATUS              Status;
  EFI_DEVICE_PATH_PROTOCOL *EspDevicePath;
  EFI_DEVICE_PATH_PROTOCOL *FullDevicePath;
  UINTN                   ExitDataSize;
  CHAR16                  *ExitData;

  // Find the ESP
  Status = PblFindEsp (&EspHandle);
  if (EFI_ERROR (Status)) {
    Print (L"[ChainLoad] bootmgfw.efi not found on any filesystem\n");
    return EFI_NOT_FOUND;
  }

  // Get the ESP device path
  Status = gBS->HandleProtocol (
    EspHandle,
    &gEfiDevicePathProtocolGuid,
    (VOID **)&EspDevicePath
  );
  if (EFI_ERROR (Status)) {
    return EFI_DEVICE_ERROR;
  }

  // Build full device path: ESP device path + file path
  FullDevicePath = FileDevicePath (EspHandle, PBL_BOOTMGR_PATH);
  if (FullDevicePath == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }

  // Load the boot manager image
  Status = gBS->LoadImage (
    FALSE,           // BootPolicy
    ImageHandle,     // ParentImageHandle
    FullDevicePath,  // DevicePath
    NULL,            // SourceBuffer
    0,               // SourceSize
    &BootMgrImage    // OUT: image handle
  );

  gBS->FreePool (FullDevicePath);

  if (EFI_ERROR (Status)) {
    Print (L"[ChainLoad] LoadImage failed: %r\n", Status);
    return EFI_LOAD_ERROR;
  }

  // Start the boot manager image
  ExitDataSize = 0;
  Status = gBS->StartImage (BootMgrImage, &ExitDataSize, &ExitData);
  if (EFI_ERROR (Status)) {
    Print (L"[ChainLoad] StartImage failed: %r\n", Status);
    gBS->UnloadImage (BootMgrImage);
    return EFI_LOAD_ERROR;
  }

  // If StartImage returns, the boot manager exited — this is unusual
  // but not necessarily an error. Return success.
  return EFI_SUCCESS;
}
