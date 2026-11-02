#!/bin/bash
# test-d134-nv-auth-matrix.sh — which authorization actually reads a PBL NV index?
#
# Why this exists
# ---------------
# D-134 asks whether PBL's NV indices should live in the platform or the owner
# hierarchy. The firmware picks with `PcdPblTpmUsePlatformHierarchy`, and the
# FALSE branch was written as a dev fallback but, per this matrix, has never been
# able to read what it defines:
#
#   PblTpmNvDefineSpace  defines owner indices with 0x02040004
#                        (AUTHWRITE|AUTHREAD|NO_DA  — no OWNERREAD)
#   PblTpmReadAkName     authorizes NV_Read with TPM_RH_OWNER when the PCD is FALSE
#
# TPM 2.0 requires TPMA_NV_OWNERREAD when authHandle is TPM_RH_OWNER, so that pair
# returns TPM_RC_NV_AUTHORIZATION (0x149). A PblApp built with the PCD FALSE, run
# against a platform-provisioned index, does exactly that (see
# artifacts/d130-tpm-*: RC=0x9A2 for the TRUE build, RC=0x149 for the FALSE one).
#
# This harness is pure tpm2-tools + swtpm — no OVMF, no PblApp, no build — so the
# authorization rules can be stated independently of the firmware. Each case gets
# a fresh TPM because PLATFORMCREATE deliberately prevents the owner hierarchy from
# deleting a platform-created index, which would otherwise poison the next case.
#
# Usage: ./test-d134-nv-auth-matrix.sh [--out DIR]
# Requirements: docker (image pbl-qemu:d131 — swtpm + tpm2-tools), python3.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

OUT="./artifacts-d134"
IMAGE="${IMAGE:-pbl-qemu:d131}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

info() { printf '[INFO]  %s\n' "$*"; }
ok()   { printf '[OK]    %s\n' "$*"; }
err()  { printf '[ERROR] %s\n' "$*" >&2; }

