#!/usr/bin/env bash
#
# gen-secureboot-keys.sh — Generate owner Secure Boot keys + unsigned
# enrollment bundle (D-130 ruling: owner-cert + provisioning-time db enroll).
#
# Produces an "enrollment bundle" for scripts/provision-secureboot.ps1:
#   <out>/auth/PK.auth   — owner Platform Key (enrolling flips SetupMode→0)
#   <out>/auth/KEK.auth  — owner Key Exchange Key + Microsoft KEK
#   <out>/auth/db.auth   — PBL signing cert + Microsoft UEFI CAs
#   <out>/auth/dbx.auth  — current revocation list (dummy if none staged)
#   <out>/keys/PK.crt, KEK.crt, PBL.crt (+ .key, .der, .esl)
#
# The .auth files are intentionally UNSIGNED — they are valid only on a
# machine still in Setup Mode (no PK enrolled yet), which is exactly the
# provisioning-touch window. Once PK is set, subsequent variable updates
# require time-based authentication (signed .auth) — that is a separate,
# post-enrollment operation not needed for first provisioning.
#
# Signing strategy (ruling 2026-10-14): owner keys, enrolled at provisioning.
# Microsoft UEFI portal is NOT used — every unit gets a provisioning touch,
# so db is always enrollable. External SPI clip is the per-unit fallback.
#
# Usage:
#   ./gen-secureboot-keys.sh [--out DIR] [--cn "Org Platform Key"] \
#                            [--signing-cn "Org PBL Signing"] \
#                            [--microsoft-db uefi23] [--microsoft-kek 2023]
#
# Defaults: --out ./sb-keys, CN "Remote Lockdown Platform Key",
#           microsoft-db uefi23, microsoft-kek 2023 (covers Win11-era HW).
#
# Requires: virt-firmware (virt-fw-vars), openssl, python3.
# See: docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md §2.1, D-130.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------
OUT_DIR="./sb-keys"
CN="Remote Lockdown Platform Key"
SIGNING_CN="Remote Lockdown PBL Signing"
MS_DB="uefi23"
MS_KEK="2023"

usage() { sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }
info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)           OUT_DIR="$2"; shift 2 ;;
    --cn)            CN="$2"; shift 2 ;;
    --signing-cn)    SIGNING_CN="$2"; shift 2 ;;
    --microsoft-db)  MS_DB="$2"; shift 2 ;;
    --microsoft-kek) MS_KEK="$2"; shift 2 ;;
    -h|--help)       usage ;;
    *)               err "Unknown argument: $1"; usage ;;
  esac
done

# --- Deps --------------------------------------------------------------------
command -v virt-fw-vars >/dev/null || { err "virt-fw-vars (virt-firmware) not found"; exit 2; }
command -v openssl       >/dev/null || { err "openssl not found"; exit 2; }
command -v python3       >/dev/null || { err "python3 not found"; exit 2; }

mkdir -p "$OUT_DIR/auth" "$OUT_DIR/keys"

# --- 1. Generate the PBL signing cert (the one that signs the binaries) --------
# virt-fw-vars' --enroll-generate makes a single self-signed platform cert used
# for PK/KEK/db. The PBL *code-signing* cert is separate: it goes into db but is
# NOT the PK. Generate it here so the same cert can sign PblApp.efi + capsule.
KEYS="$OUT_DIR/keys"
info "Generating PBL signing cert ($SIGNING_CN)"
openssl req -new -x509 -newkey rsa:2048 \
  -keyout "$KEYS/PBL.key" -out "$KEYS/PBL.crt" -days 3650 -nodes \
  -subj "/CN=$SIGNING_CN/O=Remote Lockdown" 2>/dev/null
openssl x509 -in "$KEYS/PBL.crt" -outform DER -out "$KEYS/PBL.der"
ok "PBL signing cert: $KEYS/PBL.crt  (private key: $KEYS/PBL.key — keep offline)"

# --- 2. Build the variable store + emit unsigned .auth bundle ------------------
# We drive virt-firmware's EfiVarList directly so we can: (a) enroll the owner
# PK/KEK, (b) put our PBL cert + Microsoft db entries into db, (c) write the
# unsigned .auth files a Setup-Mode machine will accept.
info "Building Secure Boot variable store (owner PK/KEK + PBL cert + MS CAs)"
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"
CN="$CN" SIGNING_CN="$SIGNING_CN" OUT_DIR_ABS="$OUT_DIR_ABS" MS_DB="$MS_DB" MS_KEK="$MS_KEK" \
python3 - <<'PYEOF'
import os
from virt.firmware.efi import efivar, siglist, guids, certs
from virt.firmware.varstore import authfiles

out   = os.environ["OUT_DIR_ABS"]
cn    = os.environ["CN"]
scn   = os.environ["SIGNING_CN"]
msdb  = os.environ["MS_DB"]
mskek = os.environ["MS_KEK"]

varlist = efivar.EfiVarList()

# Owner PK + KEK (self-signed, generated) — the platform root. Passing
# ms_kek here also adds the Microsoft KEK cert(s) so the platform can accept
# MS-signed db/dbx updates post-enrollment. The owner GUID is the constant
# OvmfEnrollDefaultKeys (virt-firmware's convention).
owner = guids.OvmfEnrollDefaultKeys
varlist.enroll_platform_generate(cn, mskek)

# db = owner PBL signing cert + Microsoft UEFI/Windows CAs.
# add_cert wants the cert file path; it wraps it in an EfiSigList.
varlist.add_cert("db", owner, os.path.join(out, "keys", "PBL.crt"))
varlist.add_microsoft_keys(msdb)

# dbx — seed a dummy entry so the variable exists (updated post-enrollment).
varlist.add_dummy_dbx(guids.OvmfEnrollDefaultKeys)

# Enable the SecureBoot flag in the store image.
varlist.enable_secureboot()

# Emit unsigned .auth bundle + the ESL forms + a json manifest.
authfiles.AuthFilesVarStore.write_varstore(os.path.join(out, "auth"), varlist)

# The generated PK cert lives inside PK.auth (the ESL data) — it is not a
# signing key, so we do not need a standalone copy for provisioning. The PK
# private key is generated transiently by virt-firmware and not exported;
# for a fleet you would supply your own PK via enroll_platform_with_cert
# (a follow-up if needed). What the operator MUST keep offline is PBL.key.

import json, uuid
manifest = {
  "owner_guid": owner,
  "pk_cn": cn,
  "pbl_signing_cn": scn,
  "db_contents": ["PBL-signing-cert", f"microsoft-db:{msdb}"],
  "kek_contents": ["owner-kek", f"microsoft-kek:{mskek}"],
  "auth_unsigned": True,
  "note": "Unsigned .auth — valid only in Setup Mode (no PK enrolled).",
}
with open(os.path.join(out, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("  owner GUID:", owner)
PYEOF

ok "auth bundle: $OUT_DIR/auth/{PK,KEK,db,dbx}.auth"
ok "manifest:    $OUT_DIR/manifest.json"
echo
ok "Next steps:"
ok "  1. Copy $OUT_DIR/auth/*.auth to the target machine"
ok "  2. On target (Admin PS):  scripts/provision-secureboot.ps1 -AuthDir <dir>"
ok "  3. Sign binaries with $KEYS/PBL.key + PBL.crt:"
ok "       firmware/PblPkg/sign-efi.sh --pfx <exported-pfx>  (or sbsign)"
ok "  4. Keep $KEYS/*.key OFFLINE — they are the platform root."
