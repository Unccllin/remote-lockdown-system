# Q6: Phase 1 hardening scope

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

Should Phase 1 hardening (Safe Mode + Secure Boot + DMA + BCD hardening) be
applied on every lockdown, or only when `enable_pba: true`?

## Resolution

**A — Always apply Phase 1 hardening on every lockdown.** These are pure
security improvements with no remote-recoverability trade-off.

## Rationale

Secure Boot verification just warns if it's off. VT-d enablement blocks DMA
attacks regardless of PBA. BCD hardening (timeout=0, etc.) is
defense-in-depth. There's no reason to withhold these from non-PBA lockdowns.
The `enable_pba` flag should only gate the things that actually break remote
recoverability (HP Power-On Password + BitLocker PIN).
