#!/usr/bin/env bash
#
# generate-recovery-keys.sh — Generate the offline recovery RSA key pair.
#
# The Remote Lockdown System uses an RSA key pair for offline agent recovery:
#   - Private key (recovery_master.key) is kept offline by IT (safe/HSM).
#     It is NEVER placed on a device.
#   - Public key (recovery_master.pub) is distributed to every agent so it
#     can wrap its Fernet data key. If the server is destroyed, the private
#     key can decrypt the wrapped key and recover the device.
#
# See agent/config.ini.example -> recovery_public_key for the agent path.
#
# Usage:
#   ./scripts/generate-recovery-keys.sh [options]
#
# Options:
#   --output <dir>   Output directory (default: ./keys/)
#   --force          Overwrite existing keys (default: refuse to overwrite)
#   -h, --help       Show this help message
#
# Notes:
#   - Generates a 4096-bit RSA key pair with openssl.
#   - The private key is chmod 600.
#   - If you lose the private key, devices encrypted with the old public key
#     become unrecoverable. Back it up securely before deployment.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------
OUTPUT_DIR="./keys"
FORCE=0
KEY_BITS=4096
PRIVATE_KEY="recovery_master.key"
PUBLIC_KEY="recovery_master.pub"

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_DIR="${2:?--output requires a directory argument}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 64
      ;;
  esac
done

# --- Preflight checks -------------------------------------------------------
command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required but not found in PATH." >&2
  exit 127
}

# --- Check for existing keys ------------------------------------------------
existing=()
[[ -f "$OUTPUT_DIR/$PRIVATE_KEY" ]] && existing+=("$OUTPUT_DIR/$PRIVATE_KEY")
[[ -f "$OUTPUT_DIR/$PUBLIC_KEY" ]] && existing+=("$OUTPUT_DIR/$PUBLIC_KEY")
if [[ ${#existing[@]} -gt 0 && $FORCE -eq 0 ]]; then
  echo "ERROR: Refusing to overwrite existing key file(s):" >&2
  printf '  %s\n' "${existing[@]}" >&2
  echo "Use --force to overwrite." >&2
  echo "WARNING: Overwriting the private key means devices encrypted with" >&2
  echo "         the old public key become unrecoverable." >&2
  exit 1
fi

# --- Create output directory ------------------------------------------------
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR" 2>/dev/null || true

# --- Generate key pair ------------------------------------------------------
echo "Generating ${KEY_BITS}-bit RSA key pair..." >&2

# Private key (PEM, unencrypted — protect via filesystem permissions and/or
# an external envelope. Encrypting with -aes256 would require a passphrase
# prompt which complicates automation; document that admins may add one.)
openssl genrsa -out "$OUTPUT_DIR/$PRIVATE_KEY" "$KEY_BITS" >&2
chmod 600 "$OUTPUT_DIR/$PRIVATE_KEY"

# Public key (PEM)
openssl rsa -in "$OUTPUT_DIR/$PRIVATE_KEY" -pubout -out "$OUTPUT_DIR/$PUBLIC_KEY" 2>/dev/null

# --- Verify -----------------------------------------------------------------
if ! openssl rsa -in "$OUTPUT_DIR/$PRIVATE_KEY" -check -noout >/dev/null 2>&1; then
  echo "ERROR: Private key failed integrity check." >&2
  exit 1
fi
if ! openssl rsa -pubin -in "$OUTPUT_DIR/$PUBLIC_KEY" -noout >/dev/null 2>&1; then
  echo "ERROR: Public key failed to parse." >&2
  exit 1
fi

# --- Summary & deployment instructions -------------------------------------
echo >&2
echo "Recovery key pair generated in $OUTPUT_DIR:" >&2
echo "  - $OUTPUT_DIR/$PRIVATE_KEY  (private, chmod 600)" >&2
echo "  - $OUTPUT_DIR/$PUBLIC_KEY   (public)" >&2
echo >&2
echo "Deployment instructions:" >&2
echo "  1. PRIVATE KEY ($PRIVATE_KEY):" >&2
echo "     - Store OFFLINE in a safe, HSM, or sealed backup." >&2
echo "     - NEVER place on any device or the server." >&2
echo "     - Required only for offline recovery (agent/offline_recovery.py)." >&2
echo "  2. PUBLIC KEY ($PUBLIC_KEY):" >&2
echo "     - Copy to every agent as recovery_master.pub." >&2
echo "     - Set agent config: recovery_public_key = <path>/recovery_master.pub" >&2
echo "       (see agent/config.ini.example)." >&2
echo >&2
echo "WARNING: If the private key is lost, devices encrypted with the" >&2
echo "         corresponding public key cannot be recovered." >&2
echo "WARNING: Do not commit $OUTPUT_DIR/ to git." >&2

exit 0
