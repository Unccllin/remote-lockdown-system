# T1: Phase 1 — SafeBoot registry entries at install time

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-14)
> **Blocks:** none
> **Blocked by:** none
> **Implements:** Q5

## Question

Add the agent service to Windows SafeBoot registry groups at install time so
the agent starts in Safe Mode.

## Work

1. Edit `agent/platform/windows/install-service-enhanced.ps1` to add registry
   entries under `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal` and
   `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Network` for the
   `LockdownAgent` service.
2. The registry value name is the service name; the value is "Service".
3. Add a corresponding removal in the uninstall script (if one exists).
4. Write a test that verifies the registry entries are created (mock the
   PowerShell registry calls).

## Files to edit

- `agent/platform/windows/install-service-enhanced.ps1` (add SafeBoot registry
  entries after service install)
- `agent/tests/test_boot_lockdown.py` (add test for SafeBoot registry logic)

## Acceptance

- Install script creates SafeBoot\Minimal and SafeBoot\Network entries for the
  agent service.
- Test passes (mocked).
- Ruff clean.