command -v docker >/dev/null || { err "docker not found"; exit 1; }
W="$(mktemp -d /tmp/pbl-d134-XXXXXX)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
cleanup() {
  rm -rf "$W" 2>/dev/null && return 0
  docker run --rm -v "$(dirname "$W")":/p alpine \
    rm -rf "/p/$(basename "$W")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat > "$W/matrix.sh" <<'RSCRIPT'
#!/bin/bash
# Container side: one fresh swtpm per case; writes always use the index handle so
# the only variable under test is the READ authorization path.
set -uo pipefail
W=/work
AK=$W/ak.bin
python3 -c "import sys;sys.stdout.buffer.write(bytes.fromhex('000b'+'ab'*32))" > "$AK"
N=0

try() { # label attrs define-auth read-auth
  local label=$1 attrs=$2 dauth=$3 rauth=$4
  N=$((N+1))
  local B=$W/tpm-$N; rm -rf "$B"; mkdir -p "$B"
  local dport=$((2500 + N*2)) cport=$((2500 + N*2 + 1))
  swtpm socket --tpmstate dir="$B" --ctrl "type=tcp,port=$cport" \
    --server "type=tcp,port=$dport" --tpm2 --daemon --flags not-need-init \
    --pid "file=$B/pid"
  sleep 0.7
  export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=$dport"
  tpm2_startup -c >/dev/null 2>&1 || true

  local verdict
  if ! tpm2_nvdefine 0x01C00003 -C "$dauth" -s 34 -a "$attrs" >/dev/null 2>"$B/e"; then
    verdict="DEFINE-FAILED"
  elif ! tpm2_nvwrite 0x01C00003 -C 0x01C00003 -i "$AK" >/dev/null 2>"$B/e"; then
    verdict="WRITE-FAILED"
  elif tpm2_nvread 0x01C00003 -C "$rauth" -s 34 >/dev/null 2>"$B/e"; then
    verdict="READ-OK"
  else
    verdict="READ-DENIED($(grep -oE '0x[0-9a-f]{8,9}' "$B/e" | head -1))"
  fi
  printf '%s|%s|%s|%s|%s\n' "$N" "$label" "$attrs" "$rauth" "$verdict" >> "$W/matrix.txt"
  kill "$(cat "$B/pid")" 2>/dev/null
  rm -rf "$B"
}

echo "lane|case|attrs|read-auth|result" > "$W/matrix.txt"
echo "=== production attributes, define under the platform hierarchy (0x420D000D) ==="
try "production: read via platform auth"    0x420D000D p p
try "production: read via index auth"       0x420D000D p 0x01C00003
try "production: read via owner auth"       0x420D000D p o

echo "=== FALSE-branch attributes as coded, define under owner (0x02040004) ==="
try "PCD=FALSE as coded: read via owner auth"   0x02040004 o o
try "PCD=FALSE as coded: read via index auth"   0x02040004 o 0x01C00003

echo "=== FALSE-branch + OWNERREAD (0x02060004 = 0x02040004 | 0x20000) ==="
try "PCD=FALSE + OWNERREAD: read via owner auth" 0x02060004 o o
try "PCD=FALSE + OWNERREAD: read via index auth" 0x02060004 o 0x01C00003

chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$W" 2>/dev/null || true
cat "$W/matrix.txt"
RSCRIPT
chmod +x "$W/matrix.sh"

info "running the authorization matrix (7 fresh TPMs)"
docker run --rm -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$W":/work -v "$W/matrix.sh":/matrix.sh:ro "$IMAGE" /bin/bash /matrix.sh \
  2>&1 | grep -vE "^(ERROR|WARNING)" | tail -20

# === Assertions: the matrix must show exactly this shape ======================
get() { awk -F'|' -v c="$1" '$2==c {print $5}' "$W/matrix.txt"; }
FAILED=0
expect() { # case expected
  local got; got="$(get "$1")"
  if [ "$got" = "$2" ]; then ok "$1 -> $got"; else err "$1 -> $got (expected $2)"; FAILED=1; fi
}
expect "production: read via platform auth"      "READ-OK"
expect "production: read via owner auth"         "READ-DENIED(0x00000149)"
expect "PCD=FALSE as coded: read via owner auth" "READ-DENIED(0x00000149)"
expect "PCD=FALSE as coded: read via index auth" "READ-OK"
expect "PCD=FALSE + OWNERREAD: read via owner auth" "READ-OK"

{
  echo "# D-134 — NV authorization matrix (platform vs owner hierarchy)"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test-d134-nv-auth-matrix.sh"
  echo "#"
  echo "# Pure tpm2-tools + swtpm: no OVMF, no PblApp, so these are the TPM's rules,"
  echo "# not our firmware's behaviour. Each case starts from a fresh TPM because"
  echo "# PLATFORMCREATE stops the owner hierarchy deleting a platform index."
  echo "#"
  echo "# TPMA_NV attributes used:"
  echo "#   0x420D000D  PPWRITE|AUTHWRITE|POLICYWRITE|PPREAD|AUTHREAD|POLICYREAD|"
  echo "#               NO_DA|PLATFORMCREATE   (production, platform hierarchy)"
  echo "#   0x02040004  AUTHWRITE|AUTHREAD|NO_DA   (PCD=FALSE, as coded today)"
  echo "#   0x02060004  the above | OWNERREAD (0x20000)   (candidate fix)"
  echo
  column -t -s'|' "$W/matrix.txt"
  echo
  echo "# Reading: TPM2_NV_Read(authHandle=TPM_RH_OWNER) requires TPMA_NV_OWNERREAD."
  echo "# The PCD=FALSE branch defines with AUTHREAD only and authorizes with RH_OWNER,"
  echo "# so it cannot read its own index — 0x149 = TPM_RC_NV_AUTHORIZATION."
} > "$OUT/d134-nv-auth-matrix-results.txt"
cp "$W/matrix.txt" "$OUT/d134-nv-auth-matrix-raw.csv"
ok "artifacts in $OUT"

if [ "$FAILED" = "0" ]; then
  ok "D-134 authorization matrix matches: the FALSE branch is broken as coded"
else
  err "matrix shape differs from expectation — see $OUT/d134-nv-auth-matrix-results.txt"
  exit 1
fi
