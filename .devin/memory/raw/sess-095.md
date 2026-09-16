# Session Capture — 2026-09-15 — sess-095

## Context
- Task: Create EDK II reference implementation study note for PBL
- Environment: repo /home/cllin/remote-lockdown-system; EDK II at /home/cllin/.local/src/edk2; PBL package /home/cllin/remote-lockdown-system/firmware/PblPkg
- Duration: <not specified>

## Decisions Made
- Followed the exact heading structure from the prior UEFI note so cross-references are consistent
- Cited EDK II source paths and line numbers instead of copying source passages
- Distinguish EDK II generic behavior from PBL-specific implementation in the note

## Actions Taken
- Read build-pbl.sh, PblPkg.dsc, PblApp.inf, and PBL application source
- Read MdePkg/MdeModulePkg/SecurityPkg/NetworkPkg/OvmfPkg sources for build, DXE, image loading, BDS, Secure Boot, PE/COFF, TLS/HTTP, and OVMF
- Wrote /home/cllin/remote-lockdown-system/docs/research/STUDY-EDK2.md with all required sections

## Outcomes
- What worked: The requested note was created with all required headings, 20 key mechanisms, glossary, security implications, PBL relevance, pitfalls, cross-references, outstanding questions, and 10 self-test questions.
- What failed: none
- What was unexpected: An older PblPkg exists inside the EDK II tree at /home/cllin/.local/src/edk2/PblPkg and could shadow the project package depending on PACKAGES_PATH resolution order.

## Learnings
- PblPkg.dsc disables LTO and ForceReloc.c forces a .reloc section for HP/Insyde BIOS compatibility
- CoreLoadImageCommon invokes Security2 FileAuthentication before CoreLoadPeImage
- DxeImageVerificationLib is the current EDK II reference Secure Boot verifier; it checks db/dbx and uses the PE certificate table
- Network/TLS protocols must be included in the platform DSC; declaring protocol GUIDs in the INF is not enough

## Mistakes / Corrections
none: this was a research session, no code was written

## Open Questions
- Does build resolve PACKAGES_PATH left-to-right or right-to-left?
- Which OVMF component installs EFI_TCG2_PROTOCOL when TPM2_ENABLE is true?
- Where is EFI_IMAGE_EXECUTION_INFO_TABLE installed as a UEFI configuration table?

## File References
- docs/research/STUDY-EDK2.md
- firmware/PblPkg/build-pbl.sh
- firmware/PblPkg/PblPkg.dsc
- firmware/PblPkg/PblApp/PblApp.inf
- firmware/PblPkg/PblApp/PblApp.c
- /home/cllin/.local/src/edk2/MdeModulePkg/Core/Dxe/Image/Image.c
- /home/cllin/.local/src/edk2/MdePkg/Library/BasePeCoffLib/BasePeCoff.c
- /home/cllin/.local/src/edk2/SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c
- /home/cllin/.local/src/edk2/MdeModulePkg/Universal/BdsDxe/BdsEntry.c
- /home/cllin/.local/src/edk2/MdeModulePkg/Library/UefiBootManagerLib/BmBoot.c

## Optional Fields (applied to consolidated memories)
- evidence_sources: file:firmware/PblPkg/PblPkg.dsc:27-34, file:/home/cllin/.local/src/edk2/MdeModulePkg/Core/Dxe/Image/Image.c:1275-1310, file:/home/cllin/.local/src/edk2/SecurityPkg/Library/DxeImageVerificationLib/DxeImageVerificationLib.c:1659-2078
- impact: Advances PBL implementation debt D-109/D-110/D-111/D-114/D-115/D-116/D-120/D-129/D-130
- response: Before implementing PBL, resolve the four outstanding source gaps and verify PACKAGES_PATH resolution order.
