# Q8: BitLocker suspension for BIOS changes

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

Should the agent extend the D-008 BitLocker suspension pattern to cover BIOS
setting changes (not just BCD changes)?

## Resolution

**A — Yes, suspend BitLocker before BIOS changes in hp_uefi_lockdown.py,
resume after.** Same pattern as D-008 for BCD.

## Rationale

The cost of an unnecessary suspension is negligible (a single `manage-bde`
call). The cost of NOT suspending when it's needed is a BitLocker recovery
prompt on the next boot — which, if PBA is enabled, means the machine is stuck
at a 48-digit recovery key prompt with no way for the agent to boot. That's a
brick. This is especially important once PBA is in play: a BitLocker recovery
prompt on a PBA-protected machine is catastrophic for remote management.
