#!/bin/bash
# test-d134-owner-hierarchy-harness.sh — the D-134 ruling, end to end in QEMU.
#
# D-134 ruled: NV indices live in the OWNER hierarchy, and NV_Read is authorized
# by the index handle (so neither platformAuth nor ownerAuth can break it).
# This harness proves the shipped default does that, on the firmware that used to
# defeat PBL entirely — the stock distro OVMF, which randomizes/disables the
# platform hierarchy at EndOfDxe exactly as a real machine's firmware does.
#
# Arms (all with the current firmware/PblPkg/PblApp.efi):
#   1. owner-provisioned TPM  + stock OVMF   -> must read the AK Name  (was 0x9A2)
#   2. owner-provisioned TPM  + PBL OVMF     -> must read the AK Name  (control)
#   3. platform-provisioned   + stock OVMF   -> must also read it      (index-handle
#      authorization does not care which hierarchy created the index, so machines
#      provisioned under the old scheme keep working after the firmware upgrade)
#
# "Provisioned" means NV 0x01C00003 holds the 34-byte AK Name, which is what
# enrolment writes (C2 §5.4 step 8). Nothing here needs Secure Boot.
#
# Usage: ./test-d134-owner-hierarchy-harness.sh [--out DIR] [--timeout SECS]
# Requires: docker (image pbl-qemu:d131), python3, and a current build (build-pbl.sh).
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

OUT="./artifacts-d134-qemu"
TIMEOUT=60
IMAGE="${IMAGE:-pbl-qemu:d131}"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
FW_DIR="$(cd "$(dirname "$0")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

info() { printf '[INFO]  %s\n' "$*"; }
ok()   { printf '[OK]    %s\n' "$*"; }
err()  { printf '[ERROR] %s\n' "$*" >&2; }

PBL_CODE="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd"
PBL_VARS="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_VARS.fd"
PBL_APP="${FW_DIR}/PblApp.efi"
for f in "$PBL_CODE" "$PBL_VARS" "$PBL_APP"; do
  [ -f "$f" ] || { err "missing $f — run build-pbl.sh"; exit 1; }
done
command -v docker >/dev/null || { err "docker not found"; exit 1; }

