/*
 * lockdown.c — Lockdown enforcement
 *
 * When the device is marked as stolen (ACTIVATED or LOCKED state),
 * the agent enforces lockdown policies:
 *
 * Policy 1 (LOCKDOWN_DISPLAY_WARNING): Display a prominent warning
 *   on screen before allowing boot to continue. The warning tells the
 *   user the device is reported stolen and provides contact info.
 *
 * Policy 2 (LOCKDOWN_BLOCK_BOOT): Block OS boot entirely. The device
 *   will only boot to the UEFI shell or the anti-theft agent's recovery
 *   interface. This is the most aggressive policy.
 *
 * The policy is set at compile time via LOCKDOWN_POLICY in AntiTheftAgent.h.
 */

#include "AntiTheftAgent.h"
#include <Library/UefiBootServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseLib.h>

EFI_STATUS
EnforceLockdown (
  IN UINT8  AgentState
  )
{
  EFI_STATUS  Status;
  UINTN       WaitIndex;
  EFI_INPUT_KEY Key;

  ZeroMem(&Key, sizeof(Key));
  (VOID)Status;       // Used only in LOCKDOWN_BLOCK_BOOT policy
  (VOID)WaitIndex;    // Used only in LOCKDOWN_BLOCK_BOOT policy
  (VOID)Key;          // Used only in LOCKDOWN_BLOCK_BOOT policy

  Print(L"\n");
  Print(L"╔══════════════════════════════════════════════╗\n");
  Print(L"║                                              ║\n");
  Print(L"║   *** THIS DEVICE IS REPORTED STOLEN ***     ║\n");
  Print(L"║                                              ║\n");
  Print(L"║   The anti-theft system has marked this      ║\n");
  Print(L"║   device as stolen. All activity is being    ║\n");
  Print(L"║   logged and reported.                       ║\n");
  Print(L"║                                              ║\n");

  if (AgentState == AGENT_STATE_LOCKED) {
    Print(L"║   STATUS: LOCKED                             ║\n");
    Print(L"║   Boot is BLOCKED. Contact the owner or      ║\n");
    Print(L"║   administrator to recover this device.      ║\n");
  } else {
    Print(L"║   STATUS: ACTIVATED                          ║\n");
    Print(L"║   Boot will continue with restrictions.      ║\n");
  }

  Print(L"║                                              ║\n");
  Print(L"║   Contact: security@example.com              ║\n");
  Print(L"║   Reference: AT-DEV-%08x                 ║\n", (UINT32)(AsmReadTsc() >> 20));
  Print(L"║                                              ║\n");
  Print(L"╚══════════════════════════════════════════════╝\n");
  Print(L"\n");

#if LOCKDOWN_POLICY == LOCKDOWN_BLOCK_BOOT
  //
  // Block boot entirely — wait for key press, then loop
  //
  if (AgentState == AGENT_STATE_LOCKED) {
    Print(L"  Boot is BLOCKED. Press any key to enter recovery mode.\n");

    // Wait for key press
    Status = gBS->WaitForEvent(1, &gST->ConIn->WaitForKey, &WaitIndex);
    if (!EFI_ERROR(Status)) {
      gST->ConIn->ReadKeyStroke(gST->ConIn, &Key);
    }

    // In a real implementation, this would enter a recovery interface
    // that allows the legitimate owner to unlock the device with a
    // recovery code. For now, we just display the warning and halt.
    Print(L"\n  Recovery mode not implemented in this prototype.\n");
    Print(L"  The device will not boot until the lockdown is lifted.\n");

    // Halt the system
    while (TRUE) {
      gBS->Stall(1000000);  // 1 second
    }
  }
#endif

  //
  // For ACTIVATED state (or LOCKDOWN_DISPLAY_WARNING policy):
  // Display warning and wait 5 seconds before continuing
  //
  Print(L"  Waiting 5 seconds before continuing boot...\n");
  gBS->Stall(5000000);  // 5 seconds

  Print(L"  Continuing boot with lockdown active.\n");
  Print(L"  The OS-side agent will enforce additional restrictions.\n");

  return EFI_SUCCESS;
}
