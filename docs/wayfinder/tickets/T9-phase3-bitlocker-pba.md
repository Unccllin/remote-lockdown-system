# T9: Phase 3 — BitLocker TPM+PIN module

> **Label:** `wayfinder:task`
> **Status:** OPEN
> **Blocks:** T10
> **Blocked by:** T7, T8
> **Implements:** Q1, Q7, Q11

## Question

Implement the BitLocker TPM+PIN module that adds a PIN protector to an
existing BitLocker-encrypted drive and captures the 48-digit recovery
password.

## Work

1. Create `agent/bitlocker_pba.py`:
   - `check_bitlocker_status()` — query `Win32_EncryptableVolume` for C:,
     return encryption status, protector types.
   - `add_tpm_pin_protector(pin)` — call
     `ProtectKeyWithTPMAndPIN(name, profile, pin, &protectorID)` via WMI.
   - `get_recovery_password()` — enumerate protectors, find numerical
     password, return the 48-digit key.
   - `remove_tpm_pin_protector(protector_id)` — delete the TPM+PIN protector,
     ensure TPM-only protector exists.
   - `enable_pba(pin)` — orchestrator: check BitLocker on, check TPM protector
     exists, add PIN protector, capture recovery password, optionally delete
     TPM-only protector, return `{pin, recovery_password, protector_id}`.
   - `disable_pba(protector_id)` — delete TPM+PIN protector, re-add TPM-only.
2. In `agent/agent.py`, wire `enable_pba` flag to call `bitlocker_pba.enable_pba()`
   when BitLocker is detected.
3. Return `bitlocker_pin` + `bitlocker_recovery_password` in the ACK.
4. On `remove_boot_lockdown`, call `bitlocker_pba.disable_pba()`.
5. Handle the case where BitLocker is not enabled (Q7=A: fail with clear error).
6. Write tests (mocked WMI calls).

## Files to edit

- `agent/bitlocker_pba.py` (new module)
- `agent/agent.py` (wire enable_pba flag, include PBA credentials in ACK)
- `agent/tests/test_bitlocker_pba.py` (new test file)

## Acceptance

- `enable_pba()` adds TPM+PIN protector and captures recovery password.
- `disable_pba()` removes TPM+PIN, restores TPM-only.
- Fails clearly if BitLocker is not enabled.
- All tests pass (mocked). Ruff clean.
