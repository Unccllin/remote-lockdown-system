/*
 * nvram.c — NVRAM variable management for Anti-Theft Agent
 *
 * All agent state is stored in UEFI NVRAM variables with the AntiTheft GUID.
 * These variables persist across reboots, OS reinstalls, and disk replacements.
 */

#include "AntiTheftAgent.h"

extern EFI_GUID gAntiTheftGuid;

EFI_STATUS
GetAgentState (
  OUT UINT8  *State
  )
{
  EFI_STATUS  Status;
  UINTN       DataSize;
  UINT32      Attributes;

  DataSize = sizeof(UINT8);
  Status = gRT->GetVariable(
    VAR_AGENT_STATE,
    &gAntiTheftGuid,
    &Attributes,
    &DataSize,
    State
  );

  return Status;
}

EFI_STATUS
SetAgentState (
  IN UINT8   State
  )
{
  return gRT->SetVariable(
    VAR_AGENT_STATE,
    &gAntiTheftGuid,
    ANTITHEFT_VAR_ATTRS,
    sizeof(UINT8),
    &State
  );
}

EFI_STATUS
SetAgentInstalled (
  VOID
  )
{
  UINT8 Installed = 1;
  return gRT->SetVariable(
    VAR_AGENT_INSTALLED,
    &gAntiTheftGuid,
    ANTITHEFT_VAR_ATTRS,
    sizeof(UINT8),
    &Installed
  );
}

EFI_STATUS
SetAgentVersion (
  VOID
  )
{
  UINT16 Version = AGENT_VERSION;
  return gRT->SetVariable(
    VAR_AGENT_VERSION,
    &gAntiTheftGuid,
    ANTITHEFT_VAR_ATTRS,
    sizeof(UINT16),
    &Version
  );
}

EFI_STATUS
GetLastCheckIn (
  OUT UINT32  *Timestamp
  )
{
  EFI_STATUS  Status;
  UINTN       DataSize;
  UINT32      Attributes;

  DataSize = sizeof(UINT32);
  Status = gRT->GetVariable(
    VAR_LAST_CHECKIN,
    &gAntiTheftGuid,
    &Attributes,
    &DataSize,
    Timestamp
  );

  return Status;
}

EFI_STATUS
SetLastCheckIn (
  IN UINT32   Timestamp
  )
{
  return gRT->SetVariable(
    VAR_LAST_CHECKIN,
    &gAntiTheftGuid,
    ANTITHEFT_VAR_ATTRS,
    sizeof(UINT32),
    &Timestamp
  );
}
