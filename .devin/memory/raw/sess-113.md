# Session Capture — 2026-09-17 — sess-113

## Context
- Task: D-120 FVE-FS BitLocker metadata detection in PblApp + fix test-fve-harness distro-OVMF bug
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
- FVE-FS sig @3; Win7/10 metadata offsets u64 @176/184/192; block hdr 64B+metadata hdr 48B; VMK entry 0x0002/0x0008, protection @entry+34
- distro OVMF (Ubuntu 4M) randomizes platformAuth at EndOfDxe via HierarchyChangeAuth — breaks RS_PW provisioning (RC=0x9A2); custom OVMF needs Null hierarchy lib (firmware/PblPkg/ovmf-platform-hierarchy-null.patch)
- pbl-qemu image sets ENV OVMF_CODE=/usr/share/OVMF — harnesses must prefer /ovmf mount
- swtpm RCs: 0x9A2=session1 BAD_AUTH, 0x18B=NV undefined, 0x14A=NV_UNINITIALIZED, 0x14C=NV_DEFINED
- Loaded-image count is a cheap boot-path canary: 104 vs 92 exposed wrong OVMF binary

## Mistakes / Corrections
- new harness took OVMF_CODE env default → silently used distro OVMF; fix: prefer /ovmf mount + NV-provisioning/session checks
- chased 0x129 sender through edk2 source too long; fix: capture real QEMU argv first when behavior differs

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/Fve.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/PblApp/PlatformState.c
- firmware/PblPkg/PblApp/PblApp.inf
- firmware/PblPkg/test-fve-harness.sh
- firmware/PblPkg/ovmf-platform-hierarchy-null.patch
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
