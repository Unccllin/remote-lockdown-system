# BCD `osdevice`/`device` Device-Blob Binary Format (NG-R1)

## Source

- **Geoff Chappell — BCD research** (canonical RE source for BCD object/element identifiers; does *not* document the blob internals):
  - <https://www.geoffchappell.com/notes/windows/boot/bcd/elements.htm> — element-type dword bit-field encoding (class/format/subtype) and the element catalogue (`0x11000001` `BcdLibraryDevice_ApplicationDevice` = friendly name `device`; `0x21000001` `BcdOSLoaderDevice_OSDevice` = `osdevice`; `0x24000001` `BcdBootMgrObjectList_DisplayOrder` = `displayorder`).
  - <https://www.geoffchappell.com/notes/windows/boot/bcd/objects.htm> — predefined object GUIDs (`{bootmgr}` = `{9DEA862C-5CDD-4E70-ACC1-F32B344D4795}`, `{current}` = `{FA926493-6F1C-4193-A414-58F0B2456D1E}`, `{ramdiskoptions}` = `{AE5534E0-A924-466C-B836-758539A3EE3A}`).

- **Microsoft Learn — BCD WMI provider docs** (archived "previous versions" tree; semantics only, no raw offsets):
  - <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bcd/bcdelementtype> — `BcdElementType`: `Format` field `Device = 0x1`; `Class` field `Library = 0x1`, `Application = 0x2`, `Device = 0x3`.
  - <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bcd/bcddevicedata> — `BcdDeviceData.DeviceType` enum: `BootDevice=1`, `PartitionDevice=2`, `FileDevice=3`, `RamdiskDevice=4`, `UnknownDevice=5`, `QualifiedPartition=6`, `LocateDevice=7` (unused), `LocateExDevice=8`. Also `AdditionalOptions` — "a GUID in string form… that represents another object in the store".
  - <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bcd/bcddevicequalifiedpartitiondata> — `BcdDeviceQualifiedPartitionData`: `PartitionStyle` (`MBR=0`, `GPT=1`), `DiskSignature` (MBR: decimal signature string / GPT: disk GUID string), `PartitionIdentifier` (MBR: decimal partition **byte offset** / GPT: partition GUID string). The standard `partition=X:` element is a qualified partition.
  - <https://learn.microsoft.com/en-us/previous-versions/windows/desktop/bcd/setqualifiedpartitiondeviceelement-bcdobject> — same field semantics from the setter side.
  - <https://learn.microsoft.com/en-us/archive/blogs/markrussinovich/fixing-disk-signature-collisions> — Mark Russinovich, *Fixing Disk Signature Collisions*: "Disk signatures show up at offset 0x38 in registry values called `Element` under keys named `0x11000001` (Windows boot device) and `0x2100001` [sic] (OS load device)"; MBR disk signature lives at `0x1B8` of LBA0.

