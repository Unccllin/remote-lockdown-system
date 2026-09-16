# Session Capture — 2026-09-16 — sess-101

## Context
- Task: Study conference talks on firmware security (Source 8)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Searched and fetched public conference abstracts and slide-extracted text.
- Wrote consolidated conference-talk study note.
- Closed session and captured memory.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- Matrosov Black Hat Asia 2017 / OffensiveCon 2018: UEFI rootkit chain user->kernel->SMM->SPI; SMM/SPI often left open; Boot Guard/BIOS Guard/ACM have weaknesses.
- ThunderStrike 2: first Mac firmware worm; Speed Racer, Darth Venamis, PrinceHarming/Snorlax, unsigned Option ROMs; EDK2/EFI vulns portable across OS/hardware.
- Haukli Black Hat 2014: BIOS emulation, function pointer/inline hook detection, heuristic bootkit detection.
- Bulygin Black Hat 2013/2017: bypassing Windows 8 Secure Boot; Vault 7 Mac EFI implants; S3/Option ROM reinfection; efi-whitelist (2M hashes).
- Korchok Wakulich REcon 2024 GOP Complex: LogoFAIL image parsers, EBC, PCI Option ROM hacking, cross-architecture UEFI shellcode.
- Haruyama REcon 2022: SMM rootkits can MitM firmware acquisition from OS.
- CanSecWest 2014/2017: history of UEFI bootkits, CHIPSEC framework, S3 resume script/SMM/SPI checks.
- UEFI Forum plugfests: threat classes (buffer overflow, SMM injection, variable tampering, SMRAM disclosure, DoS, key mgmt) and secure patching best practices.
- Binarly UEFI 2025: BYOVD taxonomy (5 classes, 7,157 trusted modules); supply-chain key failures (PKfail, PPAM, inconsistent dbx).
- PBL relevance: SpiProtections/S3/MOR/DMA checks, bootmgr_hash/BCD, db/dbx expectations, MOK/SBAT, policy update channel.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-FIRMWARE-SECURITY-TALKS.md
- docs/research/STUDY-ACADEMIC-FIRMWARE-SECURITY.md
- docs/research/STUDY-UEFI-BOOTKITS.md
- docs/research/STUDY-INTEL-PLATFORM-SECURITY.md
- firmware/PblPkg/PblApp/SpiProtections.c
- firmware/PblPkg/PblApp/Decision.c
- firmware/PblPkg/PblApp/ChainLoad.c
- firmware/PblPkg/PblApp/PlatformState.c

## Optional Fields (applied to consolidated memories)
- evidence_sources: conference:Black Hat Asia 2017 UEFI Firmware Rootkits, conference:OffensiveCon 2018 Betraying the BIOS, conference:Black Hat USA 2014 Exposing Bootkits with BIOS Emulation, conference:Black Hat USA 2017 Fractured Backbone, conference:Black Hat USA 2013 Secure Boot bypass, conference:DEF CON 23 ThunderStrike 2, conference:REcon 2024 GOP Complex, conference:REcon 2022 Anti-Firmware Forensics, conference:CanSecWest 2014/2017 CHIPSEC, conference:UEFI Forum plugfest security best practices, conference:UEFI 2025 BYOVD and key management
- impact: PBL platform-state checks, policy/verdict update channel, detection design
- response: Next: Research blogs and EDK II implementation pitfalls (Source 9)
