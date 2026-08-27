/*
 * AntiTheftAgent.h — Integrated Anti-Theft Firmware Agent
 *
 * This is the production firmware agent that combines all prototypes:
 * - NVRAM variable management (AgentState, AgentInstalled, etc.)
 * - Network initialization + HTTP check-in
 * - NTFS marker file reading
 * - Lockdown enforcement
 * - Capsule-deliverable (flashed to SPI firmware volume)
 *
 * The agent runs as a DXE driver, executing before the OS on every boot.
 */

#ifndef _ANTI_THEFT_AGENT_H_
#define _ANTI_THEFT_AGENT_H_

#include <Uefi.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/BaseLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/PrintLib.h>
#include <Library/DebugLib.h>

//
// Anti-Theft GUID: {A1B2C3D4-E5F6-4789-ABCDEF0123456789}
//
#define ANTITHEFT_GUID \
  { 0xA1B2C3D4, 0xE5F6, 0x4789, { 0xAB, 0xCD, 0xEF, 0x01, 0x23, 0x45, 0x67, 0x89 } }

extern EFI_GUID gAntiTheftGuid;

//
// Agent states (stored in AgentState NVRAM variable)
//
#define AGENT_STATE_DORMANT    0   // Not yet activated — normal operation
#define AGENT_STATE_ACTIVATED  1   // Server marked device as stolen — enforce lockdown
#define AGENT_STATE_LOCKED     2   // Lockdown fully enforced — device locked
#define AGENT_STATE_RECOVERED  3   // Device recovered — lockdown lifted

//
// Agent version
//
#define AGENT_VERSION_MAJOR  1
#define AGENT_VERSION_MINOR  0
#define AGENT_VERSION        ((AGENT_VERSION_MAJOR << 8) | AGENT_VERSION_MINOR)

//
// NVRAM variable names
//
#define VAR_AGENT_STATE       L"AgentState"
#define VAR_AGENT_INSTALLED   L"AgentInstalled"
#define VAR_AGENT_VERSION     L"AgentVersion"
#define VAR_LAST_CHECKIN      L"LastCheckIn"
#define VAR_SERVER_RESPONSE   L"ServerResponse"
#define VAR_LOCKDOWN_REASON   L"LockdownReason"

//
// NVRAM variable attributes
//
#define ANTITHEFT_VAR_ATTRS  (EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS | EFI_VARIABLE_RUNTIME_ACCESS)

//
// Check-in server configuration
//
#define CHECKIN_HOST          L"192.168.1.100"
#define CHECKIN_PORT          8080
#define CHECKIN_PATH          L"/api/agent/checkin"
#define CHECKIN_TIMEOUT_MS    5000

//
// Lockdown policy
//
#define LOCKDOWN_DISPLAY_WARNING  1   // Show warning on screen
#define LOCKDOWN_BLOCK_BOOT       2   // Block OS boot entirely
#define LOCKDOWN_POLICY           LOCKDOWN_DISPLAY_WARNING

//
// Function prototypes
//

// nvram.c
EFI_STATUS
GetAgentState (
  OUT UINT8  *State
  );

EFI_STATUS
SetAgentState (
  IN UINT8   State
  );

EFI_STATUS
SetAgentInstalled (
  VOID
  );

EFI_STATUS
SetAgentVersion (
  VOID
  );

EFI_STATUS
GetLastCheckIn (
  OUT UINT32  *Timestamp
  );

EFI_STATUS
SetLastCheckIn (
  IN UINT32   Timestamp
  );

// network.c
EFI_STATUS
NetworkCheckIn (
  OUT CHAR16  *Response,
  IN  UINTN   ResponseSize
  );

// ntfs.c
EFI_STATUS
ReadNtfsMarker (
  OUT CHAR16  *MarkerData,
  IN  UINTN   MarkerSize
  );

// lockdown.c
EFI_STATUS
EnforceLockdown (
  IN UINT8  AgentState
  );

// tpm.c
EFI_STATUS
CheckTpmAvailable (
  OUT BOOLEAN  *Available
  );

// dns_tunnel.c
EFI_STATUS
DnsTunnelCheckIn (
  IN  CONST CHAR8  *DeviceData,
  OUT CHAR16        *Response,
  IN  UINTN         ResponseSize
  );

#endif // _ANTI_THEFT_AGENT_H_
