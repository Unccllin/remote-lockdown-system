#!/bin/bash
# test-d130-tpm-hierarchy-harness.sh — D-130 gap 2: is "TPM under SMM" real?
#
# Why this exists
# ---------------
# D-130 (gap 2) recorded: with `tpm-tis` the SMM guest reaches a TPM holding none
# of PBL's indices (TPM_RC_HANDLE 0x18B/0x9A2), and with `tpm-crb` the boot stalls
# with no serial output. Both were attributed to the SMM/interface pairing.
#
# This harness separates the three variables that were entangled:
#   * SMM on/off          (`-machine q35,smm=on` + secure pflash)
#   * TPM device          (`tpm-tis` vs `tpm-crb`)
#   * OVMF build          (PBL build vs stock distro 4M build)
#
# What it establishes
# -------------------
# CRB is not broken and SMM is orthogonal: the outcome tracks the OVMF build.
# Stock OVMF wires `PeiDxeTpmPlatformHierarchyLib`, whose
# `ConfigureTpmPlatformHierarchy()` either randomizes `platformAuth`
# (`Tpm2HierarchyChangeAuth`) or disables the hierarchy
# (`Tpm2HierarchyControl(…, NO)`), so indices that PBL creates under
# TPM_RH_PLATFORM (TpmClient.c:1205, PcdPblTpmUsePlatformHierarchy=TRUE,
# PLATFORMCREATE) become unreachable. The PBL OVMF build is patched to
# `PeiDxeTpmPlatformHierarchyLibNull`
# (firmware/PblPkg/ovmf-platform-hierarchy-null.patch), which leaves platformAuth
# empty — that is the whole difference.
#
# Secure Boot is deliberately NOT used here: PBL reads its NV state in steps 1-3,
# before any decision, so an unsigned PblApp on an empty varstore is enough and
# the run stays fast and independent of key enrolment.
#
# Usage: ./test-d130-tpm-hierarchy-harness.sh [--out DIR] [--timeout SECS]
# Requirements: docker (image pbl-qemu:d131 by default — needs swtpm, tpm2-tools,
# qemu, mtools), python3. Run build-pbl.sh first (builds the PBL OVMF + PblApp).
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

OUT="./artifacts-d130-tpm"
TIMEOUT=60
IMAGE="${IMAGE:-pbl-qemu:d131}"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
FW_DIR="$(cd "$(dirname "$0")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '3,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

