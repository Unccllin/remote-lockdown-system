#!/usr/bin/env bash
#
# sign-efi.sh — Sign PblApp.efi for Secure Boot deployment (D-130)
#
# PBL must be signed for Secure Boot to load it. This script handles
# both production signing (with a real certificate) and test signing
# (with a self-signed cert for development).
#
# Usage:
#   ./sign-efi.sh --test                    # Self-signed test cert (dev only)
#   ./sign-efi.sh --pfx <cert.pfx>           # Sign with PFX certificate
#   ./sign-efi.sh --pfx <cert.pfx> --password <pass>
#   ./sign-efi.sh --azure <config>           # Azure Trusted Signing
#   ./sign-efi.sh --help                     # Show this help
#
# Requirements:
#   - Linux:  sbsign (apt install sbsigntool)
#   - Windows: signtool.exe (Windows SDK) or sbctl (https://github.com/Foxboron/sbctl)
#
# Certificate requirements for production:
#   - UEFI Secure Boot requires the signing cert to be in the db (signature database)
#   - For self-deployment: generate a self-signed cert, enroll the public key in db
#   - For OEM deployment: use a cert signed by a CA in the OEM's db
#   - For Microsoft deployment: submit to Microsoft's UEFI signing portal
#     (https://partner.microsoft.com/dashboard/uefi)
#
# Exit codes:
#   0 — signing successful
#   1 — signing failed
#   2 — missing dependencies
#  64 — usage error

set -uo pipefail

# --- Helpers ----------------------------------------------------------------
usage() {
  sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
warn() { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }

# --- Arguments ---------------------------------------------------------------
MODE=""
PFX_FILE=""
PFX_PASSWORD=""
AZURE_CONFIG=""
EFI_FILE=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test)          MODE="test"; shift ;;
    --pfx)           MODE="pfx"; PFX_FILE="$2"; shift 2 ;;
    --password)      PFX_PASSWORD="$2"; shift 2 ;;
    --azure)         MODE="azure"; AZURE_CONFIG="$2"; shift 2 ;;
    --efi)           EFI_FILE="$2"; shift 2 ;;
    --output)        OUTPUT_FILE="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *)               err "Unknown argument: $1"; usage ;;
  esac
done

# Default EFI file
if [[ -z "$EFI_FILE" ]]; then
  EFI_FILE="$(dirname "$0")/PblApp.efi"
fi
if [[ ! -f "$EFI_FILE" ]]; then
  err "EFI file not found: $EFI_FILE"
  exit 1
fi

# Default output file
if [[ -z "$OUTPUT_FILE" ]]; then
  OUTPUT_FILE="${EFI_FILE%.efi}.signed.efi"
fi

# --- Mode: Test signing (self-signed cert) -----------------------------------
sign_test() {
  info "Test signing mode — generating self-signed certificate"
  info "WARNING: This is for development only. Do NOT use in production."
  info "         Secure Boot will reject this unless you enroll the cert in db."

  # Check for sbsign (Linux) or sbctl
  if command -v sbsign &>/dev/null; then
    info "Using sbsign (sbsigntool)"

    # Generate self-signed cert
    local KEY_FILE="/tmp/pbl-test-signing.key"
    local CERT_FILE="/tmp/pbl-test-signing.crt"

    info "Generating self-signed certificate..."
    openssl req -new -x509 -newkey rsa:2048 -keyout "$KEY_FILE" \
      -out "$CERT_FILE" -days 365 -nodes \
      -subj "/CN=PBL Test Signing/O=Remote Lockdown System" 2>/dev/null

    if [[ ! -f "$KEY_FILE" || ! -f "$CERT_FILE" ]]; then
      err "Failed to generate self-signed certificate"
      exit 1
    fi

    info "Signing $EFI_FILE..."
    sbsign --key "$KEY_FILE" --cert "$CERT_FILE" \
      --output "$OUTPUT_FILE" "$EFI_FILE"

    if [[ $? -eq 0 && -f "$OUTPUT_FILE" ]]; then
      ok "Signed EFI: $OUTPUT_FILE"
      ok "Certificate: $CERT_FILE"
      # Export DER for UEFI db enrollment
      openssl x509 -in "$CERT_FILE" -outform DER -out "$(dirname "$EFI_FILE")/pbl-test-signing.der"
      cp "$CERT_FILE" "$(dirname "$EFI_FILE")/pbl-test-signing.crt"
      ok ""
      ok "To use with Secure Boot, enroll the public key in db:"
      ok "  # Convert cert to DER format for UEFI db enrollment"
      ok "  openssl x509 -in $CERT_FILE -outform DER -out /tmp/pbl-test-signing.der"
      ok "  # Use your UEFI setup to enroll this in the db signature database"
      ok "  # Or use sbctl: sudo sbctl enroll-keys --microsoft --tpm-eventlog"
      ok ""
      ok "To verify the signature:"
      ok "  sbverify --cert $CERT_FILE $OUTPUT_FILE"
    else
      err "Signing failed"
      exit 1
    fi

  elif command -v docker &>/dev/null; then
    info "sbsign not found locally — using Docker (pbl-qemu image)"

    local WORK_DIR
    WORK_DIR="$(dirname "$EFI_FILE")"
    local EFI_NAME
    EFI_NAME="$(basename "$EFI_FILE")"
    local OUT_NAME
    OUT_NAME="$(basename "$OUTPUT_FILE")"

    docker run --rm \
      -v "$WORK_DIR:/work" \
      pbl-qemu:latest bash -c "
set -e
apt-get update -qq 2>/dev/null && apt-get install -y -qq sbsigntool 2>&1 | tail -1

echo '=== Generating self-signed certificate ==='
openssl req -new -x509 -newkey rsa:2048 -keyout /tmp/pbl-signing.key \
  -out /tmp/pbl-signing.crt -days 365 -nodes \
  -subj '/CN=PBL Test Signing/O=Remote Lockdown System' 2>/dev/null

echo '=== Signing $EFI_NAME ==='
sbsign --key /tmp/pbl-signing.key --cert /tmp/pbl-signing.crt \
  --output /work/$OUT_NAME /work/$EFI_NAME

echo '=== Verifying ==='
sbverify --cert /tmp/pbl-signing.crt /work/$OUT_NAME

echo '=== Exporting cert ==='
cp /tmp/pbl-signing.crt /work/pbl-test-signing.crt
openssl x509 -in /tmp/pbl-signing.crt -outform DER -out /work/pbl-test-signing.der
chmod 644 /work/$OUT_NAME /work/pbl-test-signing.crt /work/pbl-test-signing.der

echo '=== Done ==='
openssl x509 -in /work/pbl-test-signing.crt -noout -subject -fingerprint -sha256
" 2>&1

    if [[ $? -eq 0 && -f "$OUTPUT_FILE" ]]; then
      ok "Signed EFI: $OUTPUT_FILE"
      ok "Certificate: $WORK_DIR/pbl-test-signing.crt"
      ok "DER cert: $WORK_DIR/pbl-test-signing.der"
      ok ""
      ok "To use with Secure Boot, enroll pbl-test-signing.der in db"
      ok "To verify: sbverify --cert $WORK_DIR/pbl-test-signing.crt $OUTPUT_FILE"
    else
      err "Docker signing failed"
      exit 1
    fi

  elif command -v sbctl &>/dev/null; then
    info "Using sbctl"
    sbctl sign -s "$EFI_FILE" -o "$OUTPUT_FILE"
    if [[ $? -eq 0 && -f "$OUTPUT_FILE" ]]; then
      ok "Signed EFI: $OUTPUT_FILE"
    else
      err "Signing failed"
      exit 1
    fi

  else
    err "Neither sbsign, Docker, nor sbctl found."
    err "Install one of:"
    err "  Debian/Ubuntu: sudo apt install sbsigntool"
    err "  Arch:          sudo pacman -S sbctl"
    err "  macOS:          brew install sbctl"
    err "  Or use Docker with pbl-qemu image"
    exit 2
  fi
}

