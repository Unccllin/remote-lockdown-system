# Session Capture — 2026-09-15 — sess-098

## Context
- Task: Consolidated Windows NT internals study note for PBL, covering ReactOS implementation reference, Microsoft documented behavior, boot sequence, PE/COFF, and pre-OS trust boundary
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- BCD stores boot config and dangerous load options (NOINTEGRITYCHECKS, TESTSIGNING, BOOTDEBUG); true BitLocker lock state is in FVE volume metadata, not BCD

## Mistakes / Corrections
Rule Zero session block was written after the file was drafted (continuation thread). Fix: start a formal SESSION-START/RULE-ZERO block before resuming continuation work

## Open Questions
- How to read BitLocker FVE metadata and PCR state from UEFI for true lock state?

## File References
- firmware/PblPkg/PblApp/Decision.c

## Optional Fields (applied to consolidated memories)
- evidence_sources: file:/tmp/reactos/ntoskrnl/ke/i386/traphdlr.c:1719-1798, file:/tmp/reactos/ntoskrnl/ex/init.c:928-2054, file:/tmp/reactos/sdk/lib/rtl/image.c:474-533, file:/tmp/reactos/sdk/include/ddk/ntimage.h:208-225,340-410,475-489, url:https://learn.microsoft.com/en-us/windows-hardware/drivers/gettingstarted/user-mode-and-kernel-mode, url:https://learn.microsoft.com/en-us/windows-hardware/drivers/kernel/previousmode, url:https://learn.microsoft.com/en-us/windows/win32/debug/pe-format, url:https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/device-guard-and-credential-guard
- impact: PBL E-BCD / E-ENCRYPT enforcement paths and D-120 (BitLocker), D-213 (loaded image count), D-214/D-218 (chain-load hash)
- response: Continue with real Windows boot manager chain-load test in QEMU and implement FVE volume/PCR BitLocker state detection
