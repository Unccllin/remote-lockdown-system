#!/usr/bin/env python3
"""gen-policy-rot.py — Provision the PBL policy signing key root of trust (D-215).

The policy signing key is a long-lived root key pinned in firmware (C4 §1).
This script:

  1. Generates (or loads) the policy signing key pair (ECDSA P-256 / ES256).
     The private key is stored as base64 PKCS8 in .pbl_policy_signing_key
     (gitignored) — the same format used by
     scripts/generate-policy-root-of-trust.js so server-side tooling can
     consume it.
  2. Creates a self-signed X.509 certificate for the policy key — required
     because BaseCryptLib only exposes EcGetPublicKeyFromX509 (no raw SPKI
     import), so PblVerifyPolicySignature needs cert DER bytes.
  3. Emits firmware/PblPkg/PblApp/PolicyRootOfTrust.generated.h containing
     gPblPolicySigningKeySpki / SpkiSize / Kid / Cert / CertSize.
  4. Emits signed policy.cose blobs for testing:
       --emit-policy PATH            valid policy signed by the policy key
       --emit-policy-wrongkey PATH   same blob + kid, signed by a WRONG key
                                     (exercises the ECDSA verify path)
       --emit-policy-tampered PATH   valid blob with one payload byte flipped
       --emit-policy-wrongkid PATH   signed by a wrong key with the wrong
                                     key's kid in the protected header

Usage:
  python3 gen-policy-rot.py --emit-header
  python3 gen-policy-rot.py --emit-policy policy-valid.cose \
      --emit-policy-wrongkey policy-bad.cose

Copyright (c) 2026 Remote Lockdown System. All rights reserved.
"""

import argparse
import base64
import hashlib
import os
import sys
from datetime import datetime, timezone

import cbor2
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.x509.oid import NameOID

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
KEY_FILE = os.path.join(REPO_ROOT, ".pbl_policy_signing_key")
HEADER_FILE = os.path.join(SCRIPT_DIR, "PblApp", "PolicyRootOfTrust.generated.h")

COSE_ALG_ES256 = -7


# ============================================================================
# Key + cert
# ============================================================================

def load_or_generate_policy_key():
    """Load the base64-PKCS8 policy signing key, or generate a fresh one."""
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "rb") as f:
            pkcs8 = base64.b64decode(f.read().strip())
        return serialization.load_der_private_key(pkcs8, password=None)

    key = ec.generate_private_key(ec.SECP256R1())
    pkcs8 = key.private_bytes(
        serialization.Encoding.DER,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with open(KEY_FILE, "wb") as f:
        f.write(base64.b64encode(pkcs8))
    os.chmod(KEY_FILE, 0o600)
    print(f"[OK] Generated policy signing key -> {KEY_FILE} (mode 600)")
    return key


def self_signed_cert(key, common_name):
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime(2026, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(datetime(2036, 1, 1, tzinfo=timezone.utc))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.DER)


def spki_of(key):
    return key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )


# ============================================================================
# COSE_Sign1
# ============================================================================