- **Reverse-engineered decoders** (primary code sources for the byte layout; four independent implementations agree):
  - **pybcd** — <https://github.com/kupiakos/pybcd> — `bcddevice.py` is a complete device-blob decoder (`_deviceentry_from`, `_packet_from`, `_diskpartition_from`, `_diskfile_from`, `_ramdisk_from`, `_vhddisk_from`); `analyze/devicesanalyze.txt` is the author's struct notes; `test/` contains real `bcdedit`-generated hives.
  - **bcd-editor (Rust)** — <https://github.com/SaphireLattice/bcd-editor> — `src/device.rs`: independent decoder (`PacketHeader`, `DevicePacket::PartitionGPT(Uuid,Uuid)` / `PartitionMBR(u32,u64)`); confirms `Uuid::from_bytes_le` (raw on-disk GUID order) and packet-type 5/6 semantics.
  - **libbcd0** — <https://github.com/wodny/libbcd0> — C decoder + README notes: partition byte offset at blob `0x20`, MBR disk signature at `0x38`, `0x06` at `0x10`, `0x48` at `0x18`, `0x01` at `0x34`.
  - **BCDEdit Notes (mistyprojects)** — <http://mistyprojects.co.uk/documents/BCDEdit/files/device_partition.htm> — real Windows 8.1 hive hex dumps for both MBR and GPT `osdevice` elements, annotated with the disk-signature/partition-offset/disk-GUID/partition-GUID provenance. <http://mistyprojects.co.uk/documents/BCDEdit/files/bcd.htm> — confirms the element value is `REG_BINARY` and gives a second MBR dump. <http://mistyprojects.co.uk/documents/BCDEdit/files/object_element_codes.htm> — object-type codes (`0x10100002` {bootmgr}, `0x10200003` osloader, `0x30000000` {ramdiskoptions}) and element table (`osdevice = 21000001`, `systemroot = 22000002`).
  - **bcdeditmod** — <https://github.com/Wack0/bcdeditmod> — hooks `bcdedit`'s own device encoder; documents the *semantic* device tree the blob encodes (`part`/`part2` partition-identifier devices with `gptsig`/`mbrindex`/`mbroffset`, `block[hd[gpt|mbr|raw]]` hard-disk block devices, `file`, `ram`, `vhd`, `locate`, `boot`, `serial`, `udp`, `vmbus`, `uri`, `composite`, `unknown[N]`); states `5` corresponds to `DEVICE_TYPE_BOOT`.

- **Registry-hive format** (the container — already implemented in `Bcd.c`):
  - <https://github.com/libyal/libregf/blob/main/documentation/Windows%20NT%20Registry%20File%20(REGF)%20format.asciidoc> — Joachim Metz's libregf spec (regf/hbin/nk/vk/lf/lh/li cells).

- **Negative results** (sources the ticket suggested that turned out not to cover this):
  - **ReactOS** — `boot/bcd/` in `reactos/reactos` master contains only `.keep`; FreeLoader parses `freeldr.ini`, not BCD device blobs. No BCD device-blob decoder exists in the ReactOS tree (checked `boot/freeldr`, `boot/bcd`, full-tree file list).
  - **GRUB2** — no BCD parser; GRUB chain-loads Windows loaders without reading the BCD hive.
  - **Geoff Chappell** — documents objects and element IDs only, not blob internals.

## One-paragraph technical overview

Every BCD element whose type dword has format `0x1` ("device") — `device` (`0x11000001`), `osdevice` (`0x21000001`), `ramdiskdevice`, etc. — stores a binary blob in the element key's `Element` value (REG_BINARY). The blob is a small tree of "packets": a 16-byte *additional-options* GUID, then a 16-byte packet header (`type`, `flags/sub-qualifier`, `size`, `unknown`), then a type-specific payload. For a plain `partition=X:` device (the normal `osdevice` of an installed Windows), the packet type is `6` and the payload is a `diskpartition` structure that *is* the partition identity: a 16-byte partition identifier, a 4-byte table-type selector, and a 16-byte disk identifier. On MBR disks the partition identifier is the partition's **byte offset** (u64) and the disk identifier is the **4-byte MBR signature**; on GPT disks they are the **unique partition GUID** and the **disk GUID**, stored in raw on-disk (EFI mixed-endian) GUID form. Other packet types wrap the same `diskpartition` leaf inside file/ramdisk/vhd/locate parents. Because the UEFI `HD()` device-path node carries exactly the same identity (MBR signature + partition-start LBA, or GPT partition GUID), the decoded blob can be compared directly against the device path of each FVE volume handle — no disk reads needed — giving partition-level FVE↔boot binding.

## Key technical facts

1. **Element type dword = `0xCFSSTTTT`-style bit fields**: class `0xF0000000` (1=library, 2=application, 3=device, 4=template/hidden), format `0x0F000000` (1=device, 2=string, 3=GUID, 4=GUID list, 5=integer, 6=boolean, 7=integer list), subtype `0x00FFFFFF`. `0x11000001` = library-class device element (`device`); `0x21000001` = application-class device element (`osdevice`); both decode with the identical blob format. (Chappell, *BCD Elements*; Microsoft `BcdElementType`.)

