# Session Capture — 2026-11-26 — sess-346

## Context
- Task: Use the now-active MOLE to advance D-134 (TPM NV hierarchy), and find out what the remaining hardware step actually needs
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
- The D-134 ledger entry was stale in the most expensive way: its first bullet said PcdPblTpmUsePlatformHierarchy defaults to TRUE, while PblPkg.dec:76 says FALSE under a dated ruling comment. Both bugs the entry's own 0x149 matrix records were already fixed (OWNERREAD added, NV_Read by index handle, provisioning at -C o -a 0x02060004). Check a PCD default or an attribute constant in code before reasoning from the ledger.
- MOLE is HP EliteBook 830 G6, BIOS R70 01.36.00, serial 5CG0398GCN, UUID BE10009B-5867-337C-5024-E390E760DA74, Infineon TPM 2.0 7.85.4555.0 present/owned/activated, Secure Boot off, no EFI\PBL on the ESP: the machine D-134 names.
- D-134's remaining step is equipment-bound: this host has gcc but no build/nasm/iasl, there is no serial rig, and PblApp writes no log to disk, so the runbook's cat /dev/ttyUSB0 is the only capture route; and the boot needs a FAT32 USB stick (none available).
- MOLE SSH route: ssh -i ~/.ssh/lockdown_lab_ed25519 labadmin@192.168.1.249, run .ps1 files copied there (inline PowerShell quoting through cmd mangles ; and quotes).

## Mistakes / Corrections
- mistake: my first ledger edit asserted 'the firmware half is done, only the capture remains' before reading the 0x149 matrix, which records a second fallback bug that was also fixed; the anchor assertion failed and forced me to read the section - correct only the stale sentence, keep the investigation intact
- mistake: two string-anchor ledger edits failed on line wrapping before a line-based insert worked

## Open Questions
- <none recorded>

## File References
- docs/adr/PBL-DEBT-LEDGER.md
- docs/artifacts/s372-d134-mole-environment.txt

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
