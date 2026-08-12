# T7: Phase 2 — HP Power-On Password + Sure Start lock-then-seal

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** T9 (Phase 3 start)
> **Blocked by:** T6 (Phase 1 complete)
> **Implements:** Q1, Q2, Q3, Q11

## Question

Implement HP Power-On Password (Tier 1 PBA), Sure Start "lock then seal"
pattern, and Sure Admin "report blocked" adaptive action.

## Work

### HP Power-On Password (Tier 1 PBA)
1. Add a `set_power_on_password(password, setup_password)` function to
   `agent/hp_uefi_lockdown.py` that calls
   `SetBIOSSetting("Power-On Password", "<utf-16/>"+password,
   "<utf-16/>"+setup_password)`.
2. Add a `clear_power_on_password(setup_password)` function.
3. Add a `_is_power_on_password_supported()` function that enumerates
   `HP_BIOSPassword` instances and checks for "Power-On Password".
4. In `apply_boot_lockdown()`, when `enable_pba=True` is passed, set the
   Power-On Password after the Setup Password. Return it in the result dict
   as `power_on_password`.
5. In `remove_boot_lockdown()`, when PBA was active, clear the Power-On
   Password.
6. Handle return code 1 (Not Supported) gracefully.

### Sure Start "lock then seal"
1. Add `_check_sure_start_bsp()` — check if "Sure Start BIOS Settings
   Protection" is enabled.
2. Add `_disable_sure_start_bsp(setup_password)` and
   `_enable_sure_start_bsp(setup_password)`.
3. In `apply_boot_lockdown()`, if BSP is enabled: disable it before BIOS
   changes, re-enable after all lockdown settings are applied.
4. Include `sure_start_bsp_status` in the result dict.

### Sure Admin "report blocked"
1. Extend `_check_sure_admin()` to check if Sure Admin / EBAM is enabled
   (already partially done by D-010).
2. If Sure Admin is enabled, set `bios_lockdown_blocked: True` in the result
   dict and skip BIOS changes (don't attempt SetBIOSSetting).
3. Include a clear warning message.

### Tests
1. Test Power-On Password set/clear/supported.
2. Test Sure Start BSP disable/enable/lock-then-seal flow.
3. Test Sure Admin blocks BIOS changes.
4. Test `enable_pba=True` flag triggers Power-On Password.
5. Test `enable_pba=False` (default) does NOT set Power-On Password.

## Files to edit

- `agent/hp_uefi_lockdown.py` (Power-On Password, Sure Start BSP, Sure Admin
  adaptive action, enable_pba parameter)
- `agent/tests/test_boot_lockdown.py` (all new tests)

## Acceptance

- Power-On Password is set when `enable_pba=True`, cleared on remove.
- Sure Start BSP is disabled before lockdown, re-enabled after.
- Sure Admin blocks BIOS changes with clear warning.
- `enable_pba=False` (default) does not set Power-On Password.
- All tests pass (mocked). Ruff clean.
