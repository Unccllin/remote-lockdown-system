# NG-R1: BCD `osdevice` device-blob binary format — enough to implement partition-level FVE binding

> **Label:** `wayfinder:research` (AFK)
> **Status:** OPEN
> **Blocks:** partition-level FVE binding (fog — part of D-120 residual)
> **Blocked by:** none — public sources suffice; real hives (NG-T3) sharpen it

## Question

PBL's FVE binding is currently **disk-level** (device-path prefix match —
session 113). Partition-level binding needs the BCD `osdevice` element's
device-blob binary format: where the partition signature/GUID lives inside
the element, so `Fve.c` can prove "this FVE volume is THE volume Windows
boots from" rather than "an FVE volume exists on the same disk."

Research: the BCD device-element binary layout — element types
0x11000001/0x21000001 (`osdevice`/`device`), the device-blob structure
(DeviceType enum, partition style variants MBR-vs-GPT, where the disk
signature + partition offset/GUID sit, parent/child linkage to the
`{bootmgr}`/`{current}` objects).

## Research question for the subagent

Find primary sources for the BCD device-blob format: Microsoft's BCD WMI
docs (learn.microsoft.com — likely reachable), Geoff Chappell's BCD
research (geoffchappell.com — the canonical RE source), ReactOS/GRUB2
BCD-parsing source code, the `bcdedit`-parsing tooling (e.g., pyBCD,
hivex). Produce the byte-level layout needed to extract a partition
identity from an `osdevice` element — MBR disk-signature+offset vs GPT
disk-GUID+partition-GUID paths — plus how PBL's `Bcd.c` parser would reach
it (it already walks elements; needs the blob decode).

Deliverable: `docs/research/NOTE-BCD-DEVICE-BLOB.md` in the existing
STUDY-note format (or a section appended to `STUDY-WINDOWS-NT-INTERNALS.md`
if the note convention prefers consolidation — say which in the answer).

## Resolution

Record where the format is documented, the byte layout, and whether it's
implementable in `Bcd.c`/`Fve.c` — or that it remains reverse-engineering
requiring real hives (then NG-T3 unblocks it).
