# NG-T4: Variable hardening — fix MOR GUID bug + apply NG-R2 per-variable spec

> **Label:** `wayfinder:task` (AFK-able, follows firmware session lifecycle)
> **Status:** OPEN
> **Blocks:** closes finding F2 (partial — PblBootmgrSvn piece folds into
> the SVN-from-cert-table work)
> **Blocked by:** none (NG-R2 resolved; spec at
> `docs/research/NOTE-PBL-VAR-AUTH.md`)

## Question

Implement the NG-R2 resolution: fix the latent MOR GUID bug (a functional
defect independent of F2), harden PBL's shell-writable variables per the
per-variable spec, and treat remaining unauthenticated vars as
advisory-only in `Decision.c`.

## Work

1. **MOR GUID bug (prerequisite fix).** `Mor.c` and `PlatformState.c` use
   `EFI_GLOBAL_VARIABLE` for `MemoryOverwriteRequestControl`; the spec GUID
   is `gEfiMemoryOverwriteControlDataGuid`
   (`e20939be-32d4-41be-a150-897f85d49829`, `MdePkg.dec`). Fix the GUID so
   the MOR write actually reaches the platform's TcgMor handler. Also fix
   the wrong "bit 1 = lock" comment — the lock is the separate
   `MemoryOverwriteRequestControlLock` variable.
2. **`PblLockMor()`** — write `0x01` to `MemoryOverwriteRequestControlLock`
   (spec's own mechanism: locked until reboot, OS-compatible).
3. **`PblMarkerTest`** — keep unauthenticated (diagnostic-only, per NG-R2).
   If a "PBL ran" canary is desired, extend a marker into PCR 13 instead.
4. **`PblBootmgrSvn`** — treat variable read as advisory-only; the real
   fix (parse SVN from `bootmgfw.efi` Authenticode cert table + SVN floor
   in `policy.cose`) is a separate capability — note it as such, don't
   implement here.
5. **Readers check the TBA attribute bit** on `GetVariable` and treat
   absent/non-TBA variables as untrusted (deletion caveat — unsigned delete
   allowed under `UserPhysicalPresent()`).

## Verify

- QEMU harness: serial output shows MOR written under the correct GUID and
  `MemoryOverwriteRequestControlLock` set.
- `make graph-check` green; session-close per AGENTS.md.

## Resolution

Record QEMU evidence. Graduate nothing — this ticket *is* the graduated
fix; F2's remaining piece (PblBootmgrSvn-from-cert-table) is a capability
candidate inside NG-Q1's cut.
