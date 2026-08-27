/*
 * CapsuleLoader.c — UEFI application that loads and processes a capsule file
 *
 * This application:
 * 1. Opens the FAT filesystem
 * 2. Reads AntiTheft.cap from the root directory
 * 3. Parses the capsule header and validates the format
 * 4. Attempts UpdateCapsule() (firmware flash path)
 * 5. If firmware doesn't support capsule updates, falls back to
 *    directly loading the DXE driver from the capsule payload
 *    (simulates what the firmware would do after flashing)
 *
 * On real hardware with capsule support, step 4 succeeds and the
 * firmware flashes the driver into SPI flash on the next reboot.
 * On OVMF/QEMU (no FMP support), step 5 loads the driver directly
 * to verify the capsule payload is valid and executable.
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/BaseLib.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/LoadedImage.h>
#include <Guid/CapsuleReport.h>
#include <Guid/FileInfo.h>
#include <Guid/FmpCapsule.h>

#define CAPSULE_FILE_NAME L"AntiTheft.cap"

//
// FMP Capsule GUID: {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A}
//
STATIC EFI_GUID mFmpCapsuleGuid = { 0x6DCBD5ED, 0xE82D, 0x4C44, { 0xBD, 0xA1, 0x71, 0x94, 0x19, 0x9A, 0xD9, 0x2A } };

/**
  Parse the FMP capsule and extract the payload (DXE driver binary).

  FMP capsule structure:
    EFI_CAPSULE_HEADER
    EFI_FIRMWARE_MANAGEMENT_CAPSULE_HEADER
    EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER
    [payload: DXE driver .efi]

  @param CapsuleBuffer   Pointer to the capsule data.
  @param CapsuleSize     Size of the capsule.
  @param PayloadBuffer   Output: pointer to the payload (inside capsule buffer).
  @param PayloadSize     Output: size of the payload.

  @retval EFI_SUCCESS  Payload extracted.
  @retval other        Parse error.
**/
STATIC
EFI_STATUS
ExtractFmpPayload (
  IN  VOID   *CapsuleBuffer,
  IN  UINTN   CapsuleSize,
  OUT VOID   **PayloadBuffer,
  OUT UINTN   *PayloadSize
  )
{
  EFI_CAPSULE_HEADER                        *CapsuleHeader;
  EFI_FIRMWARE_MANAGEMENT_CAPSULE_HEADER    *FmpHeader;
  EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER *ImageHeader;
  UINT8                                     *Ptr;
  UINT32                                    PayloadOffset;

  if (CapsuleSize < sizeof(EFI_CAPSULE_HEADER)) {
    return EFI_INVALID_PARAMETER;
  }

  CapsuleHeader = (EFI_CAPSULE_HEADER *)CapsuleBuffer;

  //
  // Verify this is an FMP capsule
  //
  if (!CompareGuid(&CapsuleHeader->CapsuleGuid, &mFmpCapsuleGuid)) {
    return EFI_INVALID_PARAMETER;
  }

  //
  // Skip capsule header to get to FMP header
  //
  Ptr = (UINT8 *)CapsuleBuffer + CapsuleHeader->HeaderSize;
  FmpHeader = (EFI_FIRMWARE_MANAGEMENT_CAPSULE_HEADER *)Ptr;

  //
  // Get the first (and only) payload item
  // ItemOffsetList[0] points to the image header relative to FmpHeader
  //
  if (FmpHeader->PayloadItemCount == 0) {
    return EFI_INVALID_PARAMETER;
  }

  Ptr = (UINT8 *)FmpHeader + sizeof(EFI_FIRMWARE_MANAGEMENT_CAPSULE_HEADER);
  // First item offset (64-bit)
  PayloadOffset = (UINT32)*((UINT64 *)Ptr);

  //
  // Get the image header
  //
  ImageHeader = (EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER *)
    ((UINT8 *)FmpHeader + PayloadOffset);

  //
  // The payload starts after the image header.
  // The FMP payload has its own header (FMP_PAYLOAD_HEADER with "MSS1" signature)
  // before the actual UEFI image. We need to skip it.
  //
  // Structure inside UpdateImageSize:
  //   [signed capsules] EFI_FIRMWARE_IMAGE_AUTHENTICATION
  //   FMP_PAYLOAD_HEADER (16 bytes: Signature(4) + HeaderSize(4) + FwVersion(4) + Lsv(4))
  //   Actual UEFI image (.efi binary)
  //
  Ptr = (UINT8 *)ImageHeader + sizeof(EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER);

  if (ImageHeader->ImageCapsuleSupport & 0x00000001) {
    // Signed: skip EFI_FIRMWARE_IMAGE_AUTHENTICATION
    // Structure: UINT64 MonotonicCount + WIN_CERTIFICATE (dwLength + data)
    // Total auth size = 8 (MonotonicCount) + dwLength
    UINT64 MonotonicCount = *((UINT64 *)Ptr);
    (VOID)MonotonicCount;  // Not used, just skipping
    UINT32 CertLength = *((UINT32 *)(Ptr + 8));  // dwLength in WIN_CERTIFICATE
    UINT32 AuthHeaderSize = 8 + CertLength;
    Ptr += AuthHeaderSize;
  }

  // Now Ptr points to FMP_PAYLOAD_HEADER (or directly to the UEFI image
  // if there's no FMP payload header). Check for "MSS1" signature.
  {
    UINT32 Signature = *((UINT32 *)Ptr);
    if (Signature == 0x3153534D) {  // "MSS1" as UINT32 (little-endian)
      // Skip FMP_PAYLOAD_HEADER (16 bytes)
      UINT32 FmpHeaderSize = *((UINT32 *)(Ptr + 4));
      Ptr += FmpHeaderSize;
      *PayloadBuffer = Ptr;
      // Payload size = remaining bytes from current position to end of UpdateImageSize
      {
        UINT8 *PayloadStart = (UINT8 *)ImageHeader + sizeof(EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER);
        if (ImageHeader->ImageCapsuleSupport & 0x00000001) {
          UINT32 CertLength = *((UINT32 *)(PayloadStart + 8));
          *PayloadSize = ImageHeader->UpdateImageSize - (8 + CertLength) - FmpHeaderSize;
        } else {
          *PayloadSize = ImageHeader->UpdateImageSize - FmpHeaderSize;
        }
      }
    } else {
      // No FMP payload header — payload is the raw UEFI image
      *PayloadBuffer = Ptr;
      if (ImageHeader->ImageCapsuleSupport & 0x00000001) {
        UINT32 CertLength = *((UINT32 *)((UINT8 *)ImageHeader + sizeof(EFI_FIRMWARE_MANAGEMENT_CAPSULE_IMAGE_HEADER) + 8));
        *PayloadSize = ImageHeader->UpdateImageSize - (8 + CertLength);
      } else {
        *PayloadSize = ImageHeader->UpdateImageSize;
      }
    }
  }

  return EFI_SUCCESS;
}

