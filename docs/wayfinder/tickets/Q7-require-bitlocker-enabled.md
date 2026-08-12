# Q7: BitLocker dependency

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

Should Tier 2 PBA (BitLocker TPM+PIN) require BitLocker to already be enabled,
or should the agent enable it if it's off?

## Resolution

**A — Require BitLocker already enabled.** If it's off, Tier 2 PBA fails with
a clear error. Agent doesn't enable BitLocker.

## Rationale

Enabling BitLocker is a separate infrastructure decision (GPO, AD backup, TPM
provisioning) that shouldn't be automated by a lockdown agent. If BitLocker is
off, Tier 2 PBA is simply not available — the operator gets Tier 1 (HP
Power-On Password) only. This keeps the agent's scope narrow and avoids
multi-hour encryption operations during a lockdown emergency.
