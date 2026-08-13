# T5: Phase 1 — BitLocker suspension for BIOS changes

> **Label:** `wayfinder:task`
> **Status:** CLOSED (2026-08-14)
> **Blocks:** none
> **Blocked by:** none
> **Implements:** Q8

## Question

Extend the D-008 BitLocker suspension pattern to cover BIOS setting changes
in `hp_uefi_lockdown.py`, not just BCD changes in `bcd_lockdown.py`.

## Work

1. Add `_check_bitlocker()`, `_suspend_bitlocker()`, `_resume_bitlocker()`
   functions to `agent/hp_uefi_lockdown.py` (or import from a shared utility).
   These mirror the functions in `bcd_lockdown.py` but operate in the HP
   lockdown context.
2. In `apply_boot_lockdown()`, call `_check_bitlocker()` before BIOS changes.
   If enabled, suspend protectors before BIOS edits, resume after (both
   success and rollback paths).
3. In `remove_boot_lockdown()`, suspend before restoring BIOS settings,
   resume after.
4. Include `bitlocker_status` in the HP lockdown result dict.
5. Add to dry-run state.
6. Write tests (mocked manage-bde calls).

**Design decision:** Should these functions be shared (DRY) or duplicated?
The functions in `bcd_lockdown.py` use `bcd_lockdown._run()` which wraps
`subprocess.run`. The HP module uses `_run_powershell()`. The BitLocker
functions call `manage-bde` which is a command-line tool, not PowerShell.
Best approach: duplicate the functions in `hp_uefi_lockdown.py` using a
local `_run_cmd()` helper (or reuse `subprocess.run` directly), since the
two modules have different command execution patterns. The duplication is
small (3 functions, ~40 lines) and avoids cross-module coupling.

## Files to edit

- `agent/hp_uefi_lockdown.py` (add BitLocker check/suspend/resume, call in
  apply_boot_lockdown and remove_boot_lockdown)
- `agent/tests/test_boot_lockdown.py` (add tests for BitLocker suspension in
  HP lockdown context)

## Acceptance

- `apply_boot_lockdown()` suspends BitLocker before BIOS changes, resumes after.
- `remove_boot_lockdown()` suspends before BIOS restore, resumes after.
- Result dict includes `bitlocker_status`.
- Tests pass (mocked). Ruff clean.
