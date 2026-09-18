# NG-T1: Verify F1 — does PBL's BLOCK path propagate an error that advances BootOrder?

> **Label:** `wayfinder:task` (AFK)
> **Status:** OPEN
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

Record the return-path table and the verdict (real-bug / by-design) with
file:line evidence. Graduate the fog: either a fix ticket (bug) or nothing
(by-design).
