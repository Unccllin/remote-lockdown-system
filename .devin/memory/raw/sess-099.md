# Session Capture — 2026-09-15 — sess-099

## Context
- Task: Study UEFI bootkit case studies: LoJax, MosaicRegressor, MoonBounce, CosmicStrand, BlackLotus, LogoFAIL (Source 6)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Downloaded and text-extracted five public bootkit reports.
- Inspected PBL chain-load, platform-state, and decision code.
- Wrote consolidated defensive case-study note.
- Closed session and captured memory.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- LoJax (2018, APT28/Sednit): first in-the-wild UEFI rootkit; trojanized LoJack; SPI flash DXE driver SecDxe; READY_TO_BOOT callback; modifies BootExecute.
- MosaicRegressor (2020): reused Hacking Team VectorEDK; four UEFI modules; drops IntelUpdate.exe in Startup folder.
- MoonBounce (2022, APT41): patches CORE_DXE; hooks EFI_BOOT_SERVICES (AllocatePool, CreateEventEx, ExitBootServices); in-memory chain to kernel and svchost.exe.
- CosmicStrand (2022): Gigabyte/ASUS H81 firmware; hook chain through boot manager, winload.efi, ntoskrnl.exe ZwCreateSection; C2 payload.
- BlackLotus (2023): ESP-resident; exploits CVE-2022-21894 (Baton Drop) with vulnerable signed binaries; enrolls attacker MOK; bypasses Secure Boot on Windows 11.
- LogoFAIL/Bootkitty: UEFI image-parser vulnerabilities in boot logos; first Linux UEFI bootkit PoC.
- PBL mitigations: bootmgr_hash (C4 key 58), loaded image count, SPI protection checks, BCD dangerous-element parsing, PCR 12/13 attestation, fail-closed policy/verdict signatures.
- Source gap: Binarly site JS-only; web-fetched Binarly/ESET pages used for LogoFAIL/Bootkitty.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-UEFI-BOOTKITS.md
- /tmp/bootkit-docs/lojax.txt
- /tmp/bootkit-docs/moonbounce.txt
- /tmp/bootkit-docs/mosaicregressor.txt
- /tmp/bootkit-docs/cosmicstrand.txt
- /tmp/bootkit-docs/blacklotus_eset.txt
- firmware/PblPkg/PblApp/ChainLoad.c
- firmware/PblPkg/PblApp/PlatformState.c
- firmware/PblPkg/PblApp/SpiProtections.c
- docs/adr/PBL-C4-Policy-Blob.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: report:ESET LoJax white paper, report:Kaspersky MoonBounce technical details, report:Kaspersky MosaicRegressor/CosmicStrand, report:ESET BlackLotus analysis, report:Binarly LogoFAIL advisories, report:ESET Bootkitty analysis
- impact: PBL threat model for chain-load, Secure Boot, SPI, BCD, loaded-image enumeration, PCR attestation
- response: Next: Academic papers on UEFI bootkits / firmware persistence / TPM attestation (Source 7)
