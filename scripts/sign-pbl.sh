#!/usr/bin/env bash
#
# sign-pbl.sh — Sign the PBL Secure Boot artifacts with the owner PBL cert.
#
# One-stop signing for the D-130 owner-cert workflow. Given the key+cert
# produced by scripts/gen-secureboot-keys.sh (or your fleet signing PFX
# extracted to PEM), this signs BOTH artifacts that must load under
# Secure Boot:
#
#   1. firmware/PblPkg/PblApp.efi        -> PblApp.signed.efi
#   2. the PblPersistDxe FMP capsule      -> re-pack with --sign (if built)
#
# Then verifies each signature with sbverify and prints the authenticode
# SHA-256 that lands in db (informational).
#
# Signing is done with sbsigntool (local) or the pbl-qemu Docker image
# (fallback — same pattern as firmware/PblPkg/sign-efi.sh).
#
# Usage:
#   ./sign-pbl.sh --key <PBL.key> --cert <PBL.crt> [--no-capsule] [--out DIR]
#
#   --key/--cert   PEM files from gen-secureboot-keys.sh (keys/PBL.key,PBL.crt)
#   --no-capsule   sign only PblApp.efi (skip the persist capsule)
#   --out DIR      output dir for signed artifacts (default: same as input)
#
# Exit codes: 0 success, 1 sign/verify fail, 2 missing deps, 64 usage.
# See: docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md, scripts/gen-secureboot-keys.sh.

set -euo pipefail

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
warn() { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }
usage() { sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }

KEY=""; CERT=""; DO_CAPSULE=1; OUT_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key)        KEY="$2"; shift 2 ;;
    --cert)       CERT="$2"; shift 2 ;;
    --no-capsule) DO_CAPSULE=0; shift ;;
    --out)        OUT_DIR="$2"; shift 2 ;;
    -h|--help)    usage ;;
    *)            err "Unknown arg: $1"; usage ;;
  esac
done

[ -n "$KEY" ] && [ -n "$CERT" ] || { err "--key and --cert are required"; usage; }
[ -f "$KEY" ]  || { err "key not found: $KEY"; exit 1; }
[ -f "$CERT" ] || { err "cert not found: $CERT"; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PBL_APP="${REPO}/firmware/PblPkg/PblApp.efi"
[ -f "$PBL_APP" ] || { err "PblApp.efi not found — run build-pbl.sh first"; exit 1; }

OUT_DIR="${OUT_DIR:-$(dirname "$PBL_APP")}"
mkdir -p "$OUT_DIR"
SIGNED_APP="${OUT_DIR}/PblApp.signed.efi"

# Combined PEM (cert+key) for the capsule's --signer-private-cert arg.
COMBINED_PEM="$(mktemp --suffix=.pem)"
cat "$CERT" "$KEY" > "$COMBINED_PEM"
trap 'rm -f "$COMBINED_PEM"' EXIT

# --- pick a sbsign implementation -------------------------------------------
run_sbsign() {   # $1=in  $2=out
  if command -v sbsign >/dev/null 2>&1; then
    sbsign --key "$KEY" --cert "$CERT" --output "$2" "$1"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$(dirname "$1"):/in" -v "$(dirname "$2"):/out" \
      -v "$KEY:/key.pem" -v "$CERT:/cert.pem" pbl-qemu:latest \
      bash -c "command -v sbsign >/dev/null || { apt-get update -qq && apt-get install -y -qq sbsigntool; } >/dev/null 2>&1; sbsign --key /key.pem --cert /cert.pem --output /out/$(basename "$2") /in/$(basename "$1")"
  else
    err "need sbsigntool or docker (pbl-qemu)"; exit 2
  fi
}
run_sbverify() {  # $1=file
  if command -v sbverify >/dev/null 2>&1; then
    sbverify --cert "$CERT" "$1"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$(dirname "$1"):/in" -v "$CERT:/cert.pem" pbl-qemu:latest \
      bash -c "command -v sbverify >/dev/null || { apt-get update -qq && apt-get install -y -qq sbsigntool; } >/dev/null 2>&1; sbverify --cert /cert.pem /in/$(basename "$1")"
  fi
}

# --- 1. sign PblApp.efi ------------------------------------------------------
info "Signing PblApp.efi -> $SIGNED_APP"
run_sbsign "$PBL_APP" "$SIGNED_APP"
run_sbverify "$SIGNED_APP" && ok "PblApp.signed.efi verified"

# authenticode hash (what lands in db / SBAT-relevant) — informational.
APP_HASH=$(python3 - "$SIGNED_APP" <<'PY' 2>/dev/null || echo "unavailable"
import sys
try:
    import pefile
    from virt.peutils.pesign import pe_authenticode_hash
    print(pe_authenticode_hash(pefile.PE(sys.argv[1]), "sha256").hex())
except Exception:
    sys.exit(1)
PY
)
info "PblApp.signed.efi authenticode SHA-256: ${APP_HASH}"

# --- 2. sign the persist capsule (if built + requested) -----------------------
CAP_SCRIPT="${REPO}/firmware/PblPkg/pack-persist-capsule.sh"
PERSIST_EFI="/home/cllin/.local/src/edk2/Build/PblPkg/RELEASE_GCC/X64/PblPkg/PblPersistDxe/PblPersistDxe/OUTPUT/PblPersistDxe.efi"
if [ "$DO_CAPSULE" -eq 1 ]; then
  if [ -f "$PERSIST_EFI" ] && [ -f "$CAP_SCRIPT" ]; then
    info "Signing persist capsule via pack-persist-capsule.sh --sign"
    bash "$CAP_SCRIPT" --sign "$COMBINED_PEM" \
      && ok "PblPersistDxe.cap signed"
  else
    warn "PblPersistDxe.efi not built — skipping capsule sign"
    warn "  (build with build-pbl.sh, then re-run to sign the capsule)"
  fi
fi

echo
ok "Done."
ok "  signed app: $SIGNED_APP"
ok "  db enroll:  the PBL cert in this bundle's db.auth already trusts it"
warn "Keep $(basename "$KEY") OFFLINE — it is the platform signing root."
