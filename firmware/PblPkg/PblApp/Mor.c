/** @file
  Mor.c — REQ-07: Memory Overwrite Request (MOR) control.

  Sets the MOR bit in the MemoryOverwriteRequestControl UEFI variable to
  request that firmware clears memory on the next boot. This is a security
  measure to prevent cold-boot attacks from recovering sensitive data.

  Per TCG Platform Reset Attack Mitigation Specification, the variable lives
  under gEfiMemoryOverwriteControlDataGuid
  (e20939be-32d4-41be-a150-897f85d49829) — NOT EFI_GLOBAL_VARIABLE. Writing
  under the wrong GUID creates a decoy variable the platform's TcgMor
  handler never reads (this was the D-220-era latent bug: the MOR write
  was a no-op).

  Variable byte layout (MemoryOverwriteControl.h):
    Bit 0 (0x01) — ClearMemory: firmware MUST clear memory on next boot.
    Bit 4 (0x10) — DisableAutoDetect: firmware MUST NOT autodetect a clean
                   shutdown of the Static RTM OS.
  There is no lock bit in this variable. Locking is a separate variable,
  MemoryOverwriteRequestControlLock (see PblLockMor).

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// MOR control variable name (lives under gEfiMemoryOverwriteControlDataGuid)
#define MOR_VARIABLE_NAME  L"MemoryOverwriteRequestControl"

// MOR lock variable name (lives under gEfiMemoryOverwriteRequestControlLockGuid)
#define MOR_LOCK_VARIABLE_NAME  L"MemoryOverwriteRequestControlLock"

// MOR bit definitions (per spec byte layout)
#define MOR_BIT_CLEAR  0x01  // Bit 0: request memory clear on next boot
#define MOR_BIT_DISABLE_AUTODETECT  0x10  // Bit 4: no clean-shutdown autodetect

// Lock values (MemoryOverwriteRequestControlLock.h)
#define MOR_LOCK_LOCKED_NO_KEY  0x01  // locked without key (until reboot)

/** REQ-07: Set the Memory Overwrite Request (MOR) bit.

  Sets bit 0 of the MemoryOverwriteRequestControl UEFI variable to request
  that firmware clears volatile memory on the next boot. Called when PBL
  decides to block boot or when a security violation is detected.

  @retval EFI_SUCCESS           MOR bit set.
  @retval EFI_DEVICE_ERROR      Failed to set MOR variable.
**/
EFI_STATUS
PblRequestMor (
  VOID
  )
{
  UINT8       MorControl;
  UINTN       Size;
  EFI_STATUS  Status;

  // Read current MOR value under the spec GUID
  MorControl = 0;
  Size = sizeof (MorControl);
  Status = gRT->GetVariable (
    MOR_VARIABLE_NAME,
    &gEfiMemoryOverwriteControlDataGuid,
    NULL,
    &Size,
    &MorControl
    );

  // If the variable doesn't exist, start with 0
  if (EFI_ERROR (Status)) {
    MorControl = 0;
  }

  // Set the MOR clear bit
  MorControl |= MOR_BIT_CLEAR;

  // Write it back under the spec GUID — this is what TcgMor reads
  Status = gRT->SetVariable (
    MOR_VARIABLE_NAME,
    &gEfiMemoryOverwriteControlDataGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof (MorControl),
    &MorControl
    );

  if (EFI_ERROR (Status)) {
    Print (L"  [MOR] SetVariable failed: %r\n", Status);
    return EFI_DEVICE_ERROR;
  }

  Print (L"  [MOR] MemoryOverwriteRequestControl set (spec GUID)\n");
  return EFI_SUCCESS;
}

/** Lock the MOR variable so the OS cannot clear it before reboot.

  Writes 0x01 to MemoryOverwriteRequestControlLock under
  gEfiMemoryOverwriteRequestControlLockGuid
  (BB983CCF-151D-40E1-A07B-4A17BE168292). Per Microsoft Secure MOR:
  the lock is volatile state (does not commit to flash); once set, the
  MOR variable is locked until the next reboot and cannot be cleared or
  modified — even by the OS or a pre-OS attacker.

  @retval EFI_SUCCESS           MOR locked.
  @retval EFI_DEVICE_ERROR      Failed to set the lock variable.
**/
EFI_STATUS
PblLockMor (
  VOID
  )
{
  UINT8       LockValue = MOR_LOCK_LOCKED_NO_KEY;
  EFI_STATUS  Status;

  Status = gRT->SetVariable (
    MOR_LOCK_VARIABLE_NAME,
    &gEfiMemoryOverwriteRequestControlLockGuid,
    EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS,
    sizeof (LockValue),
    &LockValue
    );

  if (EFI_ERROR (Status)) {
    // Non-fatal: platform may not implement MOR lock (older firmware).
    Print (L"  [MOR] Lock not supported: %r\n", Status);
    return EFI_DEVICE_ERROR;
  }

  Print (L"  [MOR] MemoryOverwriteRequestControlLock set\n");
  return EFI_SUCCESS;
}
