#!/usr/bin/env python3
"""d131-wire-capture.py — prove on the wire that the verdict request carries the
device_id PBL derived from the AK Name (D-200/D-131 runtime test).

Two modes, because the two halves run on different machines:

  --gen-assets DIR   Runs where `cryptography` and `cbor2` are available (the
                     development host). Writes a self-signed server certificate
                     with CN equal to the URI host, the matching key, and a
                     policy blob (C4) whose tls_ca_pin is the SHA-256 of that
                     leaf certificate — the pin C3 §4 requires PBL to enforce.

  --serve            Runs inside the QEMU harness container, which has neither
                     module. Uses only the standard library (ssl, http.server)
                     and a minimal CBOR reader that understands just enough to
                     pull device_id out of the request, then writes the raw
                     body to disk so the host can decode it authoritatively.

Why the request body is the artifact: D-131 showed the firmware derived a real
device_id but had no way to send it (no policy on the ESP). This closes that by
making the POST happen and keeping the bytes.

Usage:
  d131-wire-capture.py --gen-assets /tmp/assets --host 10.0.2.2 --port 8443
  d131-wire-capture.py --serve --assets /tmp/assets --port 8443 --out /tmp/captured

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import importlib
import os
import ssl
import sys

VERDICT_PATH = "/v1/verdict"


def write_file(path: str, data: bytes) -> None:
    """Write *data* to *path*, turning OSError into a message that says which file.

    A harness drives this tool, so a bare traceback would be the only diagnostic
    the operator sees. Naming the path and the reason is worth one helper.
    """
    try:
        with open(path, "wb") as handle:
            handle.write(data)
    except OSError as exc:
        raise SystemExit(f"ERROR: cannot write {path}: {exc}") from None


def make_dir(path: str) -> str:
    """Create *path* (absolute) and return it.

    abspath() rather than the raw argument: the path arrives from a command line
    and is then joined with fixed filenames, so normalising it once here keeps
    "../" segments from deciding where assets land.
    """
    resolved = os.path.abspath(path)
    try:
        os.makedirs(resolved, exist_ok=True)
    except OSError as exc:
        raise SystemExit(f"ERROR: cannot create {resolved}: {exc}") from None
    return resolved


# ============================================================================
# Minimal CBOR reader (decode only; stdlib-free)
# ============================================================================

class CborReader:
    """Reads the subset of CBOR a PBL verdict request uses (C3 §3.2)."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def _byte(self) -> int:
        if self.pos >= len(self.data):
            raise ValueError("truncated CBOR")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def _take(self, count: int) -> bytes:
        end = self.pos + count
        if end > len(self.data):
            raise ValueError("truncated CBOR")
        chunk = self.data[self.pos:end]
        self.pos = end
        return chunk

    def _length(self, info: int) -> int:
        if info < 24:
            return info
        if info == 24:
            return self._byte()
        if info == 25:
            return int.from_bytes(self._take(2), "big")
        if info == 26:
            return int.from_bytes(self._take(4), "big")
        if info == 27:
            return int.from_bytes(self._take(8), "big")
        raise ValueError(f"unsupported CBOR length info {info}")

    def read(self):
        initial = self._byte()
        major, info = initial >> 5, initial & 0x1F
        if major == 0:
            return self._length(info)
        if major == 1:
            return -1 - self._length(info)
        if major == 2:
            return self._take(self._length(info))
        if major == 3:
            return self._take(self._length(info)).decode("utf-8", "replace")
        if major == 5:
            out = {}
            for _ in range(self._length(info)):
                # Read into locals first: in `out[self.read()] = self.read()`
                # Python evaluates the RIGHT-hand side before the subscript, so
                # the value would be consumed as the key and every key shifted
                # one element — which is exactly what a captured request showed
                # (keys were the device_id bytes and the real keys became values).
                key = self.read()
                value = self.read()
                out[key] = value
            return out
        if major == 4:
            return [self.read() for _ in range(self._length(info))]
        raise ValueError(f"unsupported CBOR major type {major}")


