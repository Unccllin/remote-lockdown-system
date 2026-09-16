# Session Capture — 2026-09-15 — sess-094

## Context
- Task: Study UEFI 2.10 + PI boot phases (Source 1)
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- Cloned UEFI 2.10 rST source from UEFI-Specification-Release to /tmp/uefi-spec-release.\n- Cloned TianoCore wikis to /tmp/tianocore-wiki and /tmp/tianocore-wiki-new.\n- Wrote consolidated study note docs/research/STUDY-UEFI-SPEC-2.10.md.

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- UEFI 2.10 defines the firmware-to-OS interface (EFI_SYSTEM_TABLE, EFI_BOOT_SERVICES, EFI_RUNTIME_SERVICES), the PE32+ UEFI image model, device paths, file system protocols, variables, and Secure Boot.
- PI (Platform Initialization) defines SEC, PEI, DXE, BDS, TSL, RT, AF. PBL runs in BDS/TSL.
- LoadImage and StartImage are the UEFI image services PBL uses to chain-load bootmgfw.efi.
- Secure Boot uses PK/KEK/db/dbx/dbt/dbr; PblApp.efi must be signed and in db, not dbx.
- uefi.org PI PDFs are behind Cloudflare; TianoCore/EDK II wiki is the accessible substitute.

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- docs/research/STUDY-UEFI-SPEC-2.10.md
- /tmp/uefi-spec-release
- /tmp/tianocore-wiki-new/development/design-architecture/pi_boot_flow.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: spec:UEFI 2.10, source/02_Overview.rst, spec:UEFI 2.10, source/07_Services_Boot_Services.rst, spec:UEFI 2.10, source/32_Secure_Boot_and_Driver_Signing.rst, tianocore:development/design-architecture/pi_boot_flow.md
- impact: PBL UEFI/EDK II reasoning, chain-loading, Secure Boot
- response: Proceed to EDK II reference implementation; trace BdsDxe and UefiBootManagerLib
