# NG-T5: Partition-level FVE binding — decode `osdevice` blob, bind to the Windows boot volume

> **Label:** `wayfinder:task` (AFK-able, firmware session lifecycle)
> **Status:** OPEN
> **Blocks:** D-120 residual (partition-level binding; real-media validation
> stays open under NG-T3)
> **Blocked by:** none (NG-R1 resolved; spec at
> `docs/research/NOTE-BCD-DEVICE-BLOB.md`)

## Question

Upgrade FVE↔boot binding from disk-level (device-path prefix, session 113)
to **partition-level**: decode the BCD `osdevice` device-blob to get the
exact partition Windows boots from, and match it against the FVE volume's
`HD()` node identity — "this FVE volume *is* the Windows boot volume,"
not merely "an FVE volume exists on the same disk."

## Work

Spec: `docs/research/NOTE-BCD-DEVICE-BLOB.md` (byte-level tables). Layout:
16B options GUID `@0x00`, packet header `@0x10`, partition devices
(`type=6`): `PartitionID @0x20` (GPT: partition GUID / MBR: u64 offset),
`TableType @0x34` (**0=GPT, 1=MBR — inverted vs. WMI enum**),
`DiskID @0x38` (GPT: disk GUID / MBR: u32 signature).

1. **`BcdParseDeviceBlob()`** (~60 lines, bounds-checked) — new `case` arms
   in `BcdApplyElement` (`Bcd.c:454`) for `0x11000001`/`0x21000001`.
2. **Boot-object classification** — enumerate loaders via `{bootmgr}`'s
   `0x24000001` displayorder or `Description\Type == 0x10200003`;
   `{current}` is a runtime alias, never in the hive.
3. **`PblFveSameDisk` upgrade** (`Fve.c:168`) — compare decoded partition
   identity (GUID or MBR signature+offset) against the FVE handle's `HD()`
   node signature — no disk reads needed.
4. **Bind policy (multi-boot stores)** — decide: `{bootmgr}.default` only,
   first displayorder entry, or any-match. Default to the `default` object,
   record alternatives considered.
5. **Fail-safe degradation** — `type 5`/nested file/ramdisk/vhd chains
   (types 0/8) and parse failures fall back to existing disk-level
   binding; never worse than today.
6. **State field** — `FveOnBootPartition` alongside existing
   `FveOnBootDisk`; covered by `platform_state_digest` automatically.

## Verify

- Extend `test-fve-harness.sh`: synthetic BCD hive with `osdevice`
  pointing at the FVE partition (positive) vs. another partition
  (negative) vs. multi-boot store.
- QEMU harness serial shows partition-level bound/not-bound lines.
- `make graph-check` green; session-close per AGENTS.md; narrow D-120
  ledger entry (partition binding done; real-media + VMK remain).

## Resolution

Record harness evidence + chosen bind policy. D-120 update in
`PBL-DEBT-LEDGER.md`.
