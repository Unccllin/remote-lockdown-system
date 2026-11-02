#!/bin/bash
# test-d133-enroll-harness.sh — D-133 positive test + its two controlled negatives.
#
# What this proves
# ----------------
# D-133 changed Decision Step 6 from "any X.509 cert in db" / "any dbx entry" to
# a fingerprint comparison against two known identities. The negative test
# (session 161) showed a look-alike certificate no longer satisfies the db half.
# This harness produces the *positive* half: the real Windows UEFI CA 2023 in db
# and the real Microsoft Corporation UEFI CA 2011 hash in dbx must PASS the gate.
#
# It boots the SAME signed PblApp on the SAME Secure Boot platform three times,
# varying only what EnrollKeys.efi writes into db/dbx:
#
#   variant    db                                   dbx                 expected basis
#   ---------  -----------------------------------  ------------------  --------------------------
#   positive   PBL signer + Windows UEFI CA 2023     MS 2011 CA hash     (passes Step 6)
#   db-neg     PBL signer only                       MS 2011 CA hash     db lacks the Windows UEFI CA 2023
#   dbx-neg    PBL signer + Windows UEFI CA 2023     sha256("") dummy    dbx lacks the MS 2011 revocation
#
# Why the enrolment helper exists at all
# --------------------------------------
# `virt-fw-vars --set-dbx` needs an EFI_VARIABLE_AUTHENTICATION_2 blob and cannot
# take a bare ESL (session 163). Writing from inside the guest in Setup Mode is
# the route that works, and it is also the fleet provisioning path (owner-cert +
# provisioning-time db enrolment, ruling 2026-10-14). EnrollKeys.efi is that
# helper; this harness is its end-to-end test.
#
# Why the PBL OVMF build and not the distro one
# ---------------------------------------------
# Ubuntu's OVMF_CODE_4M.secboot.fd is built with PcdRequireSelfSignedPk=TRUE, so
# a Setup-Mode PK write whose auth header carries no PKCS#7 signature fails with
# EFI_SECURITY_VIOLATION (observed: db/dbx/KEK accepted, PK rejected). The PBL
# build (build-pbl.sh, OvmfPkgX64.dsc) has the PCD FALSE and accepts it, which is
# the same construction OvmfPkg/EnrollDefaultKeys uses.
#
# Requirements: docker (image pbl-qemu:sb by default), openssl, python3.
# The custom OVMF FV dir must exist — run firmware/PblPkg/build-pbl.sh first.
#
# Usage:
#   ./test-d133-enroll-harness.sh [--out DIR] [--timeout SECS] [--no-negative]
#
# Artifacts (serial logs + results) land in --out (default ./artifacts-d133).
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

OUT="./artifacts-d133"
TIMEOUT=90
RUN_NEGATIVE=1
IMAGE="${IMAGE:-pbl-qemu:sb}"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
FW_DIR="$(cd "$(dirname "$0")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)         OUT="$2"; shift 2 ;;
    --timeout)     TIMEOUT="$2"; shift 2 ;;
    --no-negative) RUN_NEGATIVE=0; shift ;;
    -h|--help)     sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

FV="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV"
CODE="${FV}/OVMF_CODE.fd"
VARS_EMPTY="${FV}/OVMF_VARS.fd"
PBL_APP="${FW_DIR}/PblApp.efi"
ENROLL_APP="${FW_DIR}/EnrollKeys.efi"

for f in "$CODE" "$VARS_EMPTY"; do
  [ -f "$f" ] || { err "missing $f — run build-pbl.sh (it builds OVMF on first run)"; exit 1; }
done
for f in "$PBL_APP" "$ENROLL_APP"; do
  [ -f "$f" ] || { err "missing $f — run build-pbl.sh"; exit 1; }
done
command -v docker  >/dev/null || { err "docker not found"; exit 1; }
command -v openssl >/dev/null || { err "openssl not found"; exit 1; }

W="$(mktemp -d /tmp/pbl-d133-XXXXXX)"
mkdir -p "$OUT" "$W/certs"
OUT="$(cd "$OUT" && pwd)"
info "work dir: $W"
info "artifacts: $OUT"

# === Keys =====================================================================
# One test signer (goes into db, signs PblApp) and one platform key (PK).
# Self-signed: the owner-cert ruling allows a dev cert for the QEMU platform; the
# production PFX path is sign-pbl.sh --key/--cert.
info "generating test signer + platform key"
openssl req -new -x509 -newkey rsa:2048 -keyout "$W/certs/PBL.key" -out "$W/certs/PBL.crt" \
  -days 3650 -nodes -subj "/CN=PBL Test Signing/O=Remote Lockdown" 2>/dev/null