def describe_request(body: bytes) -> str:
    """Render the fields of a verdict request for the log."""
    try:
        request = CborReader(body).read()
    except (ValueError, IndexError) as exc:
        return f"(undecodable request: {exc})"
    if not isinstance(request, dict):
        return "(request is not a map)"

    parts = []
    device_id = request.get(1)
    if isinstance(device_id, bytes):
        parts.append(f"device_id={device_id.hex()}")
    nonce = request.get(2)
    if isinstance(nonce, bytes):
        parts.append(f"nonce={nonce[:4].hex()}...")
    # A zero device_id is the D-131 defect; say so loudly rather than printing
    # a hex string that looks like any other.
    if isinstance(device_id, bytes) and device_id and not any(device_id):
        parts.append("DEVICE_ID_IS_ALL_ZERO")
    return " ".join(parts)


# ============================================================================
# --gen-assets (host side: cryptography + cbor2 available)
# ============================================================================

def generate_assets(out_dir: str, host: str, port: int, key_type: str = "ec") -> int:
    import datetime
    import ipaddress

    # Loaded dynamically: cbor2 and cryptography exist on the development host
    # (this mode's only supported environment) but not in the QEMU harness
    # container, and a static import would make that look like a broken module
    # to every analyser that resolves imports from the container's packages.
    cbor2 = importlib.import_module("cbor2")
    x509 = importlib.import_module("cryptography.x509")
    hashes = importlib.import_module("cryptography.hazmat.primitives.hashes")
    serialization = importlib.import_module(
        "cryptography.hazmat.primitives.serialization"
    )
    ec = importlib.import_module("cryptography.hazmat.primitives.asymmetric.ec")
    rsa = importlib.import_module("cryptography.hazmat.primitives.asymmetric.rsa")
    NameOID = importlib.import_module("cryptography.x509.oid").NameOID

    out_dir = make_dir(out_dir)
    now = datetime.datetime.now(datetime.timezone.utc)

    def _make_key():
        if key_type == "rsa":
            return rsa.generate_private_key(public_exponent=65537, key_size=2048)
        return ec.generate_private_key(ec.SECP256R1())

    # A real CA and a leaf it signs, rather than one self-signed certificate
    # wearing both hats. The single-certificate version is rejected by EDK2's
    # chain validation: a certificate used as a trust anchor needs
    # keyUsage keyCertSign, and hostname verification wants a SAN (the CN is
    # only a legacy fallback). Both were missing from the first attempt, whose
    # handshake was reset with no usable diagnostic from the release OVMF build.
    ca_key = _make_key()
    ca_name = x509.Name(
        [x509.NameAttribute(NameOID.COMMON_NAME, "PBL Wire Test CA")]
    )
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    ca_der = ca_cert.public_bytes(serialization.Encoding.DER)
    # Also written as PEM: lets the chain be verified with openssl independently
    # of the firmware, so a harness failure can be attributed to the certificate
    # or to the firmware rather than guessed at.
    write_file(
        os.path.join(out_dir, "ca-cert.pem"),
        ca_cert.public_bytes(serialization.Encoding.PEM),
    )

    key = _make_key()
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    try:
        san = x509.SubjectAlternativeName(
            [x509.IPAddress(ipaddress.ip_address(host))]
        )
    except ValueError:
        san = x509.SubjectAlternativeName([x509.DNSName(host)])

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(san, critical=False)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                # RSA key exchange needs keyEncipherment; ECDSA does not.
                key_encipherment=(key_type == "rsa"),
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    write_file(
        os.path.join(out_dir, "server-cert.pem"),
        cert.public_bytes(serialization.Encoding.PEM),
    )
    write_file(
        os.path.join(out_dir, "server-key.pem"),
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ),
    )

    uri = f"https://{host}:{port}{VERDICT_PATH}"
    # C4 keys: 1 version, 2 issued_at, 70 lock_service_uri, 73 tls_ca_pin,
    # 78 tls_ca_cert. Key 78 (D-132) is what makes the handshake possible at
    # all: EDK2's HTTP client validates the server chain against DER
    # certificates in the platform TlsCaCertificate store, and the 32-byte hash
    # in key 73 cannot satisfy that. Nothing else is needed to make the POST
    # happen — verdict signature verification only runs after a response is
    # decoded, and this harness is interested in the request.
    policy_map = {
        1: 1,
        2: 0,
        70: uri,
        78: ca_der,  # D-132: the CA itself, which EDK2 can consume
    }
    digest = hashes.Hash(hashes.SHA256())
    digest.update(ca_der)
    policy_map[73] = digest.finalize()  # pin the CA, not the leaf
    policy_payload = cbor2.dumps(policy_map)

    # Dev-build firmware has no policy root of trust pinned, so
    # PblVerifyPolicySignature returns EFI_UNSUPPORTED and the blob is accepted
    # with a warning. The COSE wrapper still has to be structurally valid.
    write_file(
        os.path.join(out_dir, "policy.cose"),
        cbor2.dumps([{1: -7, 4: policy_map[73]}, {}, policy_payload, b"\x00" * 64]),
    )

    print(f"[OK] assets in {out_dir}")
    print(f"  lock_service_uri: {uri}")
    print(f"  tls_ca_pin (sha256 of CA DER): {policy_map[73].hex()}")
    print(f"  tls_ca_cert (key 78): {len(ca_der)} bytes DER (the CA)")
    print(f"  server leaf: CN={host} with SAN, signed by the CA")
    return 0