W="$(mktemp -d /tmp/pbl-d130-XXXXXX)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
cleanup() {
  rm -rf "$W" 2>/dev/null && return 0
  docker run --rm -v "$(dirname "$W")":/p alpine \
    rm -rf "/p/$(basename "$W")" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cp "$PBL_CODE" "$W/OVMF_CODE_custom.fd"
cp "$PBL_VARS" "$W/OVMF_VARS_custom.fd"
cp "$PBL_APP"  "$W/PblApp.efi"
info "work dir: $W   artifacts: $OUT"

# Stock distro OVMF, straight out of the harness image (never copied from the
# host: the PBL build patched the local edk2 tree, so only the image's own file
# is a trustworthy "stock" reference).
docker create --name pbl-d130-ovmf "$IMAGE" true >/dev/null
docker cp pbl-d130-ovmf:/usr/share/OVMF/OVMF_CODE_4M.fd        "$W/OVMF_CODE_ubu.fd"
docker cp pbl-d130-ovmf:/usr/share/OVMF/OVMF_CODE_4M.secboot.fd "$W/OVMF_CODE_ubu_sb.fd"
docker cp pbl-d130-ovmf:/usr/share/OVMF/OVMF_VARS_4M.fd        "$W/OVMF_VARS_ubu.fd"
docker rm -f pbl-d130-ovmf >/dev/null
info "stock OVMF: $(basename "$W/OVMF_CODE_ubu.fd") (TPM only) + OVMF_CODE_4M.secboot.fd (SMM, the original gap-2 case)"

cat > "$W/run.sh" <<'RSCRIPT'
#!/bin/bash
# Container side. Env: TIMEOUT. Writes state to /work/state, logs to /work so
# they survive the container (the first ad-hoc sweep lost them in /tmp).
set -eo pipefail
W=/work; B=/work/state
rm -rf "$B"; mkdir -p "$B"

AK_HEX="${AK_NAME_HEX:-000b$(printf 'ab%.0s' $(seq 1 32))}"
DATA_PORT=2431; CTRL_PORT=2432
PROV=$B/prov

echo "=== provision TPM state: NV 0x01C00003 = 34-byte AK Name (platform hierarchy) ==="
mkdir -p "$PROV"
swtpm socket --tpmstate dir="$PROV" --ctrl "type=tcp,port=$CTRL_PORT" \
  --server "type=tcp,port=$DATA_PORT" --tpm2 --daemon --flags not-need-init \
  --pid file="$B/prov.pid"
sleep 1
export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=$DATA_PORT"
tpm2_startup -c >/dev/null 2>&1 || true
python3 -c "import sys;sys.stdout.buffer.write(bytes.fromhex('$AK_HEX'))" > "$B/ak.bin"
tpm2_nvdefine 0x01C00003 -C p -s 34 -a 0x420D000D >/dev/null
tpm2_nvwrite  0x01C00003 -C p -i "$B/ak.bin" >/dev/null
echo "  provisioned: $(tpm2_nvread 0x01C00003 -C p -s 34 | od -An -tx1 | tr -d ' \n' | cut -c1-16)..."
unset TPM2TOOLS_TCTI
kill "$(cat "$B/prov.pid")" 2>/dev/null || true
sleep 1

echo "=== ESP with the unsigned PblApp (Secure Boot not needed for TPM reads) ==="
DISK=$B/disk.img; ESP=$B/esp.img
dd if=/dev/zero of="$DISK" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "$DISK" >/dev/null 2>&1
mkfs.fat -F 32 -n ESP -C "$ESP" 50176 >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT
mcopy -i "$ESP" "$W/PblApp.efi" ::/EFI/BOOT/BOOTX64.EFI
dd if="$ESP" of="$DISK" bs=512 seek=2048 conv=notrunc status=none

run_variant() { # name code vars smm dev
  local name=$1 code=$2 vars=$3 smm=$4 dev=$5
  local d=$B/$name
  rm -rf "$d"; mkdir -p "$d"
  cp -a "$PROV" "$d/swtpm"
  cp "$vars" "$d/VARS.fd"

  swtpm socket --tpmstate dir="$d/swtpm" --ctrl "type=unixio,path=$d/ctrl.sock" \
    --tpm2 --daemon --flags not-need-init --pid "file=$d/swtpm.pid" \
    --log "level=20,file=$d/swtpm.log" || true
  swtpm_ioctl --unix "$d/ctrl.sock" -i 2>/dev/null || true

  local args=(-drive "if=pflash,format=raw,readonly=on,file=$code"
              -drive "if=pflash,format=raw,file=$d/VARS.fd"
              -drive "format=raw,file=$DISK" -nographic -m 256M
              -chardev "socket,id=chrtpm,path=$d/ctrl.sock"
              -tpmdev emulator,id=tpm0,chardev=chrtpm
              -device "$dev,tpmdev=tpm0")
  if [ "$smm" = "1" ]; then
    args=(-machine q35,smm=on
          -global driver=cfi.pflash01,property=secure,value=on "${args[@]}")
  fi

  echo "--- $name (code=$(basename "$code"), smm=$smm, dev=$dev) ---"
  timeout "${TIMEOUT:-60}" qemu-system-x86_64 "${args[@]}" > "/work/d130-tpm-$name-serial.log" 2>&1 || true
  cp "$d/swtpm.log" "/work/d130-tpm-$name-swtpm.log" 2>/dev/null || true
  kill "$(cat "$d/swtpm.pid" 2>/dev/null)" 2>/dev/null || true
}

run_variant pbl-nosmm-tis "$W/OVMF_CODE_custom.fd" "$W/OVMF_VARS_custom.fd" 0 tpm-tis
run_variant pbl-smmon-tis "$W/OVMF_CODE_custom.fd" "$W/OVMF_VARS_custom.fd" 1 tpm-tis
run_variant pbl-smmon-crb "$W/OVMF_CODE_custom.fd" "$W/OVMF_VARS_custom.fd" 1 tpm-crb
run_variant ubu-nosmm-tis "$W/OVMF_CODE_ubu.fd"    "$W/OVMF_VARS_ubu.fd"    0 tpm-tis
run_variant ubu-nosmm-crb "$W/OVMF_CODE_ubu.fd"    "$W/OVMF_VARS_ubu.fd"    0 tpm-crb
run_variant ubu-smmon-tis "$W/OVMF_CODE_ubu_sb.fd" "$W/OVMF_VARS_ubu.fd"    1 tpm-tis

chown -R "${HOST_UID:-0}:${HOST_GID:-0}" /work 2>/dev/null || true

echo "=== raw results ==="
for f in /work/d130-tpm-*-serial.log; do
  n=$(basename "$f" -serial.log); n=${n#d130-tpm-}
  printf '%-14s ' "$n"
  grep -aoE 'device_id from AK Name: [A-F0-9]{8}|AK Name not available|NV_Read\(AK_NAME\) RC=0x[0-9A-F]+|NV_DefineSpace\(0x1C00001\) RC=0x[0-9A-F]+|no TCG2|TCG2 protocol' "$f" \
    | head -3 | tr '\n' ' '
  echo
done
RSCRIPT
chmod +x "$W/run.sh"

info "running 6 variants (timeout ${TIMEOUT}s each)"
docker run --rm -e TIMEOUT="$TIMEOUT" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$W":/work -v "$W/run.sh":/run.sh:ro \
  "$IMAGE" /bin/bash /run.sh 2>&1 | tail -40

# === Artifacts + assertions ===================================================
cp "$W"/d130-tpm-*-serial.log "$OUT"/ 2>/dev/null || true
cp "$W"/d130-tpm-*-swtpm.log  "$OUT"/ 2>/dev/null || true

FAILED=0
visible() { grep -aq "device_id from AK Name" "$OUT/d130-tpm-$1-serial.log"; }
hidden()  { grep -aqE "AK Name not available|NV_Read\(AK_NAME\) RC=0x9A2|RC=0x9A2" "$OUT/d130-tpm-$1-serial.log"; }
expect_visible() { if visible "$1"; then ok "$1: NV index visible to PBL"; else err "$1: expected the AK Name, got none"; FAILED=1; fi; }
expect_hidden()  { if hidden  "$1"; then ok "$1: NV index unreachable (platform-auth policy)"; else err "$1: expected RC 0x9A2, got none"; FAILED=1; fi; }

for v in pbl-nosmm-tis pbl-smmon-tis pbl-smmon-crb; do expect_visible "$v"; done
for v in ubu-nosmm-tis ubu-nosmm-crb ubu-smmon-tis; do expect_hidden  "$v"; done

{
  echo "# D-130 gap 2 — TPM NV reachability across SMM x TPM device x OVMF build"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test-d130-tpm-hierarchy-harness.sh"
  echo "#"
  echo "# PblApp.efi  $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)… (unsigned; Secure Boot not needed)"
  echo "# PBL OVMF    $(sha256sum "$PBL_CODE" | cut -d' ' -f1 | cut -c1-8)…  (PeiDxeTpmPlatformHierarchyLibNull, patched)"
  echo "# stock OVMF  $(sha256sum "$W/OVMF_CODE_ubu.fd" | cut -d' ' -f1 | cut -c1-8)…  (distro build, real hierarchy lib)"
  echo "#"
  echo "# One TPM state, provisioned once: NV 0x01C00003 = 34-byte AK Name under the"
  echo "# platform hierarchy, exactly as scripts/provision-qemu-tpm.sh does."
  echo
  echo "variant        code(smm)             AK Name visible?"
  for v in pbl-nosmm-tis pbl-smmon-tis pbl-smmon-crb ubu-nosmm-tis ubu-nosmm-crb ubu-smmon-tis; do
    f="$OUT/d130-tpm-$v-serial.log"
    if grep -aq "device_id from AK Name" "$f" 2>/dev/null; then r="YES  ($(grep -aoE 'device_id from AK Name: [A-F0-9]{8}' "$f" | head -1))"
    elif grep -aq "0x9A2" "$f" 2>/dev/null; then r="no   ($(grep -aoE 'NV_[A-Za-z]+\([^)]*\) RC=0x9A2' "$f" | head -1))"
    else r="no   (no TPM output: $(grep -acE 'PBL — Pre-Boot Lock' "$f" 2>/dev/null || echo 0) PBL banner lines)"; fi
    printf '%-14s %-21s %s\n' "$v" "$(basename "$(echo "$v" | grep -q '^pbl' && echo PBL || echo stock)")" "$r"
  done
} > "$OUT/d130-tpm-hierarchy-results.txt"
ok "artifacts in $OUT"

if [ "$FAILED" = "0" ]; then
  ok "gap 2 explained: reachability follows the OVMF platform-hierarchy policy, not SMM or TIS/CRB"
else
  err "the matrix did not match the expected shape — see $OUT/d130-tpm-hierarchy-results.txt"
  exit 1
fi