openssl req -new -x509 -newkey rsa:2048 -keyout "$W/certs/PK.key" -out "$W/certs/PK.crt" \
  -days 3650 -nodes -subj "/CN=PBL Test Platform Key/O=Remote Lockdown" 2>/dev/null
for c in PBL PK; do openssl x509 -in "$W/certs/$c.crt" -outform DER -out "$W/certs/$c.der"; done

# Microsoft's real certificates come out of the distro's Microsoft-keyed varstore,
# so the fingerprints are the platform's, not something typed from memory.
info "extracting Microsoft certificates from OVMF_VARS_4M.ms.fd"
docker create --name pbl-d133-extract "$IMAGE" true >/dev/null
trap 'docker rm -f pbl-d133-extract >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
docker cp pbl-d133-extract:/usr/share/OVMF/OVMF_VARS_4M.ms.fd "$W/VARS_ms.fd"
docker rm -f pbl-d133-extract >/dev/null
if command -v virt-fw-vars >/dev/null; then
  ( cd "$W" && virt-fw-vars -i VARS_ms.fd --extract-certs >/dev/null 2>&1 ) || true
  cp "$W"/db-*WindowsUEFICA2023.pem "$W/certs/WinCA2023.pem"
  cp "$W"/KEK-*KEK2KCA2023.pem       "$W/certs/MsKEK2023.pem"
  for c in WinCA2023 MsKEK2023; do
    openssl x509 -in "$W/certs/$c.pem" -outform DER -out "$W/certs/$c.der"
  done
  WINC="$(sha256sum "$W/certs/WinCA2023.der" | cut -d' ' -f1)"
  [ "$WINC" = "076f1fea90ac29155ebf77c17682f75f1fdd1be196da302dc8461e350a9ae330" ] || {
    err "Windows UEFI CA 2023 fingerprint mismatch: $WINC"; exit 1; }
  ok "Windows UEFI CA 2023 = 076f1fea…9ae330 (matches PlatformState.c)"
else
  err "virt-fw-vars not found — cannot extract Microsoft's certificates"; exit 1
fi

# === ESLs =====================================================================
# Signature lists are built here rather than with virt-fw-vars because the
# firmware compares SHA-256 of each *entry*, and one list can only hold entries of
# one size — so one list per certificate, plus a SHA256 list for the dbx hash.
info "building ESLs"
W="$W" python3 - <<'PYEOF'
import os, struct, uuid, hashlib
W = os.environ["W"]; C = os.path.join(W, "certs")
X509   = "a5c059a1-94e4-4aa7-87b5-ab155c2bf072"
SHA256 = "c1c41626-504c-4092-aca9-41f936934328"
OWNER_MS, OWNER_OVMF = "77fa9abd-0359-4d32-bd60-28f4e78f784b", "a0baa8a3-041d-48a8-bc87-c36d121b5e3d"
MS2011 = "48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507"
g = lambda s: uuid.UUID(s).bytes_le

def x509(owner, ders):
    out = b""
    for der in ders:
        sig = g(owner) + der
        out += g(X509) + struct.pack("<III", 28 + len(sig), 0, len(sig)) + sig
    return out

def sha256_list(owner, hashes):
    out = b""
    for h in hashes:
        sig = g(owner) + h
        out += g(SHA256) + struct.pack("<III", 28 + len(sig), 0, len(sig)) + sig
    return out

rd = lambda n: open(os.path.join(C, n), "rb").read()
esl = {
  "db.esl":         x509(OWNER_OVMF, [rd("PBL.der")]) + x509(OWNER_MS, [rd("WinCA2023.der")]),
  "db-noca.esl":    x509(OWNER_OVMF, [rd("PBL.der")]),
  "dbx.esl":        sha256_list(OWNER_MS, [bytes.fromhex(MS2011)]),
  "dbx-dummy.esl":  sha256_list(OWNER_MS, [hashlib.sha256(b"").digest()]),
  "pk.esl":         x509(OWNER_OVMF, [rd("PK.der")]),
  "kek.esl":        x509(OWNER_OVMF, [rd("PK.der")]) + x509(OWNER_MS, [rd("MsKEK2023.der")]),
}
for name, data in esl.items():
    open(os.path.join(W, name), "wb").write(data)
    print(f"  {name}: {len(data)} bytes")
PYEOF

