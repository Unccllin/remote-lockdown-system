#!/usr/bin/env python3
"""test-d205.py — D-205 test harness: generate keys, policy, and mock verdict server.

Generates:
  1. P-256 ECDSA key pair
  2. Self-signed X.509 cert with that key
  3. Test policy blob (COSE_Sign1) with keys 70, 71, 76, 77
  4. Mock HTTP verdict server that signs verdicts with the private key

Usage:
  python3 test-d205.py --generate-policy <output-path>
  python3 test-d205.py --serve [--port 8080]

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

import argparse
import hashlib
import json
import os
import signal
import struct
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

import cbor2

# ============================================================================
# Key and cert generation
# ============================================================================

KEY_PATH = "/tmp/pbl-d205-key.pem"
CERT_PATH = "/tmp/pbl-d205-cert.der"
ROOT_CERT_PATH = "/tmp/pbl-d205-root-cert.der"
INT_CERT_PATH = "/tmp/pbl-d205-int-cert.der"
SPKI_PATH = "/tmp/pbl-d205-spki.der"
KID_PATH = "/tmp/pbl-d205-kid.bin"
POLICY_DIR = "/tmp/pbl-d205"


def generate_key_and_cert():
    """Generate a P-256 root CA + intermediate CA + leaf cert.

    Chain: root CA (self-signed) → intermediate CA → leaf (verdict signer).
    Returns (leaf_private_key, leaf_cert_der, leaf_spki_der, kid,
             root_cert_der, intermediate_cert_der).
    """
    # Generate root CA key pair
    root_key = ec.generate_private_key(ec.SECP256R1())
    root_subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "PBL Test Root CA"),
    ])
    root_cert = (
        x509.CertificateBuilder()
        .subject_name(root_subject)
        .issuer_name(root_subject)  # self-signed
        .public_key(root_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2026, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(datetime(2036, 1, 1, tzinfo=timezone.utc))
        .add_extension(x509.BasicConstraints(ca=True, path_length=1), critical=True)
        .sign(root_key, hashes.SHA256())
    )
    root_cert_der = root_cert.public_bytes(serialization.Encoding.DER)

    # Generate intermediate CA key pair (signed by root CA)
    int_key = ec.generate_private_key(ec.SECP256R1())
    int_subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "PBL Test Intermediate CA"),
    ])
    int_cert = (
        x509.CertificateBuilder()
        .subject_name(int_subject)
        .issuer_name(root_subject)  # signed by root CA
        .public_key(int_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2026, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(datetime(2036, 1, 1, tzinfo=timezone.utc))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(root_key, hashes.SHA256())
    )
    int_cert_der = int_cert.public_bytes(serialization.Encoding.DER)

    # Generate leaf (verdict signing) key pair (signed by intermediate CA)
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    leaf_subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "PBL Test Verdict Signer"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(leaf_subject)
        .issuer_name(int_subject)  # signed by intermediate CA
        .public_key(public_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2026, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(datetime(2036, 1, 1, tzinfo=timezone.utc))
        .sign(int_key, hashes.SHA256())  # signed by intermediate CA key
    )

    # Export
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    spki_der = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    kid = hashlib.sha256(spki_der).digest()

    # Save private key
    with open(KEY_PATH, "wb") as f:
        f.write(private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))

    # Save leaf cert DER
    with open(CERT_PATH, "wb") as f:
        f.write(cert_der)

    # Save root cert DER
    with open(ROOT_CERT_PATH, "wb") as f:
        f.write(root_cert_der)

    # Save intermediate cert DER
    with open(INT_CERT_PATH, "wb") as f:
        f.write(int_cert_der)

    # Save SPKI DER
    with open(SPKI_PATH, "wb") as f:
        f.write(spki_der)

    # Save kid
    with open(KID_PATH, "wb") as f:
        f.write(kid)

    print(f"[OK] P-256 key pair + root CA + intermediate CA generated")
    print(f"  Leaf cert DER: {len(cert_der)} bytes -> {CERT_PATH}")
    print(f"  Intermediate cert DER: {len(int_cert_der)} bytes -> {INT_CERT_PATH}")
    print(f"  Root cert DER: {len(root_cert_der)} bytes -> {ROOT_CERT_PATH}")
    print(f"  SPKI DER: {len(spki_der)} bytes -> {SPKI_PATH}")
    print(f"  kid (SHA-256 of SPKI): {kid.hex()} -> {KID_PATH}")
    print(f"  Private key: {KEY_PATH}")

    return private_key, cert_der, spki_der, kid, root_cert_der, int_cert_der


def load_key_and_cert():
    """Load key and cert from files, generating if needed."""
    if not os.path.exists(KEY_PATH):
        return generate_key_and_cert()

    with open(KEY_PATH, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    with open(CERT_PATH, "rb") as f:
        cert_der = f.read()
    with open(ROOT_CERT_PATH, "rb") as f:
        root_cert_der = f.read()
    with open(INT_CERT_PATH, "rb") as f:
        int_cert_der = f.read()
    with open(SPKI_PATH, "rb") as f:
        spki_der = f.read()
    with open(KID_PATH, "rb") as f:
        kid = f.read()

    return private_key, cert_der, spki_der, kid, root_cert_der, int_cert_der


# ============================================================================
# CBOR / COSE_Sign1 helpers
# ============================================================================

COSE_ALG_ES256 = -7


def cbor_encode_uint(value):
    """Encode an unsigned integer in CBOR."""
    return cbor2.dumps(value)


def cbor_encode_nint(value):
    """Encode a negative integer in CBOR."""
    return cbor2.dumps(value)


def cbor_encode_bstr(data):
    """Encode a byte string in CBOR."""
    return cbor2.dumps(data)


def cbor_encode_tstr(text):
    """Encode a text string in CBOR."""
    return cbor2.dumps(text)


def cbor_encode_map(pairs):
    """Encode a CBOR map from a list of (key, value) pairs."""
    # cbor2 handles maps natively
    return cbor2.dumps(dict(pairs))


def cbor_encode_array(items):
    """Encode a CBOR array."""
    return cbor2.dumps(items)


def build_protected_header(alg, kid):
    """Build COSE protected header: {1: alg, 4: kid}."""
    return cbor2.dumps({1: alg, 4: kid})


def build_sig_structure(protected_header, payload):
    """Build Sig_structure: ["Signature1", protected, empty_aad, payload]."""
    return cbor2.dumps(["Signature1", protected_header, b"", payload])


def sign_es256(private_key, data):
    """Sign data with ECDSA P-256 SHA-256, return raw r||s (64 bytes)."""
    der_sig = private_key.sign(data, ec.ECDSA(hashes.SHA256()))
    # Convert DER signature to raw r||s
    r, s = utils.decode_dss_signature(der_sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def encode_cose_sign1(payload, private_key, kid):
    """Encode a complete COSE_Sign1 structure with ES256 signature."""
    protected_header = build_protected_header(COSE_ALG_ES256, kid)
    sig_structure = build_sig_structure(protected_header, payload)
    signature = sign_es256(private_key, sig_structure)

    # COSE_Sign1 = [protected, unprotected, payload, signature]
    return cbor2.dumps([protected_header, {}, payload, signature])


# ============================================================================
# Policy blob generation
# ============================================================================

def generate_policy(output_path, lock_service_uri="http://10.0.2.2:8080/v1/verdict", bootmgr_hash=None):
    """Generate a test policy blob with keys 70, 71, 76, 77, and optionally 58."""
    private_key, cert_der, spki_der, kid, root_cert_der, int_cert_der = load_key_and_cert()

    # Build the policy payload (CBOR map)
    # Key 1: version (uint)
    # Key 2: issued_at (uint) — MUST be uint, not tstr!
    # Key 58: bootmgr_hash (bstr 32) — RE-hardening #2
    # Key 70: lock_service_uri (tstr)
    # Key 71: lock_service_cert_pin (bstr 32) = SHA-256 of SPKI = kid
    # Key 76: verdict_signing_key_spki (bstr) = SPKI DER
    # Key 77: signing_cert_chain (array of bstr) = [leaf, intermediate, root]
    policy_map = {
        1: 1,                    # version
        2: 0,                    # issued_at (uint!)
        70: lock_service_uri,    # lock_service_uri
        71: kid,                 # lock_service_cert_pin
        76: spki_der,            # verdict_signing_key_spki
        77: [cert_der, int_cert_der, root_cert_der],  # 3-cert chain
    }
    if bootmgr_hash is not None:
        if isinstance(bootmgr_hash, str):
            bootmgr_hash = bytes.fromhex(bootmgr_hash)
        policy_map[58] = bootmgr_hash
    policy_payload = cbor2.dumps(policy_map)

    # D-215: Sign the policy blob with the policy signing key when it is
    # provisioned (.pbl_policy_signing_key, base64 PKCS8 — produced by
    # gen-policy-rot.py). With a RoT-provisioned firmware build the dummy
    # signature would trigger the fail-closed BLOCK path; with a dev build
    # PblVerifyPolicySignature returns EFI_UNSUPPORTED and either works.
    policy_key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "..", "..", ".pbl_policy_signing_key")
    if os.path.exists(policy_key_file):
        import base64
        with open(policy_key_file, "rb") as f:
            policy_key = serialization.load_der_private_key(
                base64.b64decode(f.read().strip()), password=None)
        policy_spki = policy_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        policy_kid = hashlib.sha256(policy_spki).digest()
        policy_cose = encode_cose_sign1(policy_payload, policy_key, policy_kid)
        print(f"  policy signature: ES256 by policy key (kid {policy_kid.hex()[:16]}...)")
    else:
        # Dev mode: dummy signature — firmware returns EFI_UNSUPPORTED.
        protected_header = build_protected_header(COSE_ALG_ES256, kid)
        policy_cose = cbor2.dumps([protected_header, {}, policy_payload, b"\x00" * 64])

    # Write to file
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(policy_cose)

    print(f"[OK] Policy blob generated: {len(policy_cose)} bytes -> {output_path}")
    print(f"  lock_service_uri: {lock_service_uri}")
    print(f"  kid: {kid.hex()}")
    print(f"  cert_der: {len(cert_der)} bytes")
    print(f"  spki_der: {len(spki_der)} bytes")
    if 58 in policy_map:
        print(f"  bootmgr_hash: {policy_map[58].hex()}")

    return policy_cose


# ============================================================================
# Mock verdict server
# ============================================================================

class VerdictHandler(BaseHTTPRequestHandler):
    """HTTP handler that returns a signed COSE_Sign1 verdict."""

    def do_POST(self):
        if self.path != "/v1/verdict":
            self.send_response(404)
            self.end_headers()
            return

        # Read the request body
        content_length = int(self.headers.get("Content-Length", 0))
        request_body = self.rfile.read(content_length)
        print(f"[SERVER] Received {len(request_body)} bytes from PBL")

        # Parse the request to extract device_id and nonce (echo them back)
        # Request format: {1: device_id (bstr 32), 2: nonce (bstr 32),
        #                  3: platform_state_digest (bstr 32), 4: policy_version (uint)}
        device_id = b"\x00" * 32
        nonce = b"\x00" * 32
        try:
            req = cbor2.loads(request_body)
            device_id = req.get(1, device_id)
            nonce = req.get(2, nonce)
            print(f"[SERVER] device_id: {device_id[:4].hex()}... nonce: {nonce[:4].hex()}...")
        except Exception as e:
            print(f"[SERVER] Failed to parse request: {e}")

        # Build the verdict payload (CBOR map)
        # Key 1: version (uint)
        # Key 2: device_id (bstr 32) — echo back from request
        # Key 3: nonce (bstr 32) — echo back from request
        # Key 4: verdict (uint) = 0 (ALLOW)
        # Key 5: policy_version (uint) = 1
        # Key 6: issued_at (uint)
        # Key 7: grace_until (uint)
        # Key 8: reason (tstr)
        now = int(datetime.now(timezone.utc).timestamp())
        verdict_payload = cbor2.dumps({
            1: 1,                    # version
            2: device_id,            # device_id (echoed from request)
            3: nonce,                # nonce (echoed from request)
            4: 0,                    # verdict = ALLOW
            5: 1,                    # policy_version
            6: now,                  # issued_at
            7: now + 3600,           # grace_until
            8: "test",              # reason
        })

        # Sign the verdict with ES256
        private_key, cert_der, spki_der, kid, root_cert_der, int_cert_der = load_key_and_cert()
        verdict_cose = encode_cose_sign1(verdict_payload, private_key, kid)

        print(f"[SERVER] Returning {len(verdict_cose)} bytes signed verdict")
        print(f"  verdict=0 (ALLOW), policy_version=1, version=1")
        print(f"  signature: ES256 (raw r||s, 64 bytes)")

        self.send_response(200)
        self.send_header("Content-Type", "application/cose")
        self.send_header("Content-Length", str(len(verdict_cose)))
        self.end_headers()
        self.wfile.write(verdict_cose)

    def log_message(self, format, *args):
        pass  # Suppress default logging


def serve(port=8080):
    """Start the mock verdict server."""
    private_key, cert_der, spki_der, kid, root_cert_der, int_cert_der = load_key_and_cert()
    print(f"[OK] Mock verdict server starting on port {port}")
    print(f"  Endpoint: http://0.0.0.0:{port}/v1/verdict")
    print(f"  Algorithm: ES256 (ECDSA P-256 SHA-256)")
    print(f"  kid: {kid.hex()}")
    print(f"  Waiting for PBL verdict requests...")

    server = HTTPServer(("0.0.0.0", port), VerdictHandler)

    def handle_sigterm(sig, frame):
        print("\n[SERVER] Shutting down...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sigterm)
    signal.signal(signal.SIGTERM, handle_sigterm)

    server.serve_forever()


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="D-205 test harness")
    parser.add_argument("--generate-policy", metavar="PATH",
                        help="Generate test policy blob and write to PATH")
    parser.add_argument("--generate-keys", action="store_true",
                        help="Generate new P-256 key pair and self-signed cert")
    parser.add_argument("--serve", action="store_true",
                        help="Start mock verdict server")
    parser.add_argument("--port", type=int, default=8080,
                        help="Port for mock server (default: 8080)")
    parser.add_argument("--uri", default="http://10.0.2.2:8080/v1/verdict",
                        help="lock_service_uri for policy (default: http://10.0.2.2:8080/v1/verdict)")
    parser.add_argument("--bootmgr-hash", default=None,
                        help="SHA-256 of bootmgfw.efi for policy key 58 (hex)")

    args = parser.parse_args()

    if args.generate_keys:
        load_key_and_cert()
    elif args.generate_policy:
        generate_policy(args.generate_policy, args.uri, args.bootmgr_hash)
    elif args.serve:
        serve(args.port)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
