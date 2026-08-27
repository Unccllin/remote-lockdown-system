/*
 * AntiTheftFmpDxe.c — UEFI DXE driver delivered via capsule update
 *
 * This is the payload of a UEFI capsule update. When flashed via capsule,
 * this driver becomes resident in the firmware volume and executes on
 * every boot before the OS loads.
 *
 * The driver:
 * 1. Registers a UEFI variable indicating the anti-theft agent is installed
 * 2. Performs a network check-in (if network is available)
 * 3. Reads the AgentState UEFI variable to determine activation state
 * 4. If activated, enforces lockdown policies
 *
 * This is a minimal proof-of-concept. In production, this would include
 * full network stack initialization, HTTP check-in, TPM sealing, etc.
 *
 * Build target: X64, GCC toolchain
 * Delivery: UEFI capsule update (.cap file)
 */

#include <Uefi.h>
#include <Library/UefiDriverEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/BaseLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/DebugLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Protocol/LoadedImage.h>

//
// Anti-Theft GUID (same as used in AntiTheftHello)
//
#define ANTITHEFT_GUID \
  { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } }

STATIC EFI_GUID gAntiTheftGuid = ANTITHEFT_GUID;

//
// Capsule version info (set by build system)
//
#ifndef CAPSULE_VERSION
#define CAPSULE_VERSION L"0.1.0"
#endif

//
// Agent states
//
#define AGENT_STATE_DORMANT    0
#define AGENT_STATE_ACTIVATED  1
#define AGENT_STATE_LOCKED     2

/**
  Get the current agent state from UEFI variable.

  @param State  Pointer to receive the state value.

  @retval EFI_SUCCESS  State read successfully.
  @retval other        Variable not found or error.
**/
STATIC
EFI_STATUS
GetAgentState (
  OUT UINT8  *State
  )
{
  EFI_STATUS  Status;
  UINTN       DataSize;
  UINT32      Attributes;

  DataSize = sizeof(UINT8);
  Status = gRT->GetVariable (
    L"AgentState",
    &gAntiTheftGuid,
    &Attributes,
    &DataSize,
    State
  );

  return Status;
}

/**
  Set the agent installed marker variable.
  This variable persists across reboots and OS reinstalls (NVRAM).
**/
STATIC
EFI_STATUS
SetAgentInstalled (
  VOID
  )
{
  EFI_STATUS  Status;
  UINT8       Installed = 1;

  Status = gRT->SetVariable (
    L"AgentInstalled",
    &gAntiTheftGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof(UINT8),
    &Installed
  );

  return Status;
}

/**
  Set the agent version variable.
**/
STATIC
EFI_STATUS
SetAgentVersion (
  VOID
  )
{
  EFI_STATUS  Status;
  UINT16      Version = 0x0100;  // v1.0

  Status = gRT->SetVariable (
    L"AgentVersion",
    &gAntiTheftGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof(UINT16),
    &Version
  );

  return Status;
}

/**
  Main entry point for the Anti-Theft DXE driver.

  This runs during DXE phase, before the OS loads.
**/
EFI_STATUS
EFIAPI
AntiTheftFmpDxeEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINT8       AgentState;
  UINT8       AgentInstalled;

  //
  // Step 1: Print banner (visible in serial console in QEMU)
  //
  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft Firmware Agent\n");
  Print(L"  Version: %s\n", CAPSULE_VERSION);
  Print(L"  Delivered via: UEFI Capsule Update\n");
  Print(L"========================================\n");
  Print(L"\n");

  //
  // Step 2: Mark agent as installed in NVRAM
  //
  Status = SetAgentInstalled();
  if (EFI_ERROR(Status)) {
    Print(L"[WARN] Failed to set AgentInstalled: %r\n", Status);
  } else {
    Print(L"[OK] AgentInstalled variable set in NVRAM\n");
  }

  //
  // Step 3: Set agent version
  //
  Status = SetAgentVersion();
  if (EFI_ERROR(Status)) {
    Print(L"[WARN] Failed to set AgentVersion: %r\n", Status);
  } else {
    Print(L"[OK] AgentVersion variable set in NVRAM\n");
  }

  //
  // Step 4: Read current agent state
  //
  Status = GetAgentState(&AgentState);
  if (EFI_ERROR(Status)) {
    Print(L"[INFO] AgentState not found — creating as DORMANT\n");
    AgentState = AGENT_STATE_DORMANT;
    Status = gRT->SetVariable (
      L"AgentState",
      &gAntiTheftGuid,
      EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
      sizeof(UINT8),
      &AgentState
    );
    if (EFI_ERROR(Status)) {
      Print(L"[ERROR] Failed to create AgentState: %r\n", Status);
    } else {
      Print(L"[OK] AgentState created: DORMANT (0)\n");
    }
  } else {
    switch (AgentState) {
      case AGENT_STATE_DORMANT:
        Print(L"[OK] AgentState: DORMANT (0)\n");
        break;
      case AGENT_STATE_ACTIVATED:
        Print(L"[OK] AgentState: ACTIVATED (1)\n");
        Print(L"  >>> ENFORCING LOCKDOWN POLICIES <<<\n");
        break;
      case AGENT_STATE_LOCKED:
        Print(L"[OK] AgentState: LOCKED (2)\n");
        Print(L"  >>> DEVICE LOCKED — CONTACT ADMIN <<<\n");
        break;
      default:
        Print(L"[WARN] AgentState: unknown (%d)\n", AgentState);
        break;
    }
  }

  //
  // Step 5: Verify AgentInstalled
  //
  UINTN   DataSize = sizeof(UINT8);
  UINT32  Attr;
  Status = gRT->GetVariable (
    L"AgentInstalled",
    &gAntiTheftGuid,
    &Attr,
    &DataSize,
    &AgentInstalled
  );
  if (!EFI_ERROR(Status) && AgentInstalled == 1) {
    Print(L"\n[OK] Agent installation verified in NVRAM\n");
    Print(L"     The agent will run on every boot.\n");
    Print(L"     It survives OS reinstalls and disk replacements.\n");
  }

  Print(L"\n========================================\n");
  Print(L"  Anti-Theft Agent initialization complete\n");
  Print(L"========================================\n");

  //
  // Return EFI_SUCCESS so the driver stays loaded.
  // In production, this driver would also:
  // - Initialize the network stack and perform HTTP check-in
  // - Check TPM PCR values for tamper detection
  // - Read NTFS volumes for marker files
  // - Enforce lockdown if activated
  //

  return EFI_SUCCESS;
}
