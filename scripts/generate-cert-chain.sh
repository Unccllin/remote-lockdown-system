#!/usr/bin/env bash
# generate-cert-chain.sh — Generate an X.509 cert chain for the policy signing key (D-205).
#
# Generates a 3-level certificate chain:
#   1. Root CA (self-signed, long-lived, pinned in firmware)
#   2. Intermediate CA (signed by root CA, medium-lived)
#   3. Leaf cert (signed by intermediate, short-lived, contains the policy signing key)
#
# The leaf cert's SPKI must match the policy signing key SPKI. This enables
# key rotation without firmware updates: issue a new leaf cert signed by the
# intermediate, and firmware will trust it because the chain goes back to the
# pinned root CA.
#
# In production, the root CA private key lives in an offline HSM and never
# leaves. This script is for development and testing.
#
# Usage:
#   bash scripts/generate-cert-chain.sh [--force]
#
# Output files (all gitignored):
#   .pbl_cert_chain/root-ca.key         — Root CA private key (PEM)
#   .pbl_cert_chain/root-ca.crt         — Root CA cert (PEM)
#   .pbl_cert_chain/root-ca.der         — Root CA cert (DER, for firmware pinning)
#   .pbl_cert_chain/intermediate.key    — Intermediate CA private key (PEM)
#   .pbl_cert_chain/intermediate.crt    — Intermediate CA cert (PEM)
#   .pbl_cert_chain/intermediate.der    — Intermediate CA cert (DER)
#   .pbl_cert_chain/leaf.key            — Leaf private key (PEM)
#   .pbl_cert_chain/leaf.crt            — Leaf cert (PEM)
#   .pbl_cert_chain/leaf.der            — Leaf cert (DER)
#   .pbl_cert_chain/chain.der           — Concatenated DER chain [leaf, intermediate, root CA]
#
# The chain.der file is what gets embedded in the policy blob (C4 key 77).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$REPO_ROOT/.pbl_cert_chain"
FORCE="${1:-}"

if [ -d "$CERT_DIR" ] && [ "$FORCE" != "--force" ]; then
  echo "[ERROR] $CERT_DIR already exists. Use --force to overwrite."
  exit 1
fi

rm -rf "$CERT_DIR"
mkdir -p "$CERT_DIR"

# OpenSSL extension config
EXT_CONF="$CERT_DIR/ext.cnf"
cat > "$EXT_CONF" << 'CNF'
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[v3_intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
CNF

echo "=== Generating X.509 cert chain for policy signing key (D-205) ==="
echo ""

# --- 1. Root CA ---
echo "[1/3] Generating root CA..."
openssl ecparam -name prime256v1 -genkey -noout \
  -out "$CERT_DIR/root-ca.key"
openssl req -new -x509 -key "$CERT_DIR/root-ca.key" \
  -out "$CERT_DIR/root-ca.crt" \
  -days 3650 \
  -subj "/CN=PBL Root CA/O=Remote Lockdown System" \
  -SHA256 \
  -config "$EXT_CONF" -extensions v3_ca
openssl x509 -in "$CERT_DIR/root-ca.crt" -outform DER \
  -out "$CERT_DIR/root-ca.der"
echo "  Root CA cert: $CERT_DIR/root-ca.crt (3650 days)"

# --- 2. Intermediate CA ---
echo "[2/3] Generating intermediate CA..."
openssl ecparam -name prime256v1 -genkey -noout \
  -out "$CERT_DIR/intermediate.key"
openssl req -new -key "$CERT_DIR/intermediate.key" \
  -out "$CERT_DIR/intermediate.csr" \
  -subj "/CN=PBL Intermediate CA/O=Remote Lockdown System"
openssl x509 -req -in "$CERT_DIR/intermediate.csr" \
  -CA "$CERT_DIR/root-ca.crt" \
  -CAkey "$CERT_DIR/root-ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/intermediate.crt" \
  -days 365 \
  -SHA256 \
  -extfile "$EXT_CONF" -extensions v3_intermediate
openssl x509 -in "$CERT_DIR/intermediate.crt" -outform DER \
  -out "$CERT_DIR/intermediate.der"
echo "  Intermediate CA cert: $CERT_DIR/intermediate.crt (365 days)"

# --- 3. Leaf cert (policy signing key) ---
echo "[3/3] Generating leaf cert..."
POLICY_KEY="$REPO_ROOT/.pbl_policy_signing_key"
if [ -f "$POLICY_KEY" ]; then
  echo "  Using existing policy signing key from $POLICY_KEY"
  # Convert base64 PKCS8 to PEM
  base64 -d "$POLICY_KEY" > "$CERT_DIR/leaf.key.der"
  openssl pkey -inform DER -outform PEM \
    -in "$CERT_DIR/leaf.key.der" \
    -out "$CERT_DIR/leaf.key"
  rm "$CERT_DIR/leaf.key.der"
else
  echo "  Generating new leaf key..."
  openssl ecparam -name prime256v1 -genkey -noout \
    -out "$CERT_DIR/leaf.key"
fi

openssl req -new -key "$CERT_DIR/leaf.key" \
  -out "$CERT_DIR/leaf.csr" \
  -subj "/CN=PBL Policy Signing Key/O=Remote Lockdown System"
openssl x509 -req -in "$CERT_DIR/leaf.csr" \
  -CA "$CERT_DIR/intermediate.crt" \
  -CAkey "$CERT_DIR/intermediate.key" \
  -CAcreateserial \
  -out "$CERT_DIR/leaf.crt" \
  -days 90 \
  -SHA256 \
  -extfile "$EXT_CONF" -extensions v3_leaf
openssl x509 -in "$CERT_DIR/leaf.crt" -outform DER \
  -out "$CERT_DIR/leaf.der"
echo "  Leaf cert: $CERT_DIR/leaf.crt (90 days)"

# --- 4. Concatenate DER chain [leaf, intermediate, root CA] ---
echo ""
echo "[OK] Concatenating DER chain..."
cat "$CERT_DIR/leaf.der" "$CERT_DIR/intermediate.der" "$CERT_DIR/root-ca.der" \
  > "$CERT_DIR/chain.der"
echo "  Chain: $CERT_DIR/chain.der ($(wc -c < "$CERT_DIR/chain.der") bytes)"

# --- 5. Verify the chain ---
echo ""
echo "=== Verifying chain ==="
openssl verify -CAfile "$CERT_DIR/root-ca.crt" \
  -untrusted "$CERT_DIR/intermediate.crt" \
  "$CERT_DIR/leaf.crt"

# --- 6. Print SPKI from leaf cert ---
echo ""
echo "=== Leaf cert SPKI ==="
openssl x509 -in "$CERT_DIR/leaf.crt" -pubkey -noout | \
  openssl pkey -pubin -outform DER 2>/dev/null | \
  openssl dgst -sha256
echo ""

# --- 7. Print next steps ---
echo "=== Next steps ==="
echo "  1. Pin root CA cert in firmware:"
echo "     cp $CERT_DIR/root-ca.der firmware/PblPkg/PblApp/RootCaCert.der"
echo "  2. Store cert chain in server KV:"
echo "     The chain.der file gets embedded in policy blob C4 key 77"
echo "  3. Rebuild firmware (PolicyRootOfTrust.c verifies chain)"
echo ""
echo "[OK] Cert chain generated in $CERT_DIR"