2. **Hive path to the blob**: `Objects\{object-guid}\Elements\<8-hex-digit-type>\Element` (REG_BINARY). The object subkey also has a `Description` key whose `Type` value is the object-type dword (`0x10200003` = Windows OS loader; `0x10100002` = `{bootmgr}`; `0x10200005` = `{memdiag}`; `0x10200004` = resume; `0x30000000` = device-options such as `{ramdiskoptions}`; `0x2xxxxxxx` = inheritable). (mistyprojects *BCD Store* and *Objects and Elements*; pybcd `objects.py`.)

3. **Parent/child linkage is by GUID strings, not by blob**: `{bootmgr}`'s `displayorder` element (`0x24000001`, GUID-list format) holds the object GUIDs of the OS loader entries; `recoverysequence`, `default`, `resumeobject` link other children. `{current}` (`{FA926493-6F1C-4193-A414-58F0B2456D1E}`) is a runtime alias — it is *never a key name in the hive*; real osloader objects have generated GUIDs. PBL must enumerate loader objects via `displayorder` + object type, not search for `{current}`. (Chappell *BCD Objects*; Microsoft `BcdBootMgrElementTypes` docs; pybcd `objects.py`.)

4. **Blob top level**: `deviceentry` = 16-byte *additional-options* GUID (links to a sibling *options* object, e.g. `{ramdiskoptions}` for WIM boots; all-zero when unused — the common case) followed by one `packet`. (pybcd `_deviceentry_from`; bcd-editor `Device::new`.)

5. **Packet header** (16 bytes, little-endian): `+0x00 u32 type`, `+0x04 u32 flags/sub-qualifier`, `+0x08 u32 size` (bytes counted from the start of *this* packet — i.e., header + payload), `+0x0C u32 unknown`. Payload begins at packet+0x10 and runs `size-0x10` bytes; anything after `size` is the *next sibling* in the device tree. (pybcd `_packet_from`; bcd-editor `get_packet_header`.)

6. **Packet type values** (RE-confirmed): `0` = file/ramdisk container (`flags==0` → file, else ramdisk); `5` = boot device (`DEVICE_TYPE_BOOT`, payload is 0x38 zero bytes); `6` = partition (`diskpartition` payload); `8` = vhd/locate chain. The WMI-level `BcdDeviceData.DeviceType` enum is a *different*, logical numbering (1=Boot, 2=Partition, 3=File, 4=Ramdisk, 5=Unknown, 6=QualifiedPartition, 7=Locate, 8=LocateEx) — do not confuse the two. (pybcd; bcdeditmod; Microsoft `BcdDeviceData`.)

7. **The `diskpartition` payload is the partition identity** (0x38 bytes, always starts at blob offset `0x20` for a top-level partition device):

   | Blob offset | Size | Field |
   |-------------|------|-------|
   | `0x20` | 16 | `PartitionID` — GPT: 16-byte unique partition GUID; MBR: u64 LE partition **byte offset** in low 8 bytes, high 8 zero |
   | `0x30` | 4  | zero (asserted `u3 == 0` by pybcd) |
   | `0x34` | 4  | `TableType`: **0 = GPT, 1 = MBR** — *inverted* relative to the WMI `PartitionStyle` enum (0=MBR, 1=GPT); both real dumps and all three decoders agree on the wire values |
   | `0x38` | 16 | `DiskID` — GPT: 16-byte disk GUID (GPT header LBA1 `+0x38`); MBR: u32 LE disk signature (MBR LBA0 `+0x1B8`) in low 4 bytes, high 12 zero |
   | `0x48` | 16 | zero padding |

   For `partition=X:` the outer packet is `type=6`, `flags=0`, `size=0x48`, `unknown=0`; total blob = `0x58` bytes. (pybcd `_diskpartition_from`; bcd-editor `get_packet_content` case 6; mistyprojects dumps; libbcd0; Russinovich.)

