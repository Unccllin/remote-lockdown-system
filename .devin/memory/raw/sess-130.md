# Session Capture — 2026-09-20 — sess-130

## Context
- Task: NG-T5 verify: synthetic BCD hive generator + partition-binding harness test
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
- Real Win11 DVD BCD hives contain only type-5 boot devices — no partition osdevice; synthetic generation is the only local way to test partition binding
- Hive cell offsets are relative to hbin data area (cells start at hbin+0x20); rootRel points at the cell size field
- vk value data: <=4 bytes inline at data_offset (high bit of data_len), >4 bytes in a separate cell
- gen-bcd-hive.py builds root->Objects->{bootmgr}+osloader(Type=0x10200003)->Elements->21000001(type-6 blob)

## Mistakes / Corrections
- First generator run placed cells at buf offset 0 instead of 0x20 — self-walk caught it before QEMU

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/gen-bcd-hive.py
- firmware/PblPkg/test-fve-harness.sh

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
