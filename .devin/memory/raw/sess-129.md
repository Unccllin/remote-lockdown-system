# Session Capture — 2026-09-20 — sess-129

## Context
- Task: NG-T5: partition-level FVE binding via BCD osdevice blob (any-match)
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
- osdevice/device blob: packet type 6 = partition; PartitionID@0x20 (GPT GUID / MBR u64 byte offset), TableType@0x34 (0=GPT,1=MBR inverted vs WMI), DiskID@0x38 — same identity as the HD() device-path node, no disk reads needed
- HARDDRIVE_DEVICE_PATH signature-kind selector is SignatureType (0x01=MBR, 0x02=GPT), NOT MBRType (which is partition format) — easy trap
- Any-match is the safe bind policy: an osloader pointing at the FVE partition proves it IS a Windows boot target; default-object is spoofable/stale-prone
- BcdReadValueData returns a pointer into the hive buffer; REG_DWORD Type read via ReadUnaligned32 on it

## Mistakes / Corrections
- Used Hd->MBRType for the signature-type check — wrong field; SignatureType is correct (caught by reading DevicePath.h)

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/Bcd.c
- firmware/PblPkg/PblApp/Fve.c
- firmware/PblPkg/PblApp/PblApp.h

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