# === Container-side runner ====================================================
# Kept in one heredoc so the harness stays a single file: ESP assembly, swtpm and
# QEMU all need the image's tools, the host needs only openssl/python/docker.
cat > "$W/run.sh" <<'RSCRIPT'
#!/bin/bash
# Runs inside pbl-qemu:sb. Env: PHASE=enroll|boot, LOG=<serial log name>.
set -eo pipefail
W=/work; B=/tmp/b; rm -rf "$B"; mkdir -p "$B"
phase="${PHASE:?PHASE not set}"; log="${LOG:?LOG not set}"
CODE="${CODE:-/work/OVMF_CODE.fd}"
VARS_SRC="${VARS_SRC:-/work/VARS_empty.fd}"

DISK=$B/disk.img; ESP=$B/esp.img
dd if=/dev/zero of="$DISK" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "$DISK" >/dev/null 2>&1
mkfs.fat -F 32 -n ESP -C "$ESP" 50176 >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT
if [ "$phase" = "enroll" ]; then
  mmd -i "$ESP" ::/EFI/PBL
  mcopy -i "$ESP" "$W/EnrollKeys.efi" ::/EFI/BOOT/BOOTX64.EFI
  mcopy -i "$ESP" "$W/${DB_ESL:-db.esl}"   ::/EFI/PBL/db.esl
  mcopy -i "$ESP" "$W/${DBX_ESL:-dbx.esl}" ::/EFI/PBL/dbx.esl
  mcopy -i "$ESP" "$W/pk.esl"  ::/EFI/PBL/pk.esl
  mcopy -i "$ESP" "$W/kek.esl" ::/EFI/PBL/kek.esl
else
  mcopy -i "$ESP" "$W/PblApp.signed.efi" ::/EFI/BOOT/BOOTX64.EFI
fi
dd if="$ESP" of="$DISK" bs=512 seek=2048 conv=notrunc status=none

swtpm socket --tpmstate dir=$B --ctrl type=unixio,path=$B/swtpm.sock \
  --tpm2 --daemon --flags not-need-init --pid file=$B/swtpm.pid
swtpm_ioctl --unix $B/swtpm.sock -i 2>/dev/null || true

cp "$VARS_SRC" "$B/VARS.fd"
set +e
timeout "${TIMEOUT:-90}" qemu-system-x86_64 \
  -drive if=pflash,format=raw,readonly=on,file="$CODE" \
  -drive if=pflash,format=raw,file="$B/VARS.fd" \
  -drive format=raw,file="$DISK" -nographic -m 256M \
  -chardev socket,id=chrtpm,path=$B/swtpm.sock \
  -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
  2>&1 | tee "/work/$log"
set -e
cp "$B/VARS.fd" "$W/VARS_out.fd"
chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$W" 2>/dev/null || true
RSCRIPT
chmod +x "$W/run.sh"

# Inputs the container needs (OVMF fds are copied, not mounted, so the image can
# read them whatever their host ownership).
cp "$CODE" "$W/OVMF_CODE.fd"; cp "$VARS_EMPTY" "$W/VARS_empty.fd"
cp "$PBL_APP" "$W/PblApp.efi"; cp "$ENROLL_APP" "$W/EnrollKeys.efi"

info "signing PblApp.efi with the test signer"
docker run --rm -v "$W":/work "$IMAGE" sh -c '
  sbsign --key /work/certs/PBL.key --cert /work/certs/PBL.crt \
         --output /work/PblApp.signed.efi /work/PblApp.efi &&
  sbverify --cert /work/certs/PBL.crt /work/PblApp.signed.efi' 2>&1 | tail -2

# Docker options must come before the image; the phase/log go through env so an
# argument can never be mistaken for the image name (docker exits 125 when it is).
run_container() {
  docker run --rm -e TIMEOUT="$TIMEOUT" \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" "$@" \
    -v "$W":/work -v "$W/run.sh":/run.sh:ro "$IMAGE" /bin/bash /run.sh
}

# enroll <db-esl> <dbx-esl> <log> — boot EnrollKeys from an empty (SetupMode) store.
enroll() {
  info "enrolling keys (db=$1, dbx=$2)"
  run_container -e PHASE=enroll -e DB_ESL="$1" -e DBX_ESL="$2" -e LOG="$3" >/dev/null 2>&1 || {
    err "enrolment container failed"; tail -20 "$W/$3" 2>/dev/null || true; exit 1; }
  grep -q "enrolment complete" "$W/$3" || { err "enrolment failed — see $3"; grep -E "FAIL|ERROR" "$W/$3" || true; exit 1; }
  grep -E "\[OK\]|after: SecureBoot" "$W/$3" | sed 's/^/    /'
  mv "$W/VARS_out.fd" "$W/VARS_$4.fd"
}

