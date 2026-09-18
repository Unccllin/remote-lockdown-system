# NG-T1: Verify F1 — does PBL's BLOCK path propagate an error that advances BootOrder?

> **Label:** `wayfinder:task` (AFK)
> **Status:** CLOSED (2026-09-18) — verdict: **REAL BUG**
> **Blocks:** the F1-fix ticket (fog — graduates on resolution)
> **Blocked by:** none

## Question

Beyond BIOS p.186 establishes that a `Boot####` option returning
`EFI_SUCCESS` *stops* BDS processing and shows a boot menu, while a
non-success return *advances* BDS to the next `BootOrder` entry — normally
`bootmgfw.efi`, i.e. Windows boots with no lock.

Inspect `firmware/PblPkg/PblApp/PblApp.c`, `Decision.c`, `LockScreen.c`,
`ChainLoad.c` and answer:

1. On the BLOCK path, does PBL ever `return` an `EFI_ERROR`/non-success
   status to BDS? Enumerate every return path and its status.
2. Does the lock screen loop forever (holding BDS), or does PBL exit after
   showing it?
3. On degraded/timeout/error paths (HTTPS fail, TPM fail, verdict parse
   fail), what status propagates?
4. Is there any path where PBL calls `ResetSystem()` / exits cleanly and
   relies on firmware behavior — what does that do in OVMF vs. typical
   vendor BDS?

## Work

- Read the four files; produce a return-path table (path → status →
  BDS-visible consequence).
- Check the QEMU harness serial logs for evidence of what actually happens
  post-BLOCK (does the machine hang, reboot, or proceed?).
- If a real propagating error exists: the finding is a bug → becomes a debt
  item + fix ticket. If BLOCK already holds control correctly: the finding
  is closed as by-design with the evidence.

## Resolution

**RESOLVED 2026-09-18 — verdict: REAL BUG (2 propagating sites + 1 gap)**

Return-path table (PblAppEntryPoint, `PblApp.c`):

| Path | Line | Status to BDS | Consequence |
|---|---|---|---|
| Policy sig verify fails (RoT provisioned) | 379 | `EFI_SECURITY_VIOLATION` | **BDS advances BootOrder → bootmgfw.efi boots** — "refusing to boot" actually boots Windows |
| Policy anti-rollback fail | 444 | `EFI_SECURITY_VIOLATION` | Same bypass; code even marked `// STUB: extend PCR + show lock screen` |
| `PblResultBlock` (switch) | 819–838 | never returns | Safe: lock screen → override → `ResetSystem(EfiResetShutdown)` or override-chain-load |
| `default:` unknown result | 840–844 | never returns | Safe: `ResetSystem(EfiResetShutdown)` |
| `PblChainLoadWindows` fails | 809/817/831 | return ignored → `EFI_SUCCESS` @856 | BDS stops → boot menu; user can select Windows manually on most firmware — lesser fail-open gap |
| Scaffold tail | 856 | `EFI_SUCCESS` | By design (dev scaffold comment) |

Notes:
- The two buggy returns are **invisible to current harnesses**: sig-verify only fires when the root of trust is provisioned (dev mode → `EFI_UNSUPPORTED` → skip); rollback needs NV counter > policy version. Same blind-spot class as the dead-TPM harness bug.
- Fix design: BLOCK-intent paths must not `return` — route them into the same lock-screen → override → `ResetSystem` flow as the switch's BLOCK case (e.g., set forced result + jump to step-9 dispatch), and check the chain-load return.

Graduated: **NG-T6 fix ticket** (both sites + chain-load-return check + a harness test that exercises the RoT-provisioned sig-fail path).
