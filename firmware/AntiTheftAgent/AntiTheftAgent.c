/*
 * AntiTheftAgent.c — Integrated Anti-Theft Firmware Agent (main entry point)
 *
 * This DXE driver runs on every boot before the OS loads. It:
 * 1. Marks itself as installed in NVRAM
 * 2. Reads the current agent state from NVRAM
 * 3. Initializes the network stack and performs HTTP check-in
 * 4. Reads NTFS marker files (if NTFS driver is loaded)
 * 5. Checks TPM availability
 * 6. Enforces lockdown if the device is marked as stolen
 *
 * The agent is delivered via UEFI capsule update and persists in SPI flash.
 * It survives OS reinstalls, disk wipes, and CMOS clears.
 */

#include "AntiTheftAgent.h"

EFI_GUID gAntiTheftGuid = ANTITHEFT_GUID;

EFI_STATUS
EFIAPI
AntiTheftAgentEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINT8       AgentState;
  CHAR16      ServerResponse[256];
  CHAR16      NtfsMarker[256];
  BOOLEAN     TpmAvailable;
  UINT32      CheckInTime;

  //
  // Banner
  //
  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft Firmware Agent\n");
  Print(L"  Version: %d.%d\n", AGENT_VERSION_MAJOR, AGENT_VERSION_MINOR);
  Print(L"  Delivered via: UEFI Capsule Update\n");
  Print(L"========================================\n");
  Print(L"\n");

  //
  // Step 1: Mark agent as installed in NVRAM
  //
  Print(L"[1/6] Marking agent as installed in NVRAM...\n");
  Status = SetAgentInstalled();
  if (EFI_ERROR(Status)) {
    Print(L"  [WARN] Failed to set AgentInstalled: %r\n", Status);
  } else {
    Print(L"  [OK] AgentInstalled = 1\n");
  }

  Status = SetAgentVersion();
  if (EFI_ERROR(Status)) {
    Print(L"  [WARN] Failed to set AgentVersion: %r\n", Status);
  } else {
    Print(L"  [OK] AgentVersion = 0x%04x\n", AGENT_VERSION);
  }

  //
  // Step 2: Read current agent state
  //
  Print(L"\n[2/6] Reading agent state from NVRAM...\n");
  Status = GetAgentState(&AgentState);
  if (EFI_ERROR(Status)) {
    Print(L"  [INFO] AgentState not found — creating as DORMANT\n");
    AgentState = AGENT_STATE_DORMANT;
    SetAgentState(AgentState);
  }

  switch (AgentState) {
    case AGENT_STATE_DORMANT:
      Print(L"  [OK] AgentState: DORMANT (0) — normal operation\n");
      break;
    case AGENT_STATE_ACTIVATED:
      Print(L"  [OK] AgentState: ACTIVATED (1) — LOCKDOWN ACTIVE\n");
      break;
    case AGENT_STATE_LOCKED:
      Print(L"  [OK] AgentState: LOCKED (2) — DEVICE LOCKED\n");
      break;
    case AGENT_STATE_RECOVERED:
      Print(L"  [OK] AgentState: RECOVERED (3) — lockdown lifted\n");
      break;
    default:
      Print(L"  [WARN] AgentState: unknown (%d)\n", AgentState);
      break;
  }

  //
  // Step 3: Network check-in (HTTP first, DNS tunnel fallback)
  //
  Print(L"\n[3/6] Performing network check-in...\n");
  ZeroMem(ServerResponse, sizeof(ServerResponse));
  Status = NetworkCheckIn(ServerResponse, sizeof(ServerResponse));
  if (EFI_ERROR(Status)) {
    Print(L"  [INFO] HTTP check-in failed: %r\n", Status);
    Print(L"  [INFO] Falling back to DNS tunnel...\n");

    // DNS tunnel fallback — encode device data and send as DNS TXT query
    CHAR8 DeviceData[64];
    AsciiSPrint(DeviceData, sizeof(DeviceData), "id=AT-DEV&st=%d", AgentState);
    ZeroMem(ServerResponse, sizeof(ServerResponse));
    Status = DnsTunnelCheckIn(DeviceData, ServerResponse, sizeof(ServerResponse));
    if (EFI_ERROR(Status)) {
      Print(L"  [INFO] DNS tunnel also failed: %r\n", Status);
      Print(L"  (Network may not be available in DXE phase)\n");
    } else {
      Print(L"  [OK] DNS tunnel response: %s\n", ServerResponse);
    }
  } else {
    Print(L"  [OK] HTTP server response: %s\n", ServerResponse);
  }

  // Parse server response (from either HTTP or DNS tunnel)
  if (ServerResponse[0] != L'\0') {
    if (StrCmp(ServerResponse, L"ACTIVATE") == 0) {
      Print(L"  [ALERT] Server says: ACTIVATE — marking device as stolen\n");
      SetAgentState(AGENT_STATE_ACTIVATED);
      AgentState = AGENT_STATE_ACTIVATED;
    } else if (StrCmp(ServerResponse, L"RECOVER") == 0) {
      Print(L"  [OK] Server says: RECOVER — lifting lockdown\n");
      SetAgentState(AGENT_STATE_RECOVERED);
      AgentState = AGENT_STATE_RECOVERED;
    } else if (StrCmp(ServerResponse, L"ACK") == 0) {
      Print(L"  [OK] Server says: ACK — state confirmed\n");
    }

    // Record check-in time
    CheckInTime = (UINT32)(AsmReadTsc() >> 20);  // Approximate timestamp
    SetLastCheckIn(CheckInTime);
  }

  //
  // Step 4: Read NTFS marker file (if NTFS driver is loaded)
  //
  Print(L"\n[4/6] Checking NTFS marker file...\n");
  ZeroMem(NtfsMarker, sizeof(NtfsMarker));
  Status = ReadNtfsMarker(NtfsMarker, sizeof(NtfsMarker));
  if (EFI_ERROR(Status)) {
    Print(L"  [INFO] NTFS marker not available: %r\n", Status);
    Print(L"  (NTFS driver may not be loaded, or no NTFS volume present)\n");
  } else {
    Print(L"  [OK] NTFS marker: %s\n", NtfsMarker);
  }

  //
  // Step 5: Check TPM availability
  //
  Print(L"\n[5/6] Checking TPM availability...\n");
  Status = CheckTpmAvailable(&TpmAvailable);
  if (EFI_ERROR(Status)) {
    Print(L"  [INFO] TPM check failed: %r\n", Status);
  } else if (TpmAvailable) {
    Print(L"  [OK] TPM 2.0 available — can use for key sealing\n");
  } else {
    Print(L"  [INFO] TPM not available — key sealing disabled\n");
  }

  //
  // Step 6: Enforce lockdown if activated
  //
  Print(L"\n[6/6] Evaluating lockdown policy...\n");
  if (AgentState == AGENT_STATE_ACTIVATED || AgentState == AGENT_STATE_LOCKED) {
    Print(L"  [LOCKDOWN] Device is marked stolen — enforcing lockdown\n");
    Status = EnforceLockdown(AgentState);
    if (EFI_ERROR(Status)) {
      Print(L"  [WARN] Lockdown enforcement returned: %r\n", Status);
    }
  } else {
    Print(L"  [OK] No lockdown required — normal boot continues\n");
  }

  //
  // Summary
  //
  Print(L"\n========================================\n");
  Print(L"  Anti-Theft Agent initialization complete\n");
  Print(L"  State: %d | Check-in: %r | NTFS: %r | TPM: %s\n",
    AgentState,
    EFI_ERROR(Status) ? L"FAIL" : L"OK",
    EFI_ERROR(Status) ? L"N/A" : L"OK",
    TpmAvailable ? L"YES" : L"NO"
  );
  Print(L"========================================\n");

  return EFI_SUCCESS;
}
