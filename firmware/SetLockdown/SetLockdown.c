#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Protocol/SimpleFileSystem.h>
#include <Guid/FileInfo.h>

EFI_STATUS
EFIAPI
SetLockdownEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_GUID AntiTheftGuid = { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } };
  UINT8 State = 1; // ACTIVATED

  Print(L"\n[TEST] Setting AgentState = ACTIVATED (1)\n");
  gRT->SetVariable(L"AgentState", &AntiTheftGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof(UINT8), &State);
  Print(L"[TEST] AgentState set. Rebooting to trigger lockdown...\n");

  gRT->ResetSystem(EfiResetCold, EFI_SUCCESS, 0, NULL);
  return EFI_SUCCESS;
}
