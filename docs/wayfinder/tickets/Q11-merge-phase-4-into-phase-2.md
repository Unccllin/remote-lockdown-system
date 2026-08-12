# Q11: Implementation order

> **Label:** `wayfinder:grilling`
> **Status:** CLOSED
> **Resolved:** 2026-08-13 (grilling Round 2)

## Question

Should the phases be implemented in the order proposed (Phase 1 → 2 → 3 → 4),
or reordered?

## Resolution

**C — Merge Phase 4 into Phase 2.** 3 phases total:
- **Phase 1**: Safe Mode + Secure Boot + DMA + BCD hardening (always applied)
- **Phase 2**: HP Power-On Password + Sure Start "lock then seal" + Sure Admin
  report-blocked (PBA opt-in)
- **Phase 3**: BitLocker TPM+PIN (PBA opt-in, requires BitLocker already enabled)

## Rationale

The "lock then seal" pattern (Q2=A) must happen in the same BIOS lockdown flow
as setting the Power-On Password — they're not separable. If we do Phase 2
without the Sure Start handling, the Power-On Password could be reverted by
Sure Start on the next boot. Sure Admin handling (Q3=B, report blocked) is
already partially done by D-010.