8. **GUID byte order is raw on-disk order** (`Uuid::from_bytes_le` / struct `IHH` + 8 raw bytes — Data1/2/3 little-endian, Data4 verbatim): identical to the bytes in the GPT partition-entry array and to UEFI `EFI_GUID`. A direct `CompareMem` against a GPT partition entry's `UniquePartitionGUID` or an `HD()` node's `Signature[16]` is valid — no byteswap needed. (pybcd `guid_from`; bcd-editor; mistyprojects GPT dump — `d2,54,ac,d9,87,ea,2c,43,86,b5,66,c4,e8,10,5f,9d` = `{d9ac54d2-ea87-432c-86b5-66c4e8105f9d}`.)

9. **Nested device forms** (needed only to *recognize*, not fully decode, for FVE binding): file device = outer packet `type 0` + `diskfile` struct (4-dword prologue `{u5,u6,u7,u8}`, `u5 ∈ {0,5,6}`) + parent packet + UTF-16LE path — bcd-editor instead keys nesting off the outer header's `unknown` field (`unknown == 5` ⇒ payload = parent packet + UTF-16 path); ramdisk = `type 0`/`flags!=0` + 9-dword prologue + parent packet + path (author notes a "size off by 4" quirk in the wrapping packet — corroborated by bcd-editor's `length + (unknown != 0 ? 4 : 0)`); vhd/locate = `type 8` chain (`u10=0, locatecustom u32, u11=0x1E, u16 0`) → `vhddiskfile` (`u13=6`) → `diskfile` → parent packet. The *parent* packet at the bottom of any of these chains is the same `type 5`/`type 6` leaf. (pybcd `_diskfile_from`/`_ramdisk_from`/`_vhddisk_from`; bcd-editor `header.unknown == 5` branch — the two implementations frame the nesting slightly differently but agree on the leaf shape.)

10. **The blob locks an object to a disk+partition, not to a drive letter.** `bcdedit`'s `partition=C:` syntax *resolves* the letter at set time and stores the physical identity; that is precisely the property PBL wants — the stored identity is immune to drive-letter or enumeration-order changes. (mistyprojects *Devices*; bcdedit help via bcdeditmod.)

11. **UEFI already carries the same identity**: `HARDDRIVE_DEVICE_PATH` (`MEDIA_DEVICE_PATH`, subtype `0x01`) holds `PartitionStart` (LBA), `Signature[16]`, `SignatureType` (`0x01` = MBR 32-bit signature, `0x02` = GPT partition GUID). So binding is a *device-path comparison*: GPT → `HD.Signature == blob.PartitionID` (globally unique — the disk GUID is redundant confirmation); MBR → `HD.Signature[0:4] == blob.DiskID[0:4]` **and** `HD.PartitionStart × BlockIo->BlockSize == blob.PartitionID` (byte offset). (UEFI 2.10 spec §10.3 `HARDDRIVE_DEVICE_PATH`; STUDY-UEFI-SPEC-2.10.)

## Byte-level layout — `osdevice`/`device` element value (partition device)

Element value = REG_BINARY blob, offsets relative to the start of the `Element` value data:

```
0x00  16B   AdditionalOptions GUID   (all-zero when unused; else options-object GUID,
                                       e.g. {ramdiskoptions} = AE5534E0-…-758539A3EE3A)
0x10  u32   PacketType               0=file/ramdisk container, 5=boot, 6=partition, 8=vhd/locate
0x14  u32   Flags/sub-qualifier      0 for partition; for type 0: 0=file, nonzero=ramdisk
0x18  u32   PacketSize               bytes from 0x10 to end of this packet (=0x48 for partition)
0x1C  u32   Unknown                  0 for partition; quirk: when nonzero, declared size
                                     is short by 4 (pybcd ramdisk note; bcd-editor +4 rule)
0x20  16B   PartitionID              MBR: u64 LE byte offset (low 8B) ‖ GPT: partition GUID
0x30  u32   0
0x34  u32   TableType                0=GPT, 1=MBR   (INVERTED vs WMI PartitionStyle!)
0x38  16B   DiskID                   MBR: u32 LE disk signature (low 4B) ‖ GPT: disk GUID
0x48  16B   0 padding
```