# --- Mode: PFX signing -------------------------------------------------------
sign_pfx() {
  if [[ -z "$PFX_FILE" ]]; then
    err "--pfx requires a certificate file path"
    exit 64
  fi
  if [[ ! -f "$PFX_FILE" ]]; then
    err "PFX file not found: $PFX_FILE"
    exit 1
  fi

  info "PFX signing mode"
  info "  PFX file: $PFX_FILE"
  info "  EFI file: $EFI_FILE"
  info "  Output:   $OUTPUT_FILE"

  if command -v sbsign &>/dev/null; then
    info "Using sbsign (sbsigntool)"

    # Extract key and cert from PFX
    local KEY_FILE="/tmp/pbl-signing.key"
    local CERT_FILE="/tmp/pbl-signing.crt"

    if [[ -n "$PFX_PASSWORD" ]]; then
      openssl pkcs12 -in "$PFX_FILE" -nocerts -nodes \
        -passin "pass:$PFX_PASSWORD" -out "$KEY_FILE" 2>/dev/null
      openssl pkcs12 -in "$PFX_FILE" -nokeys \
        -passin "pass:$PFX_PASSWORD" -out "$CERT_FILE" 2>/dev/null
    else
      info "No password provided — will prompt if needed"
      openssl pkcs12 -in "$PFX_FILE" -nocerts -nodes -out "$KEY_FILE" 2>/dev/null
      openssl pkcs12 -in "$PFX_FILE" -nokeys -out "$CERT_FILE" 2>/dev/null
    fi

    if [[ ! -f "$KEY_FILE" || ! -f "$CERT_FILE" ]]; then
      err "Failed to extract key/cert from PFX"
      exit 1
    fi

    info "Signing $EFI_FILE..."
    sbsign --key "$KEY_FILE" --cert "$CERT_FILE" \
      --output "$OUTPUT_FILE" "$EFI_FILE"

    if [[ $? -eq 0 && -f "$OUTPUT_FILE" ]]; then
      ok "Signed EFI: $OUTPUT_FILE"
      ok "To verify: sbverify $OUTPUT_FILE"
    else
      err "Signing failed"
      exit 1
    fi

  else
    err "sbsign not found. Install: sudo apt install sbsigntool"
    exit 2
  fi
}

# --- Mode: Azure Trusted Signing ---------------------------------------------
sign_azure() {
  if [[ -z "$AZURE_CONFIG" ]]; then
    err "--azure requires a config file path"
    exit 64
  fi
  if [[ ! -f "$AZURE_CONFIG" ]]; then
    err "Azure config not found: $AZURE_CONFIG"
    exit 1
  fi

  err "Azure Trusted Signing not yet implemented for EFI signing."
  err "Azure Trusted Signing is designed for Windows PE files (.exe, .dll)."
  err "For UEFI Secure Boot, use a PFX certificate or submit to Microsoft's"
  err "UEFI signing portal: https://partner.microsoft.com/dashboard/uefi"
  exit 1
}

# --- Main --------------------------------------------------------------------
case "$MODE" in
  test)  sign_test ;;
  pfx)   sign_pfx ;;
  azure) sign_azure ;;
  "")    err "No mode specified. Use --test, --pfx, or --azure"; usage ;;
  *)     err "Unknown mode: $MODE"; usage ;;
esac
