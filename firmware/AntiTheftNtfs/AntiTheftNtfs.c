/*
 * AntiTheftNtfs.c — UEFI application that loads the NTFS driver and reads a file
 *
 * This demonstrates firmware-level NTFS read capability for the anti-theft system.
 * It:
 * 1. Loads ntfs.efi (the UEFI NTFS driver from pbatard/ntfs-3g)
 * 2. Connects the driver to all block devices
 * 3. Opens the SimpleFileSystem protocol on the NTFS volume
 * 4. Reads marker.txt from the NTFS volume
 * 5. Prints the file contents
 *
 * Build target: X64, GCC toolchain
 * Test environment: QEMU with OVMF firmware + NTFS disk image
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/DevicePathLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Protocol/DevicePath.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/BlockIo.h>
#include <Protocol/LoadedImage.h>
#include <Protocol/DevicePathToText.h>
#include <Guid/FileInfo.h>

EFI_STATUS
EFIAPI
AntiTheftNtfsEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  EFI_HANDLE  *HandleBuffer;
  UINTN       HandleCount;
  UINTN       Index;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *Sfs;
  EFI_FILE_PROTOCOL               *Root;
  EFI_FILE_PROTOCOL               *File;
  UINTN       BufferSize;
  UINT8       FileBuffer[512];

  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft NTFS Reader — POC\n");
  Print(L"========================================\n");
  Print(L"\n");

  //
  // Step 1: Load the NTFS driver from the same volume we booted from
  //
  Print(L"[1] Loading NTFS driver (ntfs.efi)...\n");

  // Open the volume that we booted from (the FAT partition)
  EFI_LOADED_IMAGE_PROTOCOL *LoadedImage;
  Status = gBS->HandleProtocol (
    ImageHandle,
    &gEfiLoadedImageProtocolGuid,
    (VOID **)&LoadedImage
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get LoadedImage: %r\n", Status);
    return Status;
  }

  // Open the SimpleFileSystem on the boot device
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *BootSfs;
  Status = gBS->HandleProtocol (
    LoadedImage->DeviceHandle,
    &gEfiSimpleFileSystemProtocolGuid,
    (VOID **)&BootSfs
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get boot volume SFS: %r\n", Status);
    return Status;
  }

  EFI_FILE_PROTOCOL *BootRoot;
  Status = BootSfs->OpenVolume(BootSfs, &BootRoot);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot open boot volume: %r\n", Status);
    return Status;
  }

  // Open ntfs.efi from the boot volume
  EFI_FILE_PROTOCOL *DriverFile;
  Status = BootRoot->Open(
    BootRoot,
    &DriverFile,
    L"ntfs.efi",
    EFI_FILE_MODE_READ,
    0
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot open ntfs.efi: %r\n", Status);
    Print(L"  Make sure ntfs.efi is on the boot (FAT) partition.\n");
    return Status;
  }

  // Read the driver file into memory
  EFI_FILE_INFO *DriverInfo;
  UINTN DriverInfoSize = sizeof(EFI_FILE_INFO) + 256;
  DriverInfo = AllocatePool(DriverInfoSize);
  Status = DriverFile->GetInfo(
    DriverFile,
    &gEfiFileInfoGuid,
    &DriverInfoSize,
    DriverInfo
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get ntfs.efi info: %r\n", Status);
    return Status;
  }

  UINTN DriverSize = (UINTN)DriverInfo->FileSize;
  Print(L"  Driver size: %d bytes\n", DriverSize);

  VOID *DriverBuffer = AllocatePool(DriverSize);
  UINTN ReadSize = DriverSize;
  Status = DriverFile->Read(DriverFile, &ReadSize, DriverBuffer);
  if (EFI_ERROR(Status) || ReadSize != DriverSize) {
    Print(L"  [ERROR] Cannot read ntfs.efi: %r (read %d/%d)\n", Status, ReadSize, DriverSize);
    return Status;
  }
  DriverFile->Close(DriverFile);

  // Load the driver image
  EFI_HANDLE DriverImageHandle;
  Status = gBS->LoadImage(
    FALSE,
    ImageHandle,
    NULL,
    DriverBuffer,
    DriverSize,
    &DriverImageHandle
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot load ntfs.efi image: %r\n", Status);
    return Status;
  }

  // Start the driver
  Status = gBS->StartImage(DriverImageHandle, NULL, NULL);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot start ntfs.efi: %r\n", Status);
    Print(L"  (This may happen if the driver is already loaded)\n");
    // Continue anyway — driver might already be loaded
  } else {
    Print(L"  [OK] NTFS driver loaded and started\n");
  }

  //
  // Step 2: Connect the driver to all block devices
  //
  Print(L"\n[2] Connecting driver to block devices...\n");

  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiBlockIoProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot find block devices: %r\n", Status);
    return Status;
  }

  Print(L"  Found %d block device(s)\n", HandleCount);

  for (Index = 0; Index < HandleCount; Index++) {
    Status = gBS->ConnectController(HandleBuffer[Index], NULL, NULL, TRUE);
    if (EFI_ERROR(Status) && Status != EFI_ALREADY_STARTED) {
      Print(L"  Device %d: connect status %r\n", Index, Status);
    } else {
      Print(L"  Device %d: connected\n", Index);
    }
  }

  //
  // Step 3: Find all SimpleFileSystem volumes (including NTFS)
  //
  Print(L"\n[3] Scanning for file system volumes...\n");

  FreePool(HandleBuffer);
  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiSimpleFileSystemProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot find file systems: %r\n", Status);
    return Status;
  }

  Print(L"  Found %d file system volume(s)\n", HandleCount);

  //
  // Step 4: Try each volume to find marker.txt
  //
  Print(L"\n[4] Searching for marker.txt on all volumes...\n");

  BOOLEAN Found = FALSE;
  for (Index = 0; Index < HandleCount; Index++) {
    Status = gBS->HandleProtocol(
      HandleBuffer[Index],
      &gEfiSimpleFileSystemProtocolGuid,
      (VOID **)&Sfs
    );
    if (EFI_ERROR(Status)) {
      continue;
    }

    Status = Sfs->OpenVolume(Sfs, &Root);
    if (EFI_ERROR(Status)) {
      continue;
    }

    // Try to open marker.txt
    Status = Root->Open(
      Root,
      &File,
      L"marker.txt",
      EFI_FILE_MODE_READ,
      0
    );

    if (!EFI_ERROR(Status)) {
      Print(L"  [FOUND] marker.txt on volume %d!\n", Index);

      // Read the file
      BufferSize = sizeof(FileBuffer) - 2;
      Status = File->Read(File, &BufferSize, FileBuffer);
      if (!EFI_ERROR(Status)) {
        // Convert ASCII to CHAR16 for printing (UEFI Print expects wide strings)
        CHAR16 WideBuffer[256];
        UINTN i;
        for (i = 0; i < BufferSize && i < 255; i++) {
          WideBuffer[i] = (CHAR16)FileBuffer[i];
        }
        WideBuffer[i] = L'\0';
        Print(L"\n========================================\n");
        Print(L"  marker.txt contents (%d bytes):\n", BufferSize);
        Print(L"========================================\n");
        Print(L"%s\n", WideBuffer);
        Print(L"========================================\n");
        Found = TRUE;
      }
      File->Close(File);
      Root->Close(Root);
      break;
    }
    Root->Close(Root);
  }

  if (!Found) {
    Print(L"\n  [NOT FOUND] marker.txt was not found on any volume.\n");
    Print(L"  Make sure the NTFS disk image contains marker.txt.\n");
    Print(L"\n  Listing root directory of each volume:\n");
    for (Index = 0; Index < HandleCount; Index++) {
      Print(L"\n  Volume %d:\n", Index);
      Status = gBS->HandleProtocol(
        HandleBuffer[Index],
        &gEfiSimpleFileSystemProtocolGuid,
        (VOID **)&Sfs
      );
      if (EFI_ERROR(Status)) continue;

      Status = Sfs->OpenVolume(Sfs, &Root);
      if (EFI_ERROR(Status)) continue;

      // List root directory
      UINT8 DirBuffer[512];
      BufferSize = sizeof(DirBuffer);
      while (TRUE) {
        BufferSize = sizeof(DirBuffer);
        Status = Root->Read(Root, &BufferSize, DirBuffer);
        if (EFI_ERROR(Status) || BufferSize == 0) break;
        EFI_FILE_INFO *Info = (EFI_FILE_INFO *)DirBuffer;
        if (StrLen(Info->FileName) > 0) {
          Print(L"    %s\n", Info->FileName);
        }
      }
      Root->Close(Root);
    }
  }

  FreePool(HandleBuffer);

  Print(L"\n========================================\n");
  Print(L"  Anti-Theft NTFS Reader Complete\n");
  Print(L"========================================\n");

  return EFI_SUCCESS;
}
