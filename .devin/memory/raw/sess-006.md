# Session Capture — 2026-08-20 — sess-006

## Context
- Task: Research and answer all 12 questions on the UEFI study checklist against primary sources
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
- Q6 UEFI maintains its own frozen FAT variant (EFI file system, spec §13.3) because original FAT evolved with errata/variant interpretations; UEFI freezes one testable target so firmware vendors implement one predictable format. Distinct partition type GUID C12A7328 signals 'EFI-frozen FAT not normal FAT'

## Mistakes / Corrections
- none this session

## Open Questions
- <none recorded>

## File References
- docs/RESEARCH-UEFI-STUDY-NOTES.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: url:https://uefi.org/specs/UEFI/2.11/, url:https://uefi.org/specs/PI/1.9/, url:https://www.tianocore.org/edk2-pytool-library/api/uefi/fmp_auth_header/, url:https://securelist.com/cosmicstrand-uefi-firmware-rootkit/106973/, url:https://techcommunity.microsoft.com/blog/linuxandopensourceblog/what-it-teams-need-to-know-about-linux-secure-boot-certificates-expiring-in-2026/4530725
- impact: E-HP-UEFI enforcement path depends on Secure Boot PK/KEK/db model and capsule auth
- response: Use these answers when implementing/testing the UEFI enforcement paths; the SBAT/2026 cert expiry findings are operational risks for any MS-shim-reliant lockdown flow