# boot <vars> <log> — boot the signed PblApp on an enrolled store.
boot() {
  info "booting signed PblApp on $1"
  cp "$W/$1" "$W/VARS_in.fd"
  run_container -e PHASE=boot -e VARS_SRC=/work/VARS_in.fd -e LOG="$2" >/dev/null 2>&1 || {
    err "boot container failed"; tail -20 "$W/$2" 2>/dev/null || true; exit 1; }
  if grep -aq "BdsDxe: starting" "$W/$2"; then
    ok "Secure Boot accepted the signed PblApp"
  else
    err "PblApp did not load under Secure Boot — see $2"; exit 1
  fi
  grep -a "Decision BLOCK basis" "$W/$2" | sed 's/^/    /' || echo "    (no BLOCK basis line)"
}

FAILED=0
expect_basis() { # <log> <expected-substring> <label>
  if grep -aq "$2" "$W/$1"; then ok "$3: $2"; else err "$3: expected '$2' in $1"; FAILED=1; fi
}

# === Variant 1: positive =======================================================
enroll db.esl dbx.esl d133-enroll-serial.log good
boot VARS_good.fd d133-positive-db-and-dbx-serial.log
expect_basis d133-positive-db-and-dbx-serial.log "S3 enabled without MOR" "positive (Step 6 passed)"
if grep -aqE "db lacks the Windows UEFI CA 2023|dbx lacks the MS 2011 revocation" \
     "$W/d133-positive-db-and-dbx-serial.log"; then
  err "positive variant still failed a Step 6 gate"; FAILED=1
fi

if [ "$RUN_NEGATIVE" = "1" ]; then
  # === Variant 2: db without the Windows UEFI CA 2023 =========================
  enroll db-noca.esl dbx.esl d133-enroll-db-noca-serial.log noca
  boot VARS_noca.fd d133-negative-db-noca-serial.log
  expect_basis d133-negative-db-noca-serial.log "db lacks the Windows UEFI CA 2023" "db negative"

  # === Variant 3: dbx without the 2011 revocation =============================
  enroll db.esl dbx-dummy.esl d133-enroll-dbx-dummy-serial.log dummydbx
  boot VARS_dummydbx.fd d133-negative-dbx-dummy-serial.log
  expect_basis d133-negative-dbx-dummy-serial.log "dbx lacks the MS 2011 revocation" "dbx negative"
fi

# === Collect artifacts ========================================================
for f in "$W"/d133-*-serial.log; do cp "$f" "$OUT/"; done
{
  echo "# D-133 Step 6 identity check — positive test + controlled negatives"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test-d133-enroll-harness.sh"
  echo "#"
  echo "# Firmware: PblApp.efi $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)… signed with the test signer"
  echo "# Helper:   EnrollKeys.efi $(sha256sum "$ENROLL_APP" | cut -d' ' -f1 | cut -c1-8)…"
  echo "# Platform: PBL OVMF build (PcdRequireSelfSignedPk=FALSE), default machine + TIS TPM, no SMM"
  echo "#"
  echo "# Fingerprints compared by PlatformState.c:"
  echo "#   Windows UEFI CA 2023              076f1fea90ac29155ebf77c17682f75f1fdd1be196da302dc8461e350a9ae330"
  echo "#   Microsoft Corporation UEFI CA 2011 48e99b991f57fc52f76149599bff0a58c47154229b9f8d603ac40d3500248507"
  echo
  for v in "positive-db-and-dbx:db={signer,WinCA2023} dbx={MS2011 hash}:Step 6 PASSES" \
           "negative-db-noca:db={signer} dbx={MS2011 hash}:BLOCK db lacks the Windows UEFI CA 2023" \
           "negative-dbx-dummy:db={signer,WinCA2023} dbx={sha256(\"\")}:BLOCK dbx lacks the MS 2011 revocation"; do
    name="${v%%:*}"; rest="${v#*:}"; vars="${rest%%:*}"; want="${rest#*:}"
    log="$OUT/d133-${name}-serial.log"
    [ -f "$log" ] || continue
    echo "## ${name}   (${vars})"
    echo "   expected: ${want}"
    grep -a "Decision BLOCK basis" "$log" | sed 's/^ *//' | sed 's/^/   observed: /' || true
    echo
  done
} > "$OUT/d133-step6-results.txt"
ok "artifacts in $OUT"

if [ "$FAILED" = "0" ]; then
  ok "D-133 positive test PASSES (and both negatives still fail closed)"
else
  err "D-133 harness FAILED"
  exit 1
fi
