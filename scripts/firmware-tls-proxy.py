#!/usr/bin/env python3
"""firmware-tls-proxy.py - TLS front for the firmware, forwarding to the Express API.

Why this exists
---------------
PblApp refuses plaintext http:// in release builds (C3 section 4), so it cannot talk to the
Express API directly. scripts/firmware-tls-proxy.js does the same job with Node, but the
firmware completes the TLS handshake against Node and then resets before sending the
request (S234), while it works against the Python ssl server the D-131 harness uses (S232).
This is the control experiment: same forwarding behaviour, Python's ssl instead of Node's
TLS stack.

Usage:
    python3 scripts/firmware-tls-proxy.py \
        --cert /tmp/assets/server-cert.pem --key /tmp/assets/server-key.pem \
        --port 9443 --target http://127.0.0.1:3001

Every request is logged with its size, and the negotiated protocol and cipher are logged on
each connection, because "the firmware reached OUR server" and "which TLS settings it
accepted" are the two facts this proxy exists to make observable.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class ForwardingHandler(http.server.BaseHTTPRequestHandler):
    """Forward every request to the target and return its response verbatim."""

    target = "http://127.0.0.1:3001"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102 - quieter default
        return

    def _forward(self) -> None:
        # A header is attacker-adjacent input: a non-numeric Content-Length must not raise
        # inside a request handler (it would kill the connection with a traceback).
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            print("[proxy] non-numeric Content-Length; rejecting", file=sys.stderr, flush=True)
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if length < 0 or length > 64 * 1024:
            print(
                f"[proxy] unreasonable Content-Length {length}; rejecting",
                file=sys.stderr,
                flush=True,
            )
            self.send_response(413)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = self.rfile.read(length) if length else b""
        tls = self.connection
        try:
            proto = tls.version()
            cipher = tls.cipher()[0] if tls.cipher() else "?"
        except (AttributeError, IndexError):
            proto, cipher = "?", "?"
        print(
            f"[proxy] {self.command} {self.path} from {self.client_address[0]} -> "
            f"{len(body)} bytes ({proto} {cipher})",
            flush=True,
        )

        url = self.target + self.path
        # B310: urlopen is only safe for schemes this tool intends to speak. The target
        # scheme is validated at startup, but the URL is assembled per request, so it is
        # re-checked immediately before the call rather than assumed.
        if urllib.parse.urlparse(url).scheme not in ("http", "https"):
            print(f"[proxy] refusing non-HTTP target: {url}", file=sys.stderr, flush=True)
            self.send_response(400)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        # S310 is the scheme audit above, satisfied at runtime by the check just made; ruff
        # cannot see that relationship. Same pragma the agent's harness uses.
        request = urllib.request.Request(  # noqa: S310
            url,
            data=body if body else None,
            method=self.command,
            headers={
                "Content-Type": self.headers.get("Content-Type", "application/cbor"),
                "Content-Length": str(len(body)),
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
                payload = response.read()
                status = response.status
                content_type = response.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            status = exc.code
            content_type = exc.headers.get("Content-Type", "application/json")
        except (urllib.error.URLError, OSError) as exc:
            print(f"[proxy] upstream error: {exc}", file=sys.stderr, flush=True)
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        print(f"[proxy] <- {status} {len(payload)} bytes", flush=True)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    do_POST = _forward
    do_GET = _forward


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TLS front for the firmware -> Express")
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--port", type=int, default=9443)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--target", default="http://127.0.0.1:3001")
    parser.add_argument(
        "--tls12-only",
        action="store_true",
        help="cap at TLSv1.2 (EDK2 has no TLS 1.3)",
    )
    args = parser.parse_args(argv)

    try:
        target = urllib.parse.urlparse(args.target)
    except ValueError:
        print(f"invalid --target: {args.target}", file=sys.stderr)
        return 2
    if target.scheme not in ("http", "https") or not target.netloc:
        print(f"invalid --target (expected scheme://host[:port]): {args.target}", file=sys.stderr)
        return 2

    ForwardingHandler.target = args.target
    server = http.server.ThreadingHTTPServer((args.bind, args.port), ForwardingHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=args.cert, keyfile=args.key)
    if args.tls12_only:
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    server.socket = context.wrap_socket(server.socket, server_side=True)

    print(f"[proxy] listening on {args.bind}:{args.port} -> {args.target}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
