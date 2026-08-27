/*
 * AntiTheftHello.c — Proof of concept UEFI application
 *
 * This is the first step in verifying the UEFI toolchain works.
 * Prints a banner to the UEFI console and reads a UEFI variable.
 *
 * Build target: X64, GCC5 toolchain
 * Test environment: QEMU with OVMF firmware
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/UefiBootServicesTableLib.h>

/* Custom GUID for our anti-theft agent variables */
#define ANTITHEFT_GUID \
  { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } }

EFI_GUID gAntiTheftGuid = ANTITHEFT_GUID;

EFI_STATUS
EFIAPI
AntiTheftHelloEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINT8       AgentState = 0;
  UINTN       DataSize = sizeof(AgentState);
  UINT32      Attributes = 0;

  /* Print banner */
  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft Firmware Module — POC\n");
  Print(L"  Build: %a %a\n", __DATE__, __TIME__);
  Print(L"========================================\n");
  Print(L"\n");

  /* Read the AgentState UEFI variable (if it exists) */
  Status = gRT->GetVariable(
    L"AgentState",
    &gAntiTheftGuid,
    &Attributes,
    &DataSize,
    &AgentState
  );

  if (Status == EFI_SUCCESS) {
    Print(L"[OK] AgentState variable found: %d\n", AgentState);
    Print(L"     Attributes: 0x%08x\n", Attributes);
    if (Attributes & EFI_VARIABLE_NON_VOLATILE) {
      Print(L"     - NON_VOLATILE (persists across reboots)\n");
    }
    if (Attributes & EFI_VARIABLE_BOOTSERVICE_ACCESS) {
      Print(L"     - BOOTSERVICE_ACCESS (accessible pre-OS)\n");
    }
    if (Attributes & EFI_VARIABLE_RUNTIME_ACCESS) {
      Print(L"     - RUNTIME_ACCESS (accessible from OS)\n");
    }
  } else if (Status == EFI_NOT_FOUND) {
    Print(L"[INFO] AgentState variable not found — first run\n");
    Print(L"       Creating it now with NON_VOLATILE | RUNTIME_ACCESS...\n");

    AgentState = 0;  /* 0 = dormant, 1 = activated */
    Status = gRT->SetVariable(
      L"AgentState",
      &gAntiTheftGuid,
      EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
      sizeof(AgentState),
      &AgentState
    );

    if (Status == EFI_SUCCESS) {
      Print(L"[OK] AgentState variable created successfully\n");
      Print(L"     This variable will survive OS reinstalls (stored in NVRAM)\n");
    } else {
      Print(L"[ERROR] Failed to create AgentState: 0x%08x\n", Status);
    }
  } else {
    Print(L"[ERROR] GetVariable failed: 0x%08x\n", Status);
  }

  /* Print system info */
  Print(L"\n");
  Print(L"--- System Information ---\n");
  Print(L"Firmware Vendor: %s\n", gST->FirmwareVendor);
  Print(L"Firmware Revision: 0x%08x\n", gST->FirmwareRevision);
  Print(L"UEFI Spec Version: %d.%02d\n",
    (UINT32)(gST->Hdr.Revision >> 16),
    (UINT32)(gST->Hdr.Revision & 0xFFFF));

  Print(L"\n");
  Print(L"POC complete. Press any key to continue...\n");

  /* Wait for keypress */
  gST->ConIn->Reset(gST->ConIn, FALSE);
  EFI_INPUT_KEY Key;
  while (gST->ConIn->ReadKeyStroke(gST->ConIn, &Key) == EFI_NOT_READY) {
    /* Wait */
  }

  return EFI_SUCCESS;
}
