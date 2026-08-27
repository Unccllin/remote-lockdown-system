#!/usr/bin/env python3
"""
DNS Tunnel Client — Anti-Theft Covert Check-in Channel

Sends data to the DNS tunnel server by encoding it as base32 in DNS query
subdomain labels. Receives response data from TXT records.

Protocol:
  - Split data into chunks (max 57 bytes per chunk → 92 base32 chars)
  - Each chunk: <session>.<seq>.<base32chunk>.<domain>
  - End marker: <session>.end.<domain>
  - Response: TXT record contains base32-encoded server response

Usage:
  python3 dns-tunnel-client.py --server 127.0.0.1 --port 5353 --domain tunnel.test

  # Send a custom message:
  python3 dns-tunnel-client.py --server 127.0.0.1 --message '{"device_id":"TEST-001","state":0}'

  # Interactive mode (send messages from stdin):
  python3 dns-tunnel-client.py --server 127.0.0.1 --interactive
"""

import argparse
import base64
import hashlib
import json
import logging
import os
import socket
import sys
import time
from dnslib import DNSRecord, QTYPE, RR, TXT

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [CLIENT] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("dns-tunnel")

# --- Constants ---
MAX_CHUNK_SIZE = 30  # bytes (→ 48 base32 chars, fits in one DNS label of 63)
MAX_LABEL_LEN = 63   # DNS label max length
SESSION_ID_LEN = 8   # hex session ID


class DnsTunnelClient:
    """Sends data to a DNS tunnel server via DNS queries."""

    def __init__(self, server: str, port: int, domain: str):
        self.server = server
        self.port = port
        self.domain = domain.lower().rstrip(".")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(5.0)

    def send_message(self, data: bytes) -> bytes:
        """
        Send data via DNS tunnel and return the server's response.
        Data is split into chunks, each sent as a separate DNS query.
        """
        session_id = hashlib.md5(os.urandom(16)).hexdigest()[:SESSION_ID_LEN]
        log.info(f"Session {session_id}: sending {len(data)} bytes")

        # Split data into chunks
        chunks = []
        for i in range(0, len(data), MAX_CHUNK_SIZE):
            chunks.append(data[i:i + MAX_CHUNK_SIZE])

        if not chunks:
            chunks = [b""]

        # Send each chunk
        for seq, chunk in enumerate(chunks):
            encoded = base64.b32encode(chunk).decode().rstrip("=").lower()
            # Split encoded data into labels of max 63 chars each
            data_labels = []
            for i in range(0, len(encoded), MAX_LABEL_LEN):
                data_labels.append(encoded[i:i + MAX_LABEL_LEN])
            if not data_labels:
                data_labels = ["x"]  # placeholder for empty chunks
            query_name = f"{session_id}.{seq}.{'.'.join(data_labels)}.{self.domain}"

            # Verify total name length (max 253 bytes)
            if len(query_name) > 253:
                log.warning(f"  Query name too long ({len(query_name)}), truncating data")
                # Reduce chunk and retry — shouldn't happen with MAX_CHUNK_SIZE=30
                query_name = query_name[:253]

            log.info(f"  Chunk {seq}: {len(chunk)} bytes → {len(data_labels)} label(s)")
            response = self._send_dns_query(query_name)

        # Send end marker
        end_name = f"{session_id}.end.{self.domain}"
        log.info(f"  End marker: {end_name}")
        response = self._send_dns_query(end_name)

        # Extract response from TXT record
        return self._extract_txt_response(response)

    def _send_dns_query(self, query_name: str) -> bytes:
        """Send a DNS A/TXT query and return the raw response."""
        # Build DNS query (request TXT records)
        q = DNSRecord.question(query_name, qtype="TXT")
        packet = q.pack()

        try:
            self.sock.sendto(packet, (self.server, self.port))
            response_packet, addr = self.sock.recvfrom(4096)
            return response_packet
        except socket.timeout:
            log.warning(f"  Timeout for query: {query_name[:50]}...")
            return b""
        except Exception as e:
            log.error(f"  Error: {e}")
            return b""

    def _extract_txt_response(self, response_packet: bytes) -> bytes:
        """Extract TXT record data from DNS response."""
        if not response_packet:
            return b""

        try:
            response = DNSRecord.parse(response_packet)
            for rr in response.rr:
                if rr.rtype == QTYPE.TXT:
                    # TXT rdata is a list of strings
                    txt_data = str(rr.rdata)
                    # Remove quotes and decode base32
                    txt_data = txt_data.strip("'\"")
                    # Pad base32 to multiple of 8
                    padded = txt_data.upper() + "=" * ((8 - len(txt_data) % 8) % 8)
                    decoded = base64.b32decode(padded)
                    return decoded
            return b""
        except Exception as e:
            log.warning(f"  Parse error: {e}")
            return b""


def make_checkin_message(device_id: str = None, state: int = 0) -> bytes:
    """Create a check-in message as JSON."""
    msg = {
        "device_id": device_id or f"DEV-{hashlib.md5(os.urandom(4)).hexdigest()[:6].upper()}",
        "state": state,
        "timestamp": int(time.time()),
        "agent_version": "0.1.0-dns-tunnel",
    }
    return json.dumps(msg, separators=(",", ":")).encode()


def main():
    parser = argparse.ArgumentParser(description="DNS Tunnel Client")
    parser.add_argument("--server", default="127.0.0.1", help="DNS server address")
    parser.add_argument("--port", type=int, default=5353, help="DNS server port")
    parser.add_argument("--domain", default="tunnel.test", help="Tunnel domain")
    parser.add_argument("--device-id", default=None, help="Device ID for check-in")
    parser.add_argument("--state", type=int, default=0, help="Agent state (0=dormant, 1=activated)")
    parser.add_argument("--message", default=None, help="Custom message to send")
    parser.add_argument("--interactive", action="store_true", help="Interactive mode (read from stdin)")
    args = parser.parse_args()

    client = DnsTunnelClient(args.server, args.port, args.domain)

    if args.interactive:
        log.info(f"Interactive mode. Server: {args.server}:{args.port}, Domain: {args.domain}")
        log.info("Type messages to send, Ctrl+D to exit.")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            response = client.send_message(line.encode())
            log.info(f"Response: {response.decode('utf-8', errors='replace')}")
    elif args.message:
        response = client.send_message(args.message.encode())
        log.info(f"Response: {response.decode('utf-8', errors='replace')}")
    else:
        # Default: send a check-in message
        msg = make_checkin_message(args.device_id, args.state)
        log.info(f"Sending check-in: {msg.decode()}")
        response = client.send_message(msg)
        if response:
            log.info(f"Server response: {response.decode('utf-8', errors='replace')}")
            try:
                resp_json = json.loads(response)
                if resp_json.get("action") == "activate":
                    log.info(">>> SERVER SAYS: ACTIVATE DEVICE <<<")
            except json.JSONDecodeError:
                pass
        else:
            log.warning("No response from server")


if __name__ == "__main__":
    main()
