# T2: Phase 1 — Secure Boot verification via HP WMI

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** none
> **Blocked by:** none
> **Implements:** Q6

## Question

Add Secure Boot status verification to the HP UEFI lockdown — query Secure
Boot state via HP WMI and warn if disabled.

## Work

1. Add a `_check_secure_boot()` function to `agent/hp_uefi_lockdown.py` that
   queries the "Secure Boot" or "Configure Legacy Support and Secure Boot"
   setting via `HP_BIOSEnumeration`.
2. Include `secure_boot_status` in the `apply_boot_lockdown()` result dict:
   `{enabled: bool, warning: str | None}`.
3. If Secure Boot is disabled, log a warning and include it in the result.
4. Add "Secure Boot" to the dry-run BIOS state.
5. Write tests (mocked WMI calls).

## Files to edit

- `agent/hp_uefi_lockdown.py` (add `_check_secure_boot`, call it in
  `apply_boot_lockdown`, include in result dict)
- `agent/tests/test_boot_lockdown.py` (add tests for Secure Boot verification)

## Acceptance

- `_check_secure_boot()` queries WMI and returns enabled/warning.
- `apply_boot_lockdown()` result includes `secure_boot_status`.
- Dry-run mode simulates Secure Boot enabled.
- Tests pass (mocked). Ruff clean.