# ============================================================================
# --serve (container side: stdlib only)
# ============================================================================

def serve(assets: str, port: int, out_dir: str | None, bind: str) -> int:
    assets = os.path.abspath(assets)
    # Default the capture directory inside the assets tree rather than a fixed
    # /tmp path: the caller already controls that directory, and a predictable
    # world-writable location is not somewhere to write evidence.
    out_dir = make_dir(out_dir or os.path.join(assets, "captured"))
    counter = {"n": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: N802 - stdlib naming
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                # A malformed length is the client's problem, not a crash for
                # the harness: answer 400 and keep serving.
                self.send_error(400, "bad Content-Length")
                return
            if length <= 0 or length > 65536:
                self.send_error(400, "unacceptable Content-Length")
                return
            body = self.rfile.read(length)

            counter["n"] += 1
            path = os.path.join(out_dir, f"request-{counter['n']}.bin")
            write_file(path, body)

            print(f"[SERVER] {self.path} {length} bytes -> {path}", flush=True)
            print(f"[SERVER] {describe_request(body)}", flush=True)

            # The harness only needs the request to arrive. Answer with a body
            # that is deliberately not a verdict, so the firmware takes its
            # documented fallback path (C3 §6.1) instead of pretending to have
            # a valid verdict it was never given.
            payload = b"captured"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args) -> None:  # noqa: A002 - matches base
            pass  # our own [SERVER] lines are the useful ones

    # Bound to loopback on purpose: QEMU's slirp maps the guest's 10.0.2.2 to the
    # host's loopback, so 127.0.0.1 is reachable by the firmware and by nothing
    # else on the network. Pass --bind to override deliberately.
    server = http.server.HTTPServer((bind, port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(
        os.path.join(assets, "server-cert.pem"),
        os.path.join(assets, "server-key.pem"),
    )
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"[SERVER] listening on {bind}:{port} (TLS)", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="D-131/D-200 wire capture")
    parser.add_argument("--gen-assets", metavar="DIR")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--assets", metavar="DIR")
    parser.add_argument("--host", default="10.0.2.2")
    parser.add_argument(
        "--key-type",
        choices=("ec", "rsa"),
        default="ec",
        help="server key type; OVMF may only negotiate RSA cipher suites",
    )
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--out", metavar="DIR", default=None)
    args = parser.parse_args(argv[1:])

    if args.gen_assets:
        return generate_assets(args.gen_assets, args.host, args.port, args.key_type)
    if args.serve:
        if not args.assets:
            print("ERROR: --serve needs --assets DIR", file=sys.stderr)
            return 2
        return serve(args.assets, args.port, args.out, args.bind)
    parser.print_usage(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
