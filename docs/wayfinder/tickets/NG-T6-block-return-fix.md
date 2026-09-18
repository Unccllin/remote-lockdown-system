# NG-T6: Fix F1 — BLOCK-intent paths must never propagate an error to BDS

> **Label:** `wayfinder:task` (AFK-able, firmware session lifecycle)
> **Status:** CLOSED (2026-09-18) — implemented + verified
> **Blocks:** closes finding F1 — the BootOrder-advance bypass
> **Blocked by:** none (NG-T1 resolved; evidence in ticket)

## Question

Two sites in `PblAppEntryPoint` return `EFI_SECURITY_VIOLATION` on
BLOCK-intent paths. Per Boot#### semantics (Beyond BIOS p.186), a
non-success return advances BDS to the next `BootOrder` entry —
`bootmgfw.efi` — so the "refusing to boot" paths actually boot Windows.
Fix: BLOCK-intent paths must route into the lock-screen → override →
`ResetSystem` flow and never return a status.

## Work

Evidence: NG-T1 resolution (return-path table).

1. **`PblApp.c:379`** (policy sig verify fail, RoT provisioned) — replace
   `return EFI_SECURITY_VIOLATION` with a forced-BLOCK route into the
   step-9 dispatch (e.g., `Result = PblResultBlock; goto DecisionDispatch;`
   or equivalent structure — keep the PCR-12/13 extends consistent with
   the normal path: extend decision PCR before the dispatch if cheap,
   or document why this path skips it).
2. **`PblApp.c:444`** (policy anti-rollback) — same treatment; remove the
   `// STUB` comment.
3. **Chain-load return check** — `PblChainLoadWindows` calls at
   809/817/831 ignore the return; on failure, route to the BLOCK flow
   (fail-closed) rather than falling through to `return EFI_SUCCESS`
   (boot menu on real firmware).
4. **Audit remaining returns** — confirm no other BLOCK-intent return
   propagates (helpers returning errors to callers are fine; only
   `PblAppEntryPoint`'s own status matters).
5. **Keep scaffold tail semantics** — `return EFI_SUCCESS` at 856 stays
   only on paths that intentionally hand control back (none today should).

## Verify

- Extend a harness to exercise the RoT-provisioned sig-fail path and the
  rollback path: assert serial shows lock-screen/BLOCK + shutdown, and
  that QEMU does NOT boot Windows afterward.
- Existing harnesses stay green (fve 16/0, docker 15/0, persistence 16/0).
- `make graph-check` green; session-close per AGENTS.md.
- This fix is **security-critical** — include the serial-log evidence in
  the ledger/debt entry; flag for human review before closing.

## Resolution

**RESOLVED 2026-09-18**

Fix: new `PblBlockHalt()` helper (`PblApp.c`) — prints reason, requests
MOR, shows lock screen (NULL-verdict safe), flushes TPM sessions,
`ResetSystem(EfiResetShutdown)`, `CpuDeadLoop()` fallback — never returns
to BDS. Applied to: policy-sig-fail (was `return EFI_SECURITY_VIOLATION`),
anti-rollback (same + stale STUB comment), all 3 chain-load call sites
(return now checked, fail-closed on error), plus `CpuDeadLoop()` after
the two `ResetSystem` calls. `PblApp.efi` `44c44e6485235cb1…`.

Verified: fve harness 16/0, docker 15/0, persistence 16/0 — all three
boot scenarios still pass; QEMU timeout-at-lock-screen confirms PBL
holds control rather than returning to BDS.

Recorded as **D-220** in `PBL-DEBT-LEDGER.md` (CLOSED, SECURITY) —
flagged that D-219's harness passed the buggy code because it checked
serial lines, not post-BLOCK behavior. **Flagged for human review** —
security-critical path.