Worked example (mistyprojects MBR dump, `partition=C:` on a BIOS/MBR Windows 8.1):

```
00×16                              options GUID (none)
06 00 00 00                        type 6 (partition)
00 00 00 00                        flags
48 00 00 00                        size = 0x48
00 00 00 00                        unknown
00 00 f0 15 00 00 00 00            PartitionID = 0x0000000015F00000 bytes (= 368050176)
00×8                               (rest of 16B field)
00 00 00 00                        u3 = 0
01 00 00 00                        TableType = 1 (MBR)
f1 a8 eb b3 00×12                  DiskID = MBR signature 0xB3EBA8F1 (== MBR LBA0+0x1B8)
00×16                              padding
```

GPT dump (UEFI Windows 8.1): `TableType = 0`, bytes `0x20–0x2F` = partition GUID
`{d9ac54d2-ea87-432c-86b5-66c4e8105f9d}`, bytes `0x38–0x47` = disk GUID
`{bbe56308-e718-4134-9b6c-4b314d12eab4}` — matching the GPT header `Disk GUID` at LBA1+0x38.

## How `Bcd.c` reaches it (mapping to PBL code)

`PblBcdParse` (`Bcd.c:716`) already validates the `regf` header, finds `Objects` (`BcdFindSubkeyByName`, `Bcd.c:780`), and iterates every object key via `BcdSubkeyListGetChild` (`Bcd.c:801`). `BcdParseObject` (`Bcd.c:609`) descends into each object's `Elements` subkey (`Bcd.c:625`) and iterates element keys; `BcdParseElement` (`Bcd.c:547`) parses the 8-hex-digit element ID from the NK name (`Bcd.c:572–589`), locates the `Element` value (`BcdFindValueByName`, `Bcd.c:591`), and extracts the raw bytes via `BcdReadValueData` (`Bcd.c:600`), passing them to `BcdApplyElement` (`Bcd.c:604`). **The decode hooks at exactly two places:** (a) new `case` arms in `BcdApplyElement` (`Bcd.c:454`) for `0x11000001` and `0x21000001` calling a new `BcdParseDeviceBlob(Data, DataLength, …)` that bounds-checks `DataLength >= 0x58`, reads `PacketType` at `+0x10`, and for `6` extracts `(TableType@0x34, PartitionID@0x20, DiskID@0x38)`; (b) to know *which* object the element came from, either read each object's `Description\Type` value (same vk machinery, one extra `BcdFindValueByName`/`BcdReadValueData` under the `Description` subkey) and keep only type `0x10200003` loaders, or walk `{bootmgr}`'s `0x24000001` GUID list first and match object key names — the existing multi-sz helpers (`BcdCountMultiSz`) already prove GUID-list elements are reachable the same way. New state fields (`PblApp.h:269+`) would be something like `BcdOsDeviceTableType`, `BcdOsDevicePartId[16]`, `BcdOsDeviceDiskId[16]`, plus a `BcdOsDevicePresent` flag — for *each* osloader object found, so a small array or "first/default entry wins" policy is needed.

