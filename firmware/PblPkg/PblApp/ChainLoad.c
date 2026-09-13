/** @file
  ChainLoad.c — Locate and load the Windows Boot Manager (bootmgfw.efi).

  PBL runs in the BDS phase before Windows. On PASS or DEGRADED, PBL
  chain-loads \EFI\Microsoft\Boot\bootmgfw.efi from the ESP using
  gBS->LoadImage() + gBS->StartImage().

  RE-hardening #2: If the policy blob contains a bootmgr_hash (C4 key 58),
  PBL reads bootmgfw.efi into a buffer, hashes it with SHA-256, and compares
  against the expected hash before calling LoadImage. If the hash doesn't
  match, PBL refuses to chain-load — preventing a bootkit from replacing
  the boot manager with a malicious lookalike.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Standard Windows Boot Manager path on the ESP
#define PBL_BOOTMGR_PATH  L"\\EFI\\Microsoft\\Boot\\bootmgfw.efi"
// Backup path (used when PBL replaces bootmgfw.efi on the ESP)
#define PBL_BOOTMGR_BAK_PATH  L"\\EFI\\Microsoft\\Boot\\bootmgfw_orig.efi"

// Marker file — only present when PBL itself created the backup.
// If this marker doesn't exist, the backup path is NOT trusted.
#define PBL_BOOTMGR_BAK_MARKER  L"\\EFI\\PBL\\.bootmgr_backup"

/** Read a file from a given filesystem root into an allocated buffer.

  @param  Root        EFI file protocol root.
  @param  FilePath    File path relative to root.
  @param  Buffer      Output: allocated buffer (caller frees with FreePool).
  @param  BufferSize  Output: size of buffer.

  @retval EFI_SUCCESS  File read.
  @retval other        Open/GetInfo/Read failed.
**/
STATIC
EFI_STATUS
PblReadFile (
  IN  EFI_FILE_PROTOCOL  *Root,
  IN  CONST CHAR16       *FilePath,
  OUT UINT8             **Buffer,
  OUT UINTN              *BufferSize
  )
{
  EFI_FILE_PROTOCOL *File = NULL;
  EFI_FILE_INFO     *Info = NULL;
  UINTN              InfoSize;
  EFI_STATUS         Status;
  UINT8             *FileBuf = NULL;
  UINTN              ReadSize;

  if (Buffer == NULL || BufferSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }
  *Buffer = NULL;
  *BufferSize = 0;

  Status = Root->Open (Root, &File, (CHAR16 *)FilePath, EFI_FILE_MODE_READ, 0);
  if (EFI_ERROR (Status)) {
    return Status;
  }

  // Get file size
  InfoSize = 0;
  Info = NULL;
  Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
  if (Status == EFI_BUFFER_TOO_SMALL) {
    Info = AllocatePool (InfoSize);
    if (Info == NULL) {
      File->Close (File);
      return EFI_OUT_OF_RESOURCES;
    }
    Status = File->GetInfo (File, &gEfiFileInfoGuid, &InfoSize, Info);
  }
  if (EFI_ERROR (Status)) {
    if (Info != NULL) FreePool (Info);
    File->Close (File);
    return Status;
  }

  *BufferSize = (UINTN)Info->FileSize;
  FreePool (Info);

  if (*BufferSize == 0) {
    File->Close (File);
    return EFI_NOT_FOUND;
  }

  FileBuf = AllocatePool (*BufferSize);
  if (FileBuf == NULL) {
    File->Close (File);
    return EFI_OUT_OF_RESOURCES;
  }

  ReadSize = *BufferSize;
  Status = File->Read (File, &ReadSize, FileBuf);
  File->Close (File);

  if (EFI_ERROR (Status) || ReadSize != *BufferSize) {
    FreePool (FileBuf);
    return EFI_DEVICE_ERROR;
  }

  *Buffer = FileBuf;
  return EFI_SUCCESS;
}

