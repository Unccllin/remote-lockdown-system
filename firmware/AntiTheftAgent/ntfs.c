/*
 * ntfs.c — NTFS marker file reader
 *
 * Scans all block devices for NTFS volumes (using the ntfs.efi driver
 * if loaded) and reads a marker.txt file from the root directory.
 * The marker file contains device identification and state information
 * written by the Windows-side agent.
 */

#include "AntiTheftAgent.h"
#include <Library/UefiBootServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/BlockIo.h>
#include <Guid/FileInfo.h>

EFI_STATUS
ReadNtfsMarker (
  OUT CHAR16  *MarkerData,
  IN  UINTN   MarkerSize
  )
{
  EFI_STATUS                        Status;
  UINTN                             HandleCount;
  EFI_HANDLE                        *HandleBuffer;
  UINTN                             Index;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL   *Sfs;
  EFI_FILE_PROTOCOL                 *Root;
  EFI_FILE_PROTOCOL                 *MarkerFile;
  UINTN                             ReadSize;
  UINT8                             *FileBuffer;
  EFI_FILE_INFO                     *FileInfo;
  UINTN                             InfoSize;

  if (MarkerData == NULL || MarkerSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  //
  // Find all SimpleFileSystem protocols (one per mounted volume)
  //
  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiSimpleFileSystemProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (EFI_ERROR(Status) || HandleCount == 0) {
    return EFI_NOT_FOUND;
  }

  //
  // Scan each volume for marker.txt
  //
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

    //
    // Try to open marker.txt
    //
    Status = Root->Open(
      Root,
      &MarkerFile,
      L"marker.txt",
      EFI_FILE_MODE_READ,
      0
    );

    if (EFI_ERROR(Status)) {
      Root->Close(Root);
      continue;
    }

    //
    // Get file size
    //
    InfoSize = sizeof(EFI_FILE_INFO) + 128;
    FileInfo = AllocatePool(InfoSize);
    if (FileInfo == NULL) {
      MarkerFile->Close(MarkerFile);
      Root->Close(Root);
      continue;
    }

    Status = MarkerFile->GetInfo(MarkerFile, &gEfiFileInfoGuid, &InfoSize, FileInfo);
    if (EFI_ERROR(Status)) {
      FreePool(FileInfo);
      MarkerFile->Close(MarkerFile);
      Root->Close(Root);
      continue;
    }

    ReadSize = (UINTN)FileInfo->FileSize;
    if (ReadSize > MarkerSize - 2) {
      ReadSize = MarkerSize - 2;
    }

    FileBuffer = AllocatePool(ReadSize);
    if (FileBuffer == NULL) {
      FreePool(FileInfo);
      MarkerFile->Close(MarkerFile);
      Root->Close(Root);
      continue;
    }

    Status = MarkerFile->Read(MarkerFile, &ReadSize, FileBuffer);
    if (EFI_ERROR(Status)) {
      FreePool(FileBuffer);
      FreePool(FileInfo);
      MarkerFile->Close(MarkerFile);
      Root->Close(Root);
      continue;
    }

    //
    // Convert ASCII to CHAR16 (marker.txt is ASCII)
    //
    UINTN i;
    for (i = 0; i < ReadSize && i < MarkerSize - 1; i++) {
      MarkerData[i] = (CHAR16)FileBuffer[i];
    }
    MarkerData[i] = L'\0';

    FreePool(FileBuffer);
    FreePool(FileInfo);
    MarkerFile->Close(MarkerFile);
    Root->Close(Root);

    FreePool(HandleBuffer);
    return EFI_SUCCESS;
  }

  FreePool(HandleBuffer);
  return EFI_NOT_FOUND;
}