W="$(mktemp -d /tmp/pbl-d134q-XXXXXX)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
cleanup() {
  rm -rf "$W" 2>/dev/null && return 0
  docker run --rm -v "$(dirname "$W")":/p alpine \
    rm -rf "/p/$(basename "$W")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$PBL_CODE" "$W/OVMF_CODE_custom.fd"
cp "$PBL_VARS" "$W/OVMF_VARS_custom.fd"
cp "$PBL_APP"  "$W/PblApp.efi"
docker create --name pbl-d134q-ext "$IMAGE" true >/dev/null
docker cp pbl-d134q-ext:/usr/share/OVMF/OVMF_CODE_4M.fd "$W/OVMF_CODE_ubu.fd"
docker cp pbl-d134q-ext:/usr/share/OVMF/OVMF_VARS_4M.fd "$W/OVMF_VARS_ubu.fd"
docker rm -f pbl-d134q-ext >/dev/null
info "work dir: $W   artifacts: $OUT"
info "PblApp $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)…  stock OVMF $(sha256sum "$W/OVMF_CODE_ubu.fd" | cut -d' ' -f1 | cut -c1-8)…"

cat > "$W/run.sh" <<'RSCRIPT'
#!/bin/bash
# Container side. Env: TIMEOUT.
set -eo pipefail
W=/work; B=/work/state
rm -rf "$B"; mkdir -p "$B"

AK_HEX="000b$(printf 'ab%.0s' $(seq 1 32))"
python3 -c "import sys;sys.stdout.buffer.write(bytes.fromhex('$AK_HEX'))" > "$B/ak.bin"
N=0

provision() { # name define-auth attrs
  local name=$1 dauth=$2 attrs=$3
  local d=$B/$name
  rm -rf "$d"; mkdir -p "$d"
  # tpm2-tools' swtpm TCTI derives the control port as data+1, so keep that offset.
  local data=$((2600 + N*2)) ctrl=$((2600 + N*2 + 1))
  N=$((N+1))
  swtpm socket --tpmstate dir="$d" --ctrl "type=tcp,port=$ctrl" \
    --server "type=tcp,port=$data" --tpm2 --daemon --flags not-need-init --pid "file=$d/pid"
  sleep 0.7
  export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=$data"
  tpm2_startup -c >/dev/null 2>&1 || true
  tpm2_nvdefine 0x01C00003 -C "$dauth" -s 34 -a "$attrs" >/dev/null
  tpm2_nvwrite  0x01C00003 -C 0x01C00003 -i "$B/ak.bin" >/dev/null
  unset TPM2TOOLS_TCTI
  kill "$(cat "$d/pid")" 2>/dev/null || true
  sleep 0.6
  rm -f "$d/pid"
  echo "  provisioned $name (auth=$dauth attrs=$attrs)"
}

boot() { # name code state-dir
  local name=$1 code=$2 state=$3
  local d=$B/boot-$name
  rm -rf "$d"; mkdir -p "$d"
  cp -a "$B/$state" "$d/swtpm"
  cp "$W/OVMF_VARS_ubu.fd" "$d/VARS.fd"

  local esp=$d/esp.img disk=$d/disk.img
  dd if=/dev/zero of="$disk" bs=1M count=50 status=none
  sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "$disk" >/dev/null 2>&1
  mkfs.fat -F 32 -n ESP -C "$esp" 50176 >/dev/null
  mmd -i "$esp" ::/EFI ::/EFI/BOOT
  mcopy -i "$esp" "$W/PblApp.efi" ::/EFI/BOOT/BOOTX64.EFI
  dd if="$esp" of="$disk" bs=512 seek=2048 conv=notrunc status=none

  swtpm socket --tpmstate dir="$d/swtpm" --ctrl "type=unixio,path=$d/ctrl.sock" \
    --tpm2 --daemon --flags not-need-init --pid "file=$d/swtpm.pid" || true
  swtpm_ioctl --unix "$d/ctrl.sock" -i 2>/dev/null || true

  echo "--- boot $name (code=$(basename "$code"), tpm=$state) ---"
  timeout "${TIMEOUT:-60}" qemu-system-x86_64 \
    -drive "if=pflash,format=raw,readonly=on,file=$code" \
    -drive "if=pflash,format=raw,file=$d/VARS.fd" \
    -drive "format=raw,file=$disk" -nographic -m 256M \
    -chardev "socket,id=chrtpm,path=$d/ctrl.sock" \
    -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
    > "/work/d134q-$name-serial.log" 2>&1 || true
  kill "$(cat "$d/swtpm.pid" 2>/dev/null)" 2>/dev/null || true
  grep -aE "device_id from AK Name|NV_Read\(AK_NAME\) RC|AK Name not available" \
    "/work/d134q-$name-serial.log" | head -3 | sed 's/^/    /'
}

echo "=== provisioning (owner hierarchy = the ruling; platform = old scheme) ==="
provision prov-owner     o 0x02060004
provision prov-platform  p 0x420D000D

echo "=== boots ==="
boot owner-stock    "$W/OVMF_CODE_ubu.fd"    prov-owner
boot owner-pbl      "$W/OVMF_CODE_custom.fd" prov-owner
boot platform-stock "$W/OVMF_CODE_ubu.fd"    prov-platform

chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /work 2>/dev/null || true
RSCRIPT
chmod +x "$W/run.sh"

info "running 3 arms (timeout ${TIMEOUT}s each)"
docker run --rm -e TIMEOUT="$TIMEOUT" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$W":/work -v "$W/run.sh":/run.sh:ro "$IMAGE" /bin/bash /run.sh 2>&1 | tail -20

cp "$W"/d134q-*-serial.log "$OUT"/ 2>/dev/null || true

FAILED=0
check_read() { # arm expected-substring label
  if grep -aq "$2" "$OUT/d134q-$1-serial.log"; then ok "$3"; else err "$3 — see d134q-$1-serial.log"; FAILED=1; fi
}
check_read owner-stock    "device_id from AK Name" "owner-provisioned + stock OVMF: AK Name read (the fix works)"
check_read owner-pbl      "device_id from AK Name" "owner-provisioned + PBL OVMF:   AK Name read (control)"
check_read platform-stock "device_id from AK Name" "platform-provisioned + stock:   AK Name read (old scheme still readable)"

{
  echo "# D-134 — owner-hierarchy default verified in QEMU"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test-d134-owner-hierarchy-harness.sh"
  echo "#"
  echo "# PblApp      $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)…  (PcdPblTpmUsePlatformHierarchy=FALSE, index-handle auth)"
  echo "# stock OVMF  $(sha256sum "$W/OVMF_CODE_ubu.fd" | cut -d' ' -f1 | cut -c1-8)…  (randomizes/disables platformAuth —"
  echo "#             the same behaviour that made the old build report 0x9A2)"
  echo "# PBL OVMF    $(sha256sum "$PBL_CODE" | cut -d' ' -f1 | cut -c1-8)…  (patched to PeiDxeTpmPlatformHierarchyLibNull)"
  echo
  echo "arm             provisioned under   OVMF    result"
  for a in owner-stock owner-pbl platform-stock; do
    case "$a" in owner-*) p="owner" ;; *) p="platform" ;; esac
    case "$a" in *-stock) c="stock" ;; *) c="PBL" ;; esac
    if grep -aq "device_id from AK Name" "$OUT/d134q-$a-serial.log" 2>/dev/null; then
      r="$(grep -ao 'device_id from AK Name: [A-F0-9]*\.*[A-F0-9]*' "$OUT/d134q-$a-serial.log" | head -1)"
    elif grep -aq "0x149" "$OUT/d134q-$a-serial.log" 2>/dev/null; then r="RC=0x149 TPM_RC_NV_AUTHORIZATION"
    elif grep -aq "0x9A2" "$OUT/d134q-$a-serial.log" 2>/dev/null; then r="RC=0x9A2 TPM_RC_HANDLE"
    else r="no TPM output"; fi
    printf '%-16s %-19s %-7s %s\n' "$a" "$p" "$c" "$r"
  done
} > "$OUT/d134-owner-hierarchy-results.txt"
ok "artifacts in $OUT"

if [ "$FAILED" = "0" ]; then
  ok "D-134 ruling verified: owner hierarchy + index-handle auth reads NV on stock firmware"
else
  err "one or more arms did not read the AK Name — see $OUT/d134-owner-hierarchy-results.txt"
  exit 1
fi