For the binding side (`Fve.c`): `PblCheckFve` (`Fve.c:269`) already obtains each candidate volume's device path and `PblFveDiskPrefixLen` (`Fve.c:140`) already locates the first `MEDIA_DEVICE_PATH` node. Partition-level binding replaces/augments `PblFveSameDisk` (`Fve.c:168`): cast that media node to `HARDDRIVE_DEVICE_PATH` (subtype `0x01`) and compare — GPT: `SignatureType==0x02 && CompareMem(Signature, PartId, 16)==0`; MBR: `SignatureType==0x01 && Signature32==DiskId32 && PartitionStart*BlockSize==PartId64`. A `type 5` (boot) blob carries no partition identity — degrade to the existing disk-level prefix match; `type 0`/`8` blobs (ramdisk/file/vhd — WinPE/recovery media) have no usable leaf and should be treated as "cannot bind at partition level", not as a failure.

## Verdict

**Implementable-now.** The byte layout needed to extract partition identity from `osdevice`/`device` is documented consistently by four independent reverse-engineered decoders (pybcd, bcd-editor Rust, libbcd0, mistyprojects annotated hive dumps), and the two semantic invariants — MBR disk signature @ `0x38` ↔ MBR `0x1B8`, MBR partition byte-offset @ `0x20`, GPT disk/partition GUIDs — are independently confirmed by Microsoft sources (Russinovich's disk-collision post; `BcdDeviceQualifiedPartitionData` semantics). The decode is ~60 lines of bounds-checked C added to `BcdApplyElement`/`BcdParseElement`, and the FVE side needs no disk reads because UEFI `HD()` nodes carry the same identity.

**Caveats that make real hives (NG-T3) still valuable, not blocking:**
- The `flags`/`unknown` header fields are only partly understood (ramdisk "size off by 4" quirk); the partition path doesn't depend on them, but strict validation should treat `PacketSize` as advisory and bound-check against `DataLength`.
- Nested file/ramdisk/vhd chains (packet types 0 and 8) are documented well enough to *skip or peel* but were less independently verified; a wrong guess there is harmless if the parser fails safe to disk-level binding.
- Multi-boot stores mean several `0x21000001` blobs (one per osloader object); the policy for which to bind (`{bootmgr}.default`, first `displayorder` entry, or "any osdevice matching an FVE volume") is a product decision, not a format question.
- BitLocker'd *recovery* partitions and `locate=` devices (`LocateExDevice`) are rare edge shapes a real hive would confirm.

## Cross-references

- `firmware/PblPkg/PblApp/Bcd.c` — hive parser; `BcdApplyElement` is the integration point.
- `firmware/PblPkg/PblApp/Fve.c` — `PblFveSameDisk`/`PblFveDiskPrefixLen`; the partition-level upgrade path.
- `firmware/PblPkg/PblApp/PlatformState.c` — `PblCollectBcdState` (`:683`) reads `\EFI\Microsoft\Boot\BCD`; PBL state fields at `PblApp.h:269+`.
- `docs/research/STUDY-WINDOWS-NT-INTERNALS.md` — BCD element IDs already surveyed; outstanding question #2 notes the parser needs real-hive validation.
- `docs/research/STUDY-UEFI-SPEC-2.10.md` — `HARDDRIVE_DEVICE_PATH`/`MEDIA_DEVICE_PATH` layout used for the binding side.
- `docs/reference/FETCH-LIST.md` §3.1 — the `bcdedit /export` artifacts (NG-T3) that would validate this on real hives.
- `docs/adr/PBL-DEBT-LEDGER.md` — D-120 residual (partition-level binding).

## Outstanding questions

1. Whether `flags` (packet `+0x04`) carries semantic bits for partition devices beyond the file/ramdisk split — all observed partition blobs have `0`, but a real multi-scenario corpus would confirm.
2. Exact `unknown` (`+0x0C`) semantics and the "+4" size quirk — needs a ramdisk-bearing real hive (`test/` hives in pybcd partially cover this).
3. Whether Windows 11 writes `part` (mbrindex) vs `part2` (mbroffset) partition-identifier devices differently — bcdeditmod implies both encodings exist; observed blobs all use the byte-offset form.
4. How `locate=` / `LocateExDevice` blobs differ inside packet type 8 — only pybcd's `u11==0x1E` marker is documented.
