#!/usr/bin/env python3
"""
DNS Tunnel Server — Anti-Theft Covert Check-in Channel

Listens for DNS queries on a UDP port. Extracts data encoded in subdomain
labels, and responds with data encoded in TXT records.

Protocol:
  - Client encodes data as base32 in subdomain: <data>.t.<domain>
  - Server decodes data from the query name
  - Server responds with TXT record containing base32-encoded response data
  - Session ID in first label for tracking (e.g., <session>.<seq>.<data>.t.<domain>)

Usage:
  python3 dns-tunnel-server.py [--port 5353] [--domain tunnel.test]

Test:
  # Start server
  python3 dns-tunnel-server.py --port 5353 --domain tunnel.test

  # From another terminal, use the client:
  python3 dns-tunnel-client.py --server 127.0.0.1 --port 5353 --domain tunnel.test
"""

import argparse
import base64
import hashlib
import json
import logging
import socket
import struct
import sys
import time
from collections import defaultdict
from dnslib import DNSRecord, DNSHeader, DNSQuestion, RR, QTYPE, TXT, A
from dnslib.server import DNSServer, DNSHandler, BaseResolver

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SERVER] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("dns-tunnel")


class DnsTunnelResolver(BaseResolver):
    """Resolves DNS queries by extracting tunneled data from subdomain labels."""

    def __init__(self, domain: str):
        self.domain = domain.lower().rstrip(".")
        # Session tracking: session_id -> {seq: data}
        self.sessions = defaultdict(dict)
        # Pending responses for sessions
        self.responses = {}

    def resolve(self, request, handler):
        """Handle a DNS query request."""
        qname = str(request.q.qname).lower().rstrip(".")
        qtype = request.q.qtype

        log.info(f"Query: {qname} type={QTYPE[qtype]}")

        # Check if this is a tunnel query (ends with our domain)
        if not qname.endswith(self.domain):
            # Not our domain — return NXDOMAIN or default A record
            reply = DNSRecord(
                DNSHeader(id=request.header.id, qr=1, rcode=3),  # NXDOMAIN
                q=request.q,
            )
            return reply

        # Parse the tunnel protocol from subdomain labels
        # Format: <session>.<seq>.<data>.<domain>
        # Or:    <session>.<seq>.<data>.t.<domain>
        # Or:    <session>.end.<domain>  (end of session)
        labels = qname[: -len(self.domain)].rstrip(".")
        parts = labels.split(".") if labels else []

        if len(parts) < 2:
            return self._make_response(request, "ERR:format")

        session_id = parts[0]
        seq_or_cmd = parts[1]

        # Handle session end
        if seq_or_cmd == "end":
            log.info(f"Session {session_id} ended")
            assembled = self._assemble_session(session_id)
            self._process_checkin(session_id, assembled)
            # Clear session data
            response_data = self.responses.pop(session_id, b"OK:end")
            del self.sessions[session_id]
            return self._make_response(request, response_data)

        # Handle data chunk
        try:
            seq = int(seq_or_cmd)
        except ValueError:
            return self._make_response(request, "ERR:seq")

        # Remaining parts are the data (base32-encoded, may span multiple labels)
        data_parts = parts[2:]
        if data_parts:
            # Join all data labels and decode base32
            encoded = "".join(data_parts)
            try:
                # base32 uses uppercase A-Z, 2-7. DNS is case-insensitive.
                # Pad to multiple of 8
                padded = encoded.upper() + "=" * ((8 - len(encoded) % 8) % 8)
                decoded = base64.b32decode(padded)
                self.sessions[session_id][seq] = decoded
                log.info(f"Session {session_id} seq {seq}: {len(decoded)} bytes received")
            except Exception as e:
                log.warning(f"Decode error: {e}")
                return self._make_response(request, "ERR:decode")

        # Check if we have a pending response for this session
        response_data = self.responses.get(session_id, b"OK:ack")
        return self._make_response(request, response_data)

    def _assemble_session(self, session_id: str) -> bytes:
        """Assemble all chunks for a session in order."""
        chunks = self.sessions.get(session_id, {})
        if not chunks:
            return b""
        assembled = b""
        for seq in sorted(chunks.keys()):
            assembled += chunks[seq]
        return assembled

    def _process_checkin(self, session_id: str, data: bytes):
        """Process a completed check-in message from the client."""
        log.info(f"=== Check-in from session {session_id} ===")
        try:
            # Try to parse as JSON
            msg = json.loads(data.decode("utf-8"))
            log.info(f"  Device ID: {msg.get('device_id', 'unknown')}")
            log.info(f"  State: {msg.get('state', 'unknown')}")
            log.info(f"  Timestamp: {msg.get('timestamp', 'unknown')}")
            log.info(f"  Raw: {data.decode('utf-8', errors='replace')}")

            # Generate response (e.g., activation command)
            if msg.get("state") == 0:  # dormant
                response = json.dumps({
                    "action": "activate",
                    "message": "Device activated via DNS tunnel",
                    "server_time": int(time.time()),
                }).encode()
            else:
                response = json.dumps({
                    "action": "ack",
                    "message": "Check-in received",
                    "server_time": int(time.time()),
                }).encode()
            self.responses[session_id] = response
        except (json.JSONDecodeError, UnicodeDecodeError):
            log.info(f"  Raw data ({len(data)} bytes): {data[:64].hex()}...")
            self.responses[session_id] = b"OK:raw"

    def _make_response(self, request, response_data) -> DNSRecord:
        """Build a DNS response with the data in a TXT record."""
        # Encode response data as base32 (DNS-safe)
        if isinstance(response_data, str):
            response_data = response_data.encode()
        encoded = base64.b32encode(response_data).decode().rstrip("=").lower()

        reply = DNSRecord(
            DNSHeader(id=request.header.id, qr=1, aa=1, rcode=0),
            q=request.q,
        )
        # Add TXT record with the encoded response
        reply.add_answer(
            RR(request.q.qname, QTYPE.TXT, rdata=TXT(encoded), ttl=0)
        )
        # Also add an A record (some clients expect one)
        reply.add_answer(
            RR(request.q.qname, QTYPE.A, rdata=A("127.0.0.1"), ttl=0)
        )
        return reply


def main():
    parser = argparse.ArgumentParser(description="DNS Tunnel Server")
    parser.add_argument("--port", type=int, default=5353, help="UDP port to listen on")
    parser.add_argument("--domain", default="tunnel.test", help="Tunnel domain")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    args = parser.parse_args()

    resolver = DnsTunnelResolver(args.domain)
    server = DNSServer(resolver, port=args.port, address=args.host)

    log.info(f"DNS Tunnel Server starting on {args.host}:{args.port}")
    log.info(f"Tunnel domain: {args.domain}")
    log.info(f"Protocol: <session>.<seq>.<base32data>.{args.domain}")
    log.info("Waiting for check-ins...")

    try:
        server.start()
    except KeyboardInterrupt:
        log.info("Server stopped")
        server.stop()


if __name__ == "__main__":
    main()