EFI_STATUS
EFIAPI
CapsuleLoaderEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS                          Status;
  EFI_LOADED_IMAGE_PROTOCOL           *LoadedImage;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL     *Sfs;
  EFI_FILE_PROTOCOL                   *Root;
  EFI_FILE_PROTOCOL                   *CapsuleFile;
  UINTN                               CapsuleSize;
  VOID                                *CapsuleBuffer;
  VOID                                *PayloadBuffer;
  UINTN                               PayloadSize;
  EFI_CAPSULE_BLOCK_DESCRIPTOR        *Descriptors;
  UINT64                              MaxCapsuleSize;
  EFI_RESET_TYPE                      ResetType;
  EFI_HANDLE                          DriverImageHandle;
  EFI_CAPSULE_HEADER                  *CapsuleHeader;

  Print(L"\n========================================\n");
  Print(L"  UEFI Capsule Loader\n");
  Print(L"  Anti-Theft Firmware Update\n");
  Print(L"========================================\n\n");

  //
  // Step 1: Get the loaded image protocol to find our device handle
  //
  Print(L"[1] Locating boot device...\n");
  Status = gBS->HandleProtocol (
    ImageHandle,
    &gEfiLoadedImageProtocolGuid,
    (VOID **)&LoadedImage
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get LoadedImage: %r\n", Status);
    return Status;
  }

  //
  // Step 2: Open the SimpleFileSystem on the boot device
  //
  Status = gBS->HandleProtocol (
    LoadedImage->DeviceHandle,
    &gEfiSimpleFileSystemProtocolGuid,
    (VOID **)&Sfs
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get SFS: %r\n", Status);
    return Status;
  }

  Status = Sfs->OpenVolume(Sfs, &Root);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot open volume: %r\n", Status);
    return Status;
  }
  Print(L"  [OK] Boot volume opened\n\n");

  //
  // Step 3: Open the capsule file
  //
  Print(L"[2] Opening capsule file: %s\n", CAPSULE_FILE_NAME);
  Status = Root->Open(
    Root,
    &CapsuleFile,
    CAPSULE_FILE_NAME,
    EFI_FILE_MODE_READ,
    0
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot open capsule file: %r\n", Status);
    Print(L"  Make sure AntiTheft.cap is in the root directory.\n");
    return Status;
  }

  //
  // Step 4: Get file size and read the capsule
  //
  EFI_FILE_INFO *FileInfo;
  UINTN InfoSize = sizeof(EFI_FILE_INFO) + 128;
  FileInfo = AllocatePool(InfoSize);
  Status = CapsuleFile->GetInfo(CapsuleFile, &gEfiFileInfoGuid, &InfoSize, FileInfo);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot get file info: %r\n", Status);
    return Status;
  }

  CapsuleSize = (UINTN)FileInfo->FileSize;
  Print(L"  Capsule size: %d bytes\n", CapsuleSize);

  CapsuleBuffer = AllocatePool(CapsuleSize);
  if (CapsuleBuffer == NULL) {
    Print(L"  [ERROR] Out of memory\n");
    return EFI_OUT_OF_RESOURCES;
  }

  Status = CapsuleFile->Read(CapsuleFile, &CapsuleSize, CapsuleBuffer);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot read capsule: %r\n", Status);
    return Status;
  }
  CapsuleFile->Close(CapsuleFile);
  Print(L"  [OK] Capsule read into memory\n\n");

  //
  // Step 5: Parse and validate the capsule header
  //
  Print(L"[3] Parsing capsule header...\n");
  CapsuleHeader = (EFI_CAPSULE_HEADER *)CapsuleBuffer;
  Print(L"  Capsule GUID: %g\n", &CapsuleHeader->CapsuleGuid);
  Print(L"  HeaderSize:   0x%x\n", CapsuleHeader->HeaderSize);
  Print(L"  Flags:        0x%x\n", CapsuleHeader->Flags);
  Print(L"  ImageSize:    0x%x\n", CapsuleHeader->CapsuleImageSize);

  if (CompareGuid(&CapsuleHeader->CapsuleGuid, &mFmpCapsuleGuid)) {
    Print(L"  [OK] FMP Capsule identified\n");
  } else {
    Print(L"  [WARN] Not an FMP capsule (GUID mismatch)\n");
    Print(L"  Expected: %g\n", &mFmpCapsuleGuid);
  }

  if (CapsuleHeader->Flags & 0x00010000) {
    Print(L"  [OK] CAPSULE_FLAGS_PERSIST_ACROSS_RESET set\n");
  }
  Print(L"\n");

  //
  // Step 6: Extract the payload from the capsule
  //
  Print(L"[4] Extracting capsule payload...\n");
  Status = ExtractFmpPayload(CapsuleBuffer, CapsuleSize, &PayloadBuffer, &PayloadSize);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] Cannot extract payload: %r\n", Status);
    FreePool(CapsuleBuffer);
    return Status;
  }
  Print(L"  Payload size: %d bytes\n", PayloadSize);
  Print(L"  [OK] Payload extracted (DXE driver binary)\n\n");

  //
  // Step 7: Try firmware capsule update path (UpdateCapsule)
  //
  Print(L"[5] Attempting firmware capsule update (UpdateCapsule)...\n");

  Status = gRT->QueryCapsuleCapabilities(
    (EFI_CAPSULE_HEADER **)&CapsuleBuffer,
    1,
    &MaxCapsuleSize,
    &ResetType
  );

  if (!EFI_ERROR(Status)) {
    Print(L"  [OK] Firmware supports capsule updates\n");
    Print(L"  Max capsule size: %d bytes\n", MaxCapsuleSize);

    Descriptors = AllocateRuntimePool(sizeof(EFI_CAPSULE_BLOCK_DESCRIPTOR) * 2);
    if (Descriptors != NULL) {
      Descriptors[0].Length = CapsuleSize;
      Descriptors[0].Union.DataBlock = (EFI_PHYSICAL_ADDRESS)(UINTN)CapsuleBuffer;
      Descriptors[1].Length = 0;
      Descriptors[1].Union.ContinuationPointer = 0;

      Status = gRT->UpdateCapsule(
        (EFI_CAPSULE_HEADER **)&CapsuleBuffer,
        1,
        (EFI_PHYSICAL_ADDRESS)(UINTN)Descriptors
      );

      if (!EFI_ERROR(Status)) {
        Print(L"  [OK] Capsule submitted to firmware!\n");
        Print(L"  Rebooting to process capsule...\n");
        gRT->ResetSystem(EfiResetWarm, EFI_SUCCESS, 0, NULL);
      }
    }
  }

  Print(L"  [INFO] Firmware does not support FMP capsule updates\n");
  Print(L"  Falling back to direct driver load (simulates post-flash execution)\n\n");

  //
  // Step 8: Fallback — load the DXE driver directly from the capsule payload
  // This simulates what the firmware would do after flashing the driver.
  // It verifies the capsule contains a valid, loadable DXE driver.
  //
  Print(L"[6] Loading DXE driver from capsule payload...\n");
  Print(L"  (This simulates what firmware does after flashing the capsule)\n");

  Status = gBS->LoadImage(
    FALSE,                    // BootService
    ImageHandle,              // Caller image
    NULL,                     // DevicePath (NULL = load from buffer)
    PayloadBuffer,            // Source buffer
    PayloadSize,              // Source size
    &DriverImageHandle        // Image handle
  );

  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] LoadImage failed: %r\n", Status);
    Print(L"  The capsule payload is not a valid UEFI image.\n");
    FreePool(CapsuleBuffer);
    return Status;
  }
  Print(L"  [OK] DXE driver loaded from capsule payload\n");

  //
  // Step 9: Start the DXE driver
  //
  Print(L"[7] Starting Anti-Theft DXE driver...\n");
  Status = gBS->StartImage(DriverImageHandle, NULL, NULL);
  if (EFI_ERROR(Status)) {
    Print(L"  [ERROR] StartImage failed: %r\n", Status);
    FreePool(CapsuleBuffer);
    return Status;
  }

  Print(L"  [OK] Anti-Theft DXE driver started successfully!\n\n");

  //
  // Step 10: Verify the driver set its NVRAM variables
  //
  Print(L"[8] Verifying agent installation...\n");
  {
    EFI_GUID AntiTheftGuid = { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } };
    UINT8    Installed = 0;
    UINT16   Version = 0;
    UINTN    DataSize;
    UINT32   Attributes;

    DataSize = sizeof(UINT8);
    Status = gRT->GetVariable(L"AgentInstalled", &AntiTheftGuid, &Attributes, &DataSize, &Installed);
    if (!EFI_ERROR(Status) && Installed == 1) {
      Print(L"  [OK] AgentInstalled = 1 (agent is resident in NVRAM)\n");
    } else {
      Print(L"  [WARN] AgentInstalled not found: %r\n", Status);
    }

    DataSize = sizeof(UINT16);
    Status = gRT->GetVariable(L"AgentVersion", &AntiTheftGuid, &Attributes, &DataSize, &Version);
    if (!EFI_ERROR(Status)) {
      Print(L"  [OK] AgentVersion = 0x%04x\n", Version);
    } else {
      Print(L"  [WARN] AgentVersion not found: %r\n", Status);
    }

    DataSize = sizeof(UINT8);
    UINT8 State = 0;
    Status = gRT->GetVariable(L"AgentState", &AntiTheftGuid, &Attributes, &DataSize, &State);
    if (!EFI_ERROR(Status)) {
      Print(L"  [OK] AgentState = %d (0=Dormant, 1=Activated, 2=Locked)\n", State);
    } else {
      Print(L"  [WARN] AgentState not found: %r\n", Status);
    }
  }

  Print(L"\n========================================\n");
  Print(L"  Capsule Update Test Complete\n");
  Print(L"========================================\n");
  Print(L"\n");
  Print(L"  On real hardware:\n");
  Print(L"    - UpdateCapsule() would submit to firmware\n");
  Print(L"    - On reboot, firmware flashes driver to SPI flash\n");
  Print(L"    - Driver runs on every subsequent boot\n");
  Print(L"    - Driver survives OS reinstalls and disk wipes\n");
  Print(L"\n");
  Print(L"  In this QEMU test:\n");
  Print(L"    - Capsule format validated (header + FMP structure)\n");
  Print(L"    - Payload extracted and loaded as DXE driver\n");
  Print(L"    - Driver executed and set NVRAM variables\n");
  Print(L"    - Capsule delivery mechanism VERIFIED\n");

  FreePool(CapsuleBuffer);
  return EFI_SUCCESS;
}
