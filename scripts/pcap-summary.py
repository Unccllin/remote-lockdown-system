#!/usr/bin/env python3
"""Summarise a QEMU filter-dump pcap without any external dependencies.

Why this exists
---------------
`test-d131-wire-harness.sh` drives a real PBL boot at a TLS server, and the fetch
aborts with EFI_ABORTED while the server sees no connection. The two candidate
causes are "the guest never transmitted" and "the guest transmitted and nothing
answered", and a packet capture is the only thing that distinguishes them.

The harness runs inside an image with no tcpdump, tshark, scapy or dpkt, so this
reads the classic libpcap format directly. It answers exactly one question: what
left the guest, and toward which address and port.

Usage:
  scripts/pcap-summary.py <file.pcap>

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

from __future__ import annotations

import collections
import pathlib
import struct
import sys

PCAP_MAGICS = {
    b"\xd4\xc3\xb2\xa1": ("<", "little"),
    b"\xa1\xb2\xc3\xd4": (">", "big"),
    b"\x4d\x3c\xb2\xa1": ("<", "little"),  # nanosecond variants
    b"\xa1\xb2\x3c\x4d": (">", "big"),
}

TCP_SYN = 0x02
TCP_RST = 0x04
TCP_ACK = 0x10


def read_packets(path: str):
    """Yield frame bytes from a classic pcap file.

    Read whole: a filter-dump capture for this harness is tens of kilobytes, and
    one read keeps the whole parse on a single explicit error path.
    """
    try:
        data = pathlib.Path(path).read_bytes()
    except OSError as exc:
        raise SystemExit(f"ERROR: cannot read {path}: {exc}") from None

    if len(data) < 24:
        raise SystemExit(f"ERROR: {path} is too short to be a pcap header")
    endian = PCAP_MAGICS.get(data[:4])
    if endian is None:
        raise SystemExit(
            f"ERROR: {path} is not a classic pcap (magic {data[:4]!r})"
        )
    order = endian[0]
    linktype = struct.unpack(order + "I", data[20:24])[0]
    if linktype != 1:
        raise SystemExit(f"ERROR: link type {linktype} is not Ethernet; not handled")

    offset = 24
    while offset + 16 <= len(data):
        _, _, captured, _ = struct.unpack(order + "IIII", data[offset : offset + 16])
        offset += 16
        frame = data[offset : offset + captured]
        offset += captured
        if len(frame) < captured:
            return
        yield frame


def describe(frame: bytes):
    """Return (kind, src, dst, extra) for an Ethernet/IPv4 packet."""
    if len(frame) < 14:
        return None
    ethertype = struct.unpack(">H", frame[12:14])[0]
    if ethertype != 0x0800:
        return ("non-ipv4", "-", "-", f"ethertype=0x{ethertype:04x}")
    ip = frame[14:]
    if len(ip) < 20:
        return None
    ihl = (ip[0] & 0x0F) * 4
    proto = ip[9]
    src = ".".join(str(b) for b in ip[12:16])
    dst = ".".join(str(b) for b in ip[16:20])
    if proto == 6:  # TCP
        tcp = ip[ihl:]
        if len(tcp) < 20:
            return ("tcp", src, dst, "truncated")
        sport, dport = struct.unpack(">HH", tcp[0:4])
        flags = tcp[13]
        names = []
        if flags & TCP_SYN:
            names.append("SYN")
        if flags & TCP_ACK:
            names.append("ACK")
        if flags & TCP_RST:
            names.append("RST")
        if flags & 0x01:
            names.append("FIN")
        return ("tcp", src, dst, f"{sport}->{dport} {'+'.join(names) or 'PSH'}")
    if proto == 17:  # UDP
        udp = ip[ihl:]
        if len(udp) < 8:
            return ("udp", src, dst, "truncated")
        sport, dport = struct.unpack(">HH", udp[0:4])
        return ("udp", src, dst, f"{sport}->{dport}")
    if proto == 1:
        return ("icmp", src, dst, "")
    return (f"ip-proto-{proto}", src, dst, "")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: pcap-summary.py <file.pcap>", file=sys.stderr)
        return 2

    totals = collections.Counter()
    flows = collections.Counter()
    syns = collections.Counter()

    for frame in read_packets(argv[1]):
        described = describe(frame)
        if described is None:
            continue
        kind, src, dst, extra = described
        totals[kind] += 1
        flows[f"{kind} {src} -> {dst} {extra}"] += 1
        if kind == "tcp" and "SYN" in extra:
            syns[extra.split(" ")[0]] += 1

    print(f"packets: {sum(totals.values())}")
    for kind, count in totals.most_common():
        print(f"  {kind}: {count}")
    print()
    print("flows (first 20):")
    for flow, count in flows.most_common(20):
        print(f"  {count:4d}  {flow}")
    if syns:
        print()
        print("TCP SYNs observed toward:")
        for port, count in syns.most_common():
            print(f"  {count:4d}  {port}")
    else:
        print()
        print("NO TCP SYN OBSERVED AT ALL — the guest never tried to connect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
