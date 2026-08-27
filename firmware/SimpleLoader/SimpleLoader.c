#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Protocol/SimpleFileSystem.h>
#include <Protocol/LoadedImage.h>
#include <Guid/FileInfo.h>

EFI_STATUS
EFIAPI
SimpleLoaderEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS                        Status;
  EFI_SIMPLE_FILE_SYSTEM_PROTOCOL   *Sfs;
  EFI_FILE_PROTOCOL                 *Root;
  EFI_FILE_PROTOCOL                 *AgentFile;
  UINTN                             InfoSize;
  EFI_FILE_INFO                     *FileInfo;
  UINTN                             FileSize;
  VOID                              *FileBuffer;
  EFI_HANDLE                        AgentHandle;

  Print(L"\n========================================\n");
  Print(L"  Simple Agent Loader\n");
  Print(L"========================================\n\n");

  // For testing: set AgentState to ACTIVATED if --test-lockdown is in cmdline
  // We check the loaded image's LoadOptions for "test-lockdown"
  EFI_LOADED_IMAGE_PROTOCOL *LoadedImage;
  Status = gBS->HandleProtocol(ImageHandle, &gEfiLoadedImageProtocolGuid, (VOID **)&LoadedImage);
  if (!EFI_ERROR(Status) && LoadedImage->LoadOptions != NULL) {
    if (StrnCmp((CHAR16 *)LoadedImage->LoadOptions, L"test-lockdown", 13) == 0) {
      Print(L"[TEST] Setting AgentState = ACTIVATED for lockdown test\n");
      EFI_GUID AntiTheftGuid = { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } };
      UINT8 State = 1; // ACTIVATED
      gRT->SetVariable(L"AgentState", &AntiTheftGuid,
        EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
        sizeof(UINT8), &State);
    }
  }

  // Find the boot volume — just find any SimpleFileSystem
  Status = gBS->LocateProtocol(&gEfiSimpleFileSystemProtocolGuid, NULL, (VOID **)&Sfs);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] No SimpleFileSystem: %r\n", Status);
    return Status;
  }

  Status = Sfs->OpenVolume(Sfs, &Root);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] OpenVolume failed: %r\n", Status);
    return Status;
  }

  Print(L"[1] Opening AntiTheftAgent.efi...\n");
  Status = Root->Open(Root, &AgentFile, L"AntiTheftAgent.efi", EFI_FILE_MODE_READ, 0);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] Cannot open AntiTheftAgent.efi: %r\n", Status);
    return Status;
  }

  // Get file size
  InfoSize = sizeof(EFI_FILE_INFO) + 128;
  FileInfo = AllocatePool(InfoSize);
  Status = AgentFile->GetInfo(AgentFile, &gEfiFileInfoGuid, &InfoSize, FileInfo);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] GetInfo failed: %r\n", Status);
    FreePool(FileInfo);
    AgentFile->Close(AgentFile);
    return Status;
  }

  FileSize = (UINTN)FileInfo->FileSize;
  FreePool(FileInfo);
  Print(L"  File size: %d bytes\n", FileSize);

  // Read file into buffer
  FileBuffer = AllocatePool(FileSize);
  if (!FileBuffer) {
    AgentFile->Close(AgentFile);
    return EFI_OUT_OF_RESOURCES;
  }

  Status = AgentFile->Read(AgentFile, &FileSize, FileBuffer);
  AgentFile->Close(AgentFile);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] Read failed: %r\n", Status);
    FreePool(FileBuffer);
    return Status;
  }

  Print(L"[2] Loading DXE driver image...\n");
  Status = gBS->LoadImage(FALSE, ImageHandle, NULL, FileBuffer, FileSize, &AgentHandle);
  FreePool(FileBuffer);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] LoadImage failed: %r\n", Status);
    return Status;
  }
  Print(L"  [OK] Image loaded\n");

  Print(L"[3] Starting DXE driver...\n");
  Status = gBS->StartImage(AgentHandle, NULL, NULL);
  if (EFI_ERROR(Status)) {
    Print(L"[ERROR] StartImage failed: %r\n", Status);
    return Status;
  }

  Print(L"\n[OK] Agent execution complete\n");
  return EFI_SUCCESS;
}
