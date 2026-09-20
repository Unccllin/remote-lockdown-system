#!/usr/bin/env python3
"""gen-bcd-hive.py — synthetic BCD registry hive generator for NG-T5.

Builds a minimal but structurally-valid Windows BCD hive (regf/hbin/nk/vk)
containing one {bootmgr} object and one or more osloader objects, each
optionally carrying an `osdevice` (0x21000001) partition-device blob. Used
by the NG-T5 partition-binding harness to place a real-format hive at
\\EFI\\Microsoft\\Boot\\BCD on the test ESP.

Layout produced (mirrors what firmware/PblPkg/PblApp/Bcd.c expects):

  regf header @0x0000   (sig 'regf', rootRel @0x24, hbinsSize @0x28)
  hbin   @0x1000        (sig 'hbin', cells follow)
    root nk   "BCD00000000"           subkeys: [Objects]
    Objects nk                        subkeys: [{bootmgr}, osloader...]
    {bootmgr} nk                      subkeys: [Description, Elements]
      Description nk                  values:  Type = 0x10100002
      Elements nk                     subkeys: [element nks]
    osloader nk (name = {guid})       subkeys: [Description, Elements]
      Description nk                  values:  Type = 0x10200003
      Elements nk                     subkeys: ["21000001" nk]
        "21000001" nk                 values:  Element = <osdevice blob>

Cell offsets are RELATIVE to the hbin data area (i.e. cell_abs = 0x1000+rel).
Lists use the 'li' form (sig 'li' + u16 count + u32 rel-offset entries).

Usage:
  gen-bcd-hive.py --out BCD \
      --partition-guid <guid>        # osdevice points at this GPT partition
      [--disk-guid <guid>]           # GPT disk GUID (default zero)
      [--osdevice-mbr <sig>:<off>]   # emit an MBR-type osdevice instead
      [--boot-device]                # emit a type-5 boot device (no partition)
      [--objects N]                  # number of osloader objects (default 1)

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

import argparse
import struct
import sys

HBIN_BASE = 0x1000

# ---------------------------------------------------------------------------
# Cell builder — accumulates cells inside one hbin, returns relative offsets.
# ---------------------------------------------------------------------------


class HbinBuilder:
    """Packs cells into a single hbin; offsets are relative to hbin data.

    The hbin header is 0x20 bytes; cells begin at relative offset 0x20.
    We therefore place the first cell at buf offset 0x20 so that a cell's
    buf offset IS its hive-relative offset (cell_abs = 0x1000 + rel).
    """

    def __init__(self):
        # Reserve the 0x20-byte hbin header region so buf offsets match
        # hive-relative cell offsets directly.
        self.buf = bytearray(0x20)

    @property
    def offset(self):
        """Current relative offset where the next cell will be placed."""
        return len(self.buf)

    def add_cell(self, payload: bytes) -> int:
        """Append a cell; return its relative offset (to the size field).

        Cell = i32 size (negative = allocated) + payload, 8-byte aligned.
        """
        rel = self.offset
        size = len(payload) + 4
        # round up to 8-byte alignment
        total = (size + 7) & ~7
        pad = total - size
        self.buf += struct.pack("<i", -total)  # negative = allocated
        self.buf += payload
        self.buf += b"\x00" * pad
        return rel


def _nk_name(name: str) -> tuple[bytes, int]:
    """Encode an nk key name. ASCII (flag 0x20) if all chars < 0x80."""
    if all(ord(c) < 0x80 for c in name):
        return name.encode("ascii"), 0x0020
    return name.encode("utf-16-le"), 0x0000


def build_nk(hb: HbinBuilder, name: str, parent_rel: int,
             subkey_list_rel: int = 0, subkey_count: int = 0,
             value_list_rel: int = 0, value_count: int = 0) -> int:
    """Build an nk cell. Returns its relative offset.

    nk layout (from cell data start, i.e. after the 'nk' sig):
      +0x00 'nk' | +0x02 u16 type(0x20=ascii name) | +0x10 i32 parent |
      +0x14 u32 subkey_count | +0x1C i32 subkey_list | +0x24 u32 value_count |
      +0x28 i32 value_list | +0x48 u16 name_length | +0x4C name bytes
    """
    name_bytes, type_flag = _nk_name(name)
    body = bytearray(0x4C)
    body[0:2] = b"nk"
    struct.pack_into("<H", body, 0x02, type_flag)
    struct.pack_into("<i", body, 0x10, parent_rel)
    struct.pack_into("<I", body, 0x14, subkey_count)
    struct.pack_into("<i", body, 0x1C, subkey_list_rel)
    struct.pack_into("<I", body, 0x24, value_count)
    struct.pack_into("<i", body, 0x28, value_list_rel)
    struct.pack_into("<H", body, 0x48, len(name_bytes))
    body += name_bytes
    return hb.add_cell(bytes(body))


def build_vk(hb: HbinBuilder, name: str, data: bytes, data_type: int) -> int:
    """Build a vk cell. Returns its relative offset.

    vk layout:
      +0x00 'vk' | +0x02 u16 name_len | +0x04 u32 data_len (high bit=inline) |
      +0x08 u32/i32 data_offset | +0x0C u32 data_type | +0x10 u16 flags(1=ascii) |
      +0x14 name bytes
    Data >4 bytes is stored in a separate cell; <=4 is inline at data_offset.
    """
    name_bytes = name.encode("ascii")
    inline = len(data) <= 4

    if inline:
        # data stored inline in the data_offset field; high bit set in len
        data_len_field = 0x80000000 | len(data)
        data_off_field = int.from_bytes(data.ljust(4, b"\x00"), "little")
        data_cell_rel = 0
    else:
        data_cell_rel = hb.add_cell(data)
        data_len_field = len(data)
        data_off_field = data_cell_rel

    body = bytearray(0x14)
    body[0:2] = b"vk"
    struct.pack_into("<H", body, 0x02, len(name_bytes))
    struct.pack_into("<I", body, 0x04, data_len_field)
    struct.pack_into("<i", body, 0x08, data_off_field)
    struct.pack_into("<I", body, 0x0C, data_type)
    struct.pack_into("<H", body, 0x10, 0x0001)  # ASCII name
    body += name_bytes
    return hb.add_cell(bytes(body))


def build_li_list(hb: HbinBuilder, child_rels: list[int]) -> int:
    """Build an 'li' subkey list cell: sig 'li' + u16 count + u32 entries."""
    body = bytearray()
    body += b"li"
    body += struct.pack("<H", len(child_rels))
    for r in child_rels:
        body += struct.pack("<i", r)
    return hb.add_cell(bytes(body))


def build_vk_list(hb: HbinBuilder, value_rels: list[int]) -> int:
    """Value list = bare u32 offsets (no signature) in a cell."""
    body = bytearray()
    for r in value_rels:
        body += struct.pack("<i", r)
    return hb.add_cell(bytes(body))


# ---------------------------------------------------------------------------
# osdevice blob builders (NOTE-BCD-DEVICE-BLOB.md)
# ---------------------------------------------------------------------------


def _guid_bytes(guid_str: str) -> bytes:
    """GUID string -> raw on-disk (mixed-endian EFI) bytes."""
    g = guid_str.strip().strip("{}")
    parts = g.split("-")
    if len(parts) != 5:
        raise ValueError(f"bad GUID: {guid_str}")
    d1 = int(parts[0], 16)
    d2 = int(parts[1], 16)
    d3 = int(parts[2], 16)
    d4 = bytes.fromhex(parts[3] + parts[4])
    # Data1/2/3 little-endian, Data4 verbatim
    return struct.pack("<IHH", d1, d2, d3) + d4


def build_partition_blob(part_id: bytes, disk_id: bytes, table_type: int) -> bytes:
    """Type-6 partition deviceentry blob (0x58 bytes)."""
    blob = bytearray()
    blob += b"\x00" * 16                       # 0x00 options GUID (none)
    blob += struct.pack("<I", 6)               # 0x10 packet type = partition
    blob += struct.pack("<I", 0)               # 0x14 flags
    blob += struct.pack("<I", 0x48)            # 0x18 packet size
    blob += struct.pack("<I", 0)               # 0x1C unknown
    blob += part_id.ljust(16, b"\x00")[:16]    # 0x20 PartitionID
    blob += struct.pack("<I", 0)               # 0x30 u3
    blob += struct.pack("<I", table_type)      # 0x34 TableType (0=GPT,1=MBR)
    blob += disk_id.ljust(16, b"\x00")[:16]    # 0x38 DiskID
    blob += b"\x00" * 16                       # 0x48 padding
    return bytes(blob)


def build_boot_blob() -> bytes:
    """Type-5 boot deviceentry blob (0x48 bytes: header + 0x38 zeros)."""
    blob = bytearray()
    blob += b"\x00" * 16
    blob += struct.pack("<I", 5)               # 0x10 packet type = boot
    blob += struct.pack("<I", 0)               # flags
    blob += struct.pack("<I", 0x38)            # size
    blob += struct.pack("<I", 0)               # unknown
    blob += b"\x00" * 0x38                     # payload = zeros
    return bytes(blob)


# ---------------------------------------------------------------------------
# Hive assembly
# ---------------------------------------------------------------------------


def build_hive(osloader_blobs: list[bytes]) -> bytes:
    """Assemble the full hive. osloader_blobs = one osdevice blob per loader."""
    hb = HbinBuilder()

    # We must build children before parents (parents store child offsets),
    # but offsets are assigned in cell order — so build leaf cells first,
    # then patch parent fields. Simplest: build bottom-up, collecting rels.

    # --- {bootmgr}: Description (Type=0x10100002) + empty Elements ---
    bm_type_vk = build_vk(hb, "Type", struct.pack("<I", 0x10100002), 4)
    bm_desc_vklist = build_vk_list(hb, [bm_type_vk])
    bm_desc_nk = build_nk(hb, "Description", parent_rel=0,
                        value_list_rel=bm_desc_vklist, value_count=1)
    bm_elem_list = build_li_list(hb, [])          # no elements on bootmgr
    bm_elem_nk = build_nk(hb, "Elements", parent_rel=0,
                          subkey_list_rel=bm_elem_list, subkey_count=0)
    bm_subkey_list = build_li_list(hb, [bm_desc_nk, bm_elem_nk])
    bootmgr_nk = build_nk(hb, "{9dea862c-5cdd-4e70-acc1-f32b344d4795}",
                          parent_rel=0,
                          subkey_list_rel=bm_subkey_list, subkey_count=2)

    # --- osloader objects ---
    loader_nks = []
    for idx, blob in enumerate(osloader_blobs):
        # element nk "21000001" with Element value = osdevice blob
        elem_vk = build_vk(hb, "Element", blob, 3)  # REG_BINARY
        elem_vklist = build_vk_list(hb, [elem_vk])
        elem_nk = build_nk(hb, "21000001", parent_rel=0,
                           value_list_rel=elem_vklist, value_count=1)
        # Description nk (Type=0x10200003 = osloader)
        l_type_vk = build_vk(hb, "Type", struct.pack("<I", 0x10200003), 4)
        l_desc_vklist = build_vk_list(hb, [l_type_vk])
        l_desc_nk = build_nk(hb, "Description", parent_rel=0,
                             value_list_rel=l_desc_vklist, value_count=1)
        # Elements nk holds the element nk
        l_elem_list = build_li_list(hb, [elem_nk])
        l_elem_nk = build_nk(hb, "Elements", parent_rel=0,
                             subkey_list_rel=l_elem_list, subkey_count=1)
        # object subkey list: Description + Elements
        l_subkey_list = build_li_list(hb, [l_desc_nk, l_elem_nk])
        guid_name = "{%08x-0000-4000-8000-%012d}" % (0x1000 + idx, idx)
        loader_nk = build_nk(hb, guid_name, parent_rel=0,
                             subkey_list_rel=l_subkey_list, subkey_count=2)
        loader_nks.append(loader_nk)

    # --- Objects node: subkeys = bootmgr + all loaders ---
    objects_children = [bootmgr_nk] + loader_nks
    objects_list = build_li_list(hb, objects_children)
    objects_nk = build_nk(hb, "Objects", parent_rel=0,
                          subkey_list_rel=objects_list,
                          subkey_count=len(objects_children))

    # --- root node "BCD00000000": subkey = Objects ---
    root_list = build_li_list(hb, [objects_nk])
    root_rel = build_nk(hb, "BCD00000000", parent_rel=0,
                        subkey_list_rel=root_list, subkey_count=1)

    # --- assemble file: regf header + hbin ---
    hbin_data = bytes(hb.buf)
    hbins_size = (len(hbin_data) + 0xFFF) & ~0xFFF  # hbin aligned to 4KB

    regf = bytearray(0x1000)
    regf[0:4] = b"regf"
    struct.pack_into("<I", regf, 0x24, root_rel)          # root cell rel offset
    struct.pack_into("<I", regf, 0x28, hbins_size)        # hbinsSize

    hbin = bytearray(hbins_size)
    hbin[0:4] = b"hbin"
    struct.pack_into("<I", hbin, 0x04, 0)                 # file offset of hbin
    struct.pack_into("<I", hbin, 0x08, hbins_size)        # hbin size
    # buf already includes the 0x20 header region — write it verbatim so
    # buf offsets equal hive-relative cell offsets.
    hbin[0:len(hbin_data)] = hbin_data

    return bytes(regf) + bytes(hbin)


# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description="Synthetic BCD hive generator (NG-T5)")
    ap.add_argument("--out", required=True, help="output BCD file path")
    ap.add_argument("--partition-guid", help="GPT partition GUID for osdevice")
    ap.add_argument("--disk-guid", default="0" * 32,
                    help="GPT disk GUID (default zero)")
    ap.add_argument("--mbr", metavar="SIG:OFFSET",
                    help="emit MBR osdevice: SIG=disk sig hex, OFFSET=partition byte offset hex")
    ap.add_argument("--boot-device", action="store_true",
                    help="emit a type-5 boot device (no partition leaf)")
    ap.add_argument("--objects", type=int, default=1,
                    help="number of osloader objects (default 1)")
    args = ap.parse_args()

    blobs = []
    for i in range(args.objects):
        if args.boot_device:
            blobs.append(build_boot_blob())
        elif args.mbr:
            sig_s, off_s = args.mbr.split(":")
            part_id = struct.pack("<Q", int(off_s, 16))
            disk_id = bytes.fromhex(sig_s).ljust(16, b"\x00")
            blobs.append(build_partition_blob(part_id, disk_id, 1))
        elif args.partition_guid:
            part_id = _guid_bytes(args.partition_guid)
            disk_id = bytes.fromhex(args.disk_guid.replace("-", ""))
            blobs.append(build_partition_blob(part_id, disk_id, 0))
        else:
            print("error: need --partition-guid, --mbr, or --boot-device",
                  file=sys.stderr)
            sys.exit(2)

    hive = build_hive(blobs)
    with open(args.out, "wb") as f:
        f.write(hive)
    print(f"[OK] BCD hive written: {len(hive)} bytes -> {args.out} "
          f"({len(blobs)} osloader object(s))")


if __name__ == "__main__":
    main()
