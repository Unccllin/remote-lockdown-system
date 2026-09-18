# NG-R1: BCD `osdevice` device-blob binary format — enough to implement partition-level FVE binding

> **Label:** `wayfinder:research` (AFK)
> **Status:** CLOSED (2026-09-18)
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

Resolved — **implementable-now** (real hives from NG-T3 remain valuable for
validation, not blocking). Full write-up in
`docs/research/NOTE-BCD-DEVICE-BLOB.md`.

Where documented: the blob layout is not in Microsoft's docs; it is
consistently decoded by four independent RE sources — pybcd
(`kupiakos/pybcd`, `bcddevice.py`), `SaphireLattice/bcd-editor`
(`src/device.rs`), `wodny/libbcd0`, and mistyprojects annotated Windows 8.1
hive dumps — plus semantic confirmation from Microsoft Learn's BCD WMI docs
(`BcdDeviceData`, `BcdDeviceQualifiedPartitionData`) and Russinovich's
disk-signature post. Geoff Chappell covers element IDs/objects only; ReactOS
and GRUB2 have no BCD device-blob decoder.

Byte layout (REG_BINARY `Element` value, partition device, total 0x58):
options GUID @0x00, packet type @0x10 (0=file/ramdisk, 5=boot, 6=partition,
8=vhd/locate), packet size @0x18, partition identity @0x20 (GPT partition
GUID / MBR u64 byte offset), table type @0x34 (0=GPT, 1=MBR — inverted vs
the WMI `PartitionStyle` enum), disk identity @0x38 (GPT disk GUID / MBR
u32 signature). GUIDs are raw on-disk `EFI_GUID` byte order — direct
`CompareMem` against UEFI `HD()` node signatures works.

Implementation path: add `case` arms for `0x11000001`/`0x21000001` in
`BcdApplyElement` (`Bcd.c:454`) decoding the blob; filter to osloader
objects (Description\Type `0x10200003`, or via `{bootmgr}` `0x24000001`
displayorder); upgrade `PblFveSameDisk` (`Fve.c:168`) to compare the
decoded identity against the FVE volume's `HD()` device-path node —
partition GUID (GPT) or signature + byte offset (MBR). No disk reads
needed; `type 5`/nested blobs degrade to existing disk-level binding.