/** Find the ESP and read bootmgfw.efi into a buffer.

  Tries the standard path first, then the backup path (only if the PBL
  backup marker file exists). This prevents an attacker from planting a
  malicious bootmgfw_orig.efi to get loaded instead of the real boot manager.

  @param  EspHandle    Output: handle of the ESP device.
  @param  BootMgrBuf   Output: allocated buffer containing bootmgfw.efi.
  @param  BootMgrSize  Output: size of BootMgrBuf.

  @retval EFI_SUCCESS  File found and read.
  @retval EFI_NOT_FOUND  No filesystem has bootmgfw.efi.
**/
STATIC
EFI_STATUS
PblFindAndReadBootMgr (
  OUT EFI_HANDLE  *EspHandle,
  OUT UINT8      **BootMgrBuf,
  OUT UINTN       *BootMgrSize
  )
{
  EFI_HANDLE                      *Handles;
  UINTN                           NumHandles;
  UINTN                           Index;
  EFI_STATUS                      Status;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL *Fs;
  EFI_FILE_PROTOCOL               *Root;

  if (EspHandle == NULL || BootMgrBuf == NULL || BootMgrSize == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  *BootMgrBuf = NULL;
  *BootMgrSize = 0;

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
    Fs = NULL;
    Status = gBS->HandleProtocol (
      Handles[Index],
      &gEfiSimpleFileSystemProtocolGuid,
      (VOID **)&Fs
    );
    if (EFI_ERROR (Status) || Fs == NULL) {
      continue;
    }

    Status = Fs->OpenVolume (Fs, &Root);
    if (EFI_ERROR (Status)) {
      continue;
    }

    // Try standard path first (bootmgfw.efi)
    Status = PblReadFile (Root, PBL_BOOTMGR_PATH, BootMgrBuf, BootMgrSize);
    if (!EFI_ERROR (Status)) {
      Root->Close (Root);
      *EspHandle = Handles[Index];
      gBS->FreePool (Handles);
      return EFI_SUCCESS;
    }

    // Standard path failed — try backup path, but ONLY if the PBL backup
    // marker file exists. This prevents an attacker from planting a
    // malicious bootmgfw_orig.efi to get loaded instead of the real boot
    // manager.
    {
      EFI_FILE_PROTOCOL *Marker = NULL;
      Status = Root->Open (Root, &Marker, PBL_BOOTMGR_BAK_MARKER,
                           EFI_FILE_MODE_READ, 0);
      if (!EFI_ERROR (Status) && Marker != NULL) {
        Marker->Close (Marker);
        // Marker exists — safe to try backup path
        Status = PblReadFile (Root, PBL_BOOTMGR_BAK_PATH, BootMgrBuf, BootMgrSize);
        if (!EFI_ERROR (Status)) {
          Root->Close (Root);
          *EspHandle = Handles[Index];
          gBS->FreePool (Handles);
          return EFI_SUCCESS;
        }
      }
    }

    Root->Close (Root);
  }

  gBS->FreePool (Handles);
  return EFI_NOT_FOUND;
}

/** Load and start the Windows Boot Manager.

  RE-hardening #2: If the policy blob contains a bootmgr_hash (C4 key 58),
  this function hashes bootmgfw.efi with SHA-256 before LoadImage and
  compares against the expected hash. If the hash doesn't match, PBL
  refuses to chain-load — preventing a bootkit from replacing the boot
  manager with a malicious lookalike.

  @param  ImageHandle  PBL's own image handle (parent for LoadImage).
  @param  Policy        Parsed policy blob (may contain bootmgr_hash).

  @retval EFI_SUCCESS     Boot manager loaded and started.
  @retval EFI_NOT_FOUND   bootmgfw.efi not found on any filesystem.
  @retval EFI_SECURITY_VIOLATION  bootmgr hash mismatch (tampered boot manager).
  @retval EFI_LOAD_ERROR  LoadImage or StartImage failed.
**/
EFI_STATUS
PblChainLoadWindows (
  IN EFI_HANDLE         ImageHandle,
  IN CONST PBL_POLICY   *Policy
  )
{
  EFI_HANDLE              EspHandle = NULL;
  EFI_HANDLE              BootMgrImage;
  EFI_STATUS              Status;
  UINT8                  *BootMgrBuf = NULL;
  UINTN                   BootMgrSize = 0;
  UINTN                   ExitDataSize;
  CHAR16                  *ExitData;

  // Find the ESP and read bootmgfw.efi into a buffer
  Status = PblFindAndReadBootMgr (&EspHandle, &BootMgrBuf, &BootMgrSize);
  if (EFI_ERROR (Status)) {
    Print (L"[ChainLoad] bootmgfw.efi not found on any filesystem: %r\n", Status);
    return EFI_NOT_FOUND;
  }

  Print (L"[ChainLoad] bootmgfw.efi: %u bytes\n", (UINT32)BootMgrSize);

  // RE-hardening #2: Hash verification (if policy has bootmgr_hash)
  if (Policy != NULL && Policy->BootMgrHashPresent) {
    UINT8 ComputedHash[32];
    Sha256HashAll (BootMgrBuf, BootMgrSize, ComputedHash);

    if (CompareMem (ComputedHash, Policy->BootMgrHash, 32) != 0) {
      Print (L"[ChainLoad] BLOCK — bootmgfw.efi hash mismatch!\n");
      Print (L"[ChainLoad]   Expected: ");
      for (UINTN i = 0; i < 32; i++) {
        Print (L"%02x", Policy->BootMgrHash[i]);
      }
      Print (L"\n[ChainLoad]   Computed: ");
      for (UINTN i = 0; i < 32; i++) {
        Print (L"%02x", ComputedHash[i]);
      }
      Print (L"\n[ChainLoad] Boot manager may be tampered — refusing to load\n");
      FreePool (BootMgrBuf);
      return EFI_SECURITY_VIOLATION;
    }
    Print (L"[ChainLoad] bootmgfw.efi hash verified (policy key 58)\n");
  } else {
    Print (L"[ChainLoad] No bootmgr_hash in policy — skipping hash check\n");
  }

  // Load the boot manager image from the verified buffer.
  // Using SourceBuffer (not device path) ensures we load exactly what
  // we hashed — no TOCTOU race between hash check and LoadImage.
  Status = gBS->LoadImage (
    FALSE,           // BootPolicy
    ImageHandle,     // ParentImageHandle
    NULL,            // DevicePath (not used — SourceBuffer provided)
    BootMgrBuf,      // SourceBuffer — hash-verified
    BootMgrSize,     // SourceSize
    &BootMgrImage    // OUT: image handle
  );

  // Free the buffer — LoadImage has copied the image
  FreePool (BootMgrBuf);

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