def sign_es256(key, data):
    der_sig = key.sign(data, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der_sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def encode_cose_sign1(payload, signing_key, kid):
    protected = cbor2.dumps({1: COSE_ALG_ES256, 4: kid})
    sig_structure = cbor2.dumps(["Signature1", protected, b"", payload])
    signature = sign_es256(signing_key, sig_structure)
    return cbor2.dumps([protected, {}, payload, signature])


def build_policy_payload(verdict_spki, verdict_kid, verdict_cert):
    """Policy map: keys 1,2,70,71,76,77 (same shape as test-d205.py)."""
    return cbor2.dumps({
        1: 1,                                          # version
        2: 0,                                          # issued_at (uint)
        70: "http://10.0.2.2:8080/v1/verdict",         # lock_service_uri
        71: verdict_kid,                               # lock_service_cert_pin
        76: verdict_spki,                              # verdict_signing_key_spki
        77: [verdict_cert],                            # signing_cert_chain
    })


# ============================================================================
# Header emission
# ============================================================================

def c_array(name, data, ctype="UINT8", per_line=12):
    lines = [f"static CONST {ctype} {name}[{len(data)}] = {{"]
    for i in range(0, len(data), per_line):
        chunk = data[i:i + per_line]
        lines.append("  " + ", ".join(f"0x{b:02x}" for b in chunk) + ",")
    lines.append("};")
    return "\n".join(lines)


def emit_header(policy_key, cert_der):
    spki = spki_of(policy_key)
    kid = hashlib.sha256(spki).digest()

    header = f"""/** @file
  PolicyRootOfTrust.generated.h — Auto-generated policy signing key root of trust.

  DO NOT EDIT BY HAND. Generated by firmware/PblPkg/gen-policy-rot.py.

  This file defines the pinned policy signing key SPKI (SubjectPublicKeyInfo
  DER), its SHA-256 fingerprint (kid), and the self-signed X.509 certificate
  DER used by PblVerifyPolicySignature() via EcGetPublicKeyFromX509.

  The corresponding private key is stored in .pbl_policy_signing_key (base64
  PKCS8, gitignored) for server-side use. In production, the private key
  lives in an offline root CA HSM and never leaves.

  Generated: {datetime.now(timezone.utc).isoformat()}
  SPKI size: {len(spki)} bytes
  Cert size: {len(cert_der)} bytes
  kid: {kid.hex()}
**/

#ifndef PBL_POLICY_ROOT_OF_TRUST_GENERATED_H_
#define PBL_POLICY_ROOT_OF_TRUST_GENERATED_H_

{c_array("gPblPolicySigningKeySpki", spki)}
static CONST UINTN gPblPolicySigningKeySpkiSize = {len(spki)};

{c_array("gPblPolicySigningKeyKid", kid)}

{c_array("gPblPolicySigningKeyCert", cert_der)}
static CONST UINTN gPblPolicySigningKeyCertSize = {len(cert_der)};

#endif // PBL_POLICY_ROOT_OF_TRUST_GENERATED_H_
"""
    with open(HEADER_FILE, "w") as f:
        f.write(header)
    print(f"[OK] Wrote root-of-trust header -> {HEADER_FILE}")
    print(f"     SPKI {len(spki)} bytes, cert {len(cert_der)} bytes, kid {kid.hex()}")


# ============================================================================
# Main
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description="D-215 policy RoT provisioning")
    parser.add_argument("--emit-header", action="store_true",
                        help="Emit PolicyRootOfTrust.generated.h")
    parser.add_argument("--emit-policy", metavar="PATH",
                        help="Emit a valid policy.cose signed by the policy key")
    parser.add_argument("--emit-policy-wrongkey", metavar="PATH",
                        help="Emit policy signed by a WRONG key (kid stays the policy kid)")
    parser.add_argument("--emit-policy-tampered", metavar="PATH",
                        help="Emit valid policy with one payload byte flipped")
    parser.add_argument("--emit-policy-wrongkid", metavar="PATH",
                        help="Emit policy signed by a wrong key with the wrong kid")
    args = parser.parse_args()

    if not any([args.emit_header, args.emit_policy, args.emit_policy_wrongkey,
                args.emit_policy_tampered, args.emit_policy_wrongkid]):
        parser.print_help()
        return 1

    policy_key = load_or_generate_policy_key()
    policy_spki = spki_of(policy_key)
    policy_kid = hashlib.sha256(policy_spki).digest()
    policy_cert = self_signed_cert(policy_key, "PBL Policy Signing Root")

    if args.emit_header:
        emit_header(policy_key, policy_cert)

    # The verdict signing key embedded in the policy (keys 71/76/77) is a
    # separate ephemeral key — the verdict fetch is not exercised here.
    verdict_key = ec.generate_private_key(ec.SECP256R1())
    verdict_spki = spki_of(verdict_key)
    verdict_kid = hashlib.sha256(verdict_spki).digest()
    verdict_cert = self_signed_cert(verdict_key, "PBL Test Verdict Signer")
    payload = build_policy_payload(verdict_spki, verdict_kid, verdict_cert)

    if args.emit_policy:
        blob = encode_cose_sign1(payload, policy_key, policy_kid)
        with open(args.emit_policy, "wb") as f:
            f.write(blob)
        print(f"[OK] Valid policy.cose ({len(blob)} bytes) -> {args.emit_policy}")

    if args.emit_policy_wrongkey:
        wrong_key = ec.generate_private_key(ec.SECP256R1())
        blob = encode_cose_sign1(payload, wrong_key, policy_kid)
        with open(args.emit_policy_wrongkey, "wb") as f:
            f.write(blob)
        print(f"[OK] Wrong-key policy.cose ({len(blob)} bytes) -> {args.emit_policy_wrongkey}")

    if args.emit_policy_tampered:
        # Sign the real payload, then flip one byte inside a large bstr value
        # (the verdict cert at key 77) and re-encode with the ORIGINAL
        # signature. The map stays structurally parseable so the failure is
        # the ECDSA signature check, not the CBOR parse (which would degrade).
        protected = cbor2.dumps({1: COSE_ALG_ES256, 4: policy_kid})
        sig_structure = cbor2.dumps(["Signature1", protected, b"", payload])
        sig = sign_es256(policy_key, sig_structure)
        tampered = bytearray(payload)
        tampered[len(payload) - 40] ^= 0xFF  # inside the cert bstr (key 77)
        blob = cbor2.dumps([protected, {}, bytes(tampered), sig])
        with open(args.emit_policy_tampered, "wb") as f:
            f.write(blob)
        print(f"[OK] Tampered policy.cose ({len(blob)} bytes) -> {args.emit_policy_tampered}")

    if args.emit_policy_wrongkid:
        wrong_key = ec.generate_private_key(ec.SECP256R1())
        wrong_spki = spki_of(wrong_key)
        wrong_kid = hashlib.sha256(wrong_spki).digest()
        blob = encode_cose_sign1(payload, wrong_key, wrong_kid)
        with open(args.emit_policy_wrongkid, "wb") as f:
            f.write(blob)
        print(f"[OK] Wrong-kid policy.cose ({len(blob)} bytes) -> {args.emit_policy_wrongkid}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
