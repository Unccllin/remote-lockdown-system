#!/bin/bash
# test-d215-harness.sh — D-215/D-219: policy-signature fail-closed test.
#
# Boots PblApp.efi (built with a provisioned policy signing key root of
# trust) in QEMU+swtpm with four policy.cose variants:
#
#   1. valid     — signed by the provisioned policy key → must VERIFY and
#                  continue past step [2/8]
#   2. wrongkey  — same payload + policy kid, signed by a different key →
#                  ECDSA verify fails → must BLOCK before [3/8]
#   3. tampered  — valid signature, one payload byte flipped → must BLOCK
#   4. wrongkid  — signed by a different key with that key's kid →
#                  kid mismatch → must BLOCK
#
# Prerequisites (host):
#   python3 firmware/PblPkg/gen-policy-rot.py --emit-header ...
#   bash firmware/PblPkg/build-pbl.sh        (builds RoT-provisioned efi)
#
# Usage:
#   bash test-d215-harness.sh [--timeout 30]
#
# The harness cleans up afterwards: it removes PolicyRootOfTrust.generated.h
# and rebuilds the dev-mode firmware so other harnesses are unaffected.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="30"
if [[ "$1" == "--timeout" ]]; then TIMEOUT="$2"; fi

FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${FIRMWARE_DIR}/.." && pwd)"
BUILD_DIR="/tmp/pbl-d215-ci"
GEN_HEADER="${FIRMWARE_DIR}/PblPkg/PblApp/PolicyRootOfTrust.generated.h"
GEN_BACKUP="${BUILD_DIR}/PolicyRootOfTrust.generated.h.bak"
DEV_EFI="${BUILD_DIR}/PblApp-dev.efi"

mkdir -p "${BUILD_DIR}"

cleanup() {
  # Restore dev-mode firmware: remove the generated header if we created it
  # this run (or restore the previous one), then rebuild so PblApp.efi is
  # the unprovisioned dev binary again.
  if [ -f "${GEN_HEADER}" ]; then
    rm -f "${GEN_HEADER}"
  fi
  if [ -f "${GEN_BACKUP}" ]; then
    mv "${GEN_BACKUP}" "${GEN_HEADER}"
    echo "  Restored pre-existing PolicyRootOfTrust.generated.h"
  fi
  if [ -f "${DEV_EFI}" ]; then
    cp "${DEV_EFI}" "${FIRMWARE_DIR}/PblPkg/PblApp.efi"
    echo "  Restored dev-mode PblApp.efi"
  fi
}
trap cleanup EXIT

# === Generate RoT + policy variants ===
echo "=== Generating policy root of trust + policy variants ==="
if [ -f "${GEN_HEADER}" ]; then
  cp "${GEN_HEADER}" "${GEN_BACKUP}"
fi
cp "${FIRMWARE_DIR}/PblPkg/PblApp.efi" "${DEV_EFI}" 2>/dev/null || true

python3 "${FIRMWARE_DIR}/PblPkg/gen-policy-rot.py" \
  --emit-header \
  --emit-policy            "${BUILD_DIR}/policy-valid.cose" \
  --emit-policy-wrongkey   "${BUILD_DIR}/policy-wrongkey.cose" \
  --emit-policy-tampered   "${BUILD_DIR}/policy-tampered.cose" \
  --emit-policy-wrongkid   "${BUILD_DIR}/policy-wrongkid.cose"

# Force PolicyRootOfTrust.c recompilation: the generated header is gated by
# __has_include, so it only appears in make's .deps when it existed at the
# last compile. After a dev (unprovisioned) build, an incremental build
# would skip the object and silently produce the unprovisioned binary —
# the harness would then "test" the wrong efi. Touch forces the rebuild.
touch "${FIRMWARE_DIR}/PblPkg/PblApp/PolicyRootOfTrust.c"

# === Build RoT-provisioned firmware ===
echo ""
echo "=== Building RoT-provisioned PblApp.efi ==="
bash "${FIRMWARE_DIR}/PblPkg/build-pbl.sh" 2>&1 | tail -5
cp "${FIRMWARE_DIR}/PblPkg/PblApp.efi" "${BUILD_DIR}/PblApp-rot.efi"
ROT_SHA="$(sha256sum "${BUILD_DIR}/PblApp-rot.efi" | cut -d' ' -f1)"
echo "  RoT PblApp.efi SHA-256: ${ROT_SHA}"

# === Run the 4 boot scenarios in Docker ===
echo ""
echo "=== Running D-215 scenarios in Docker (timeout ${TIMEOUT}s each) ==="

docker run --rm \
  -v "${BUILD_DIR}:/test" \
  -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
  -e TIMEOUT="${TIMEOUT}" \
  pbl-qemu:latest \
  bash -c '
set -eo pipefail

BUILD_DIR="/tmp/pbl-d215"
mkdir -p "${BUILD_DIR}"

# === Start swtpm ===
echo "=== Starting swtpm ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

start_swtpm() {
  # swtpm exits when QEMU is killed by timeout — restart it before each
  # boot, reusing the same --tpmstate dir so NV state persists.
  local sock="${BUILD_DIR}/swtpm-ctrl.sock"
  local pidfile="${BUILD_DIR}/swtpm.pid"
  if [ -f "${pidfile}" ] && kill -0 "$(cat "${pidfile}" 2>/dev/null || echo 0)" 2>/dev/null && [ -S "${sock}" ]; then
    return 0
  fi
  rm -f "${sock}" "${pidfile}"
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl type=unixio,path="${sock}" \
    --tpm2 \
    --daemon \
    --flags not-need-init \
    --pid file="${pidfile}"
  for _ in $(seq 1 20); do
    [ -S "${sock}" ] && break
    sleep 0.1
  done
  swtpm_ioctl --unix "${sock}" -i 2>/dev/null || true
  echo "  swtpm started (PID $(cat "${pidfile}" 2>/dev/null || echo "?"))"
}

start_swtpm
SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"

# OVMF: prefer the PBL custom build mounted at /ovmf
if [ -f "/ovmf/OVMF_CODE.fd" ] && [ -f "/ovmf/OVMF_VARS.fd" ]; then
  OVMF_CODE="/ovmf/OVMF_CODE.fd"
  OVMF_VARS_SRC="/ovmf/OVMF_VARS.fd"
else
  OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
  OVMF_VARS_SRC="/usr/share/OVMF/OVMF_VARS_4M.fd"
fi

boot_scenario() {
  local name="$1"
  local policy="$2"
  local log="${BUILD_DIR}/pbl-serial-${name}.log"

  start_swtpm

  local esp="${BUILD_DIR}/esp-${name}.img"
  local disk="${BUILD_DIR}/disk-${name}.img"
  rm -f "${esp}" "${disk}"

  dd if=/dev/zero of="${disk}" bs=1M count=50 status=none
  sgdisk --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:"ESP" \
    "${disk}" 2>&1 | grep -v "^Warning" || true
  mkfs.fat -F 32 -n "ESP" -C "${esp}" 50176 2>&1 >/dev/null
  mmd -i "${esp}" ::/EFI
  mmd -i "${esp}" ::/EFI/BOOT
  mmd -i "${esp}" ::/EFI/PBL
  mcopy -i "${esp}" "/test/PblApp-rot.efi" ::/EFI/BOOT/BOOTX64.EFI
  mcopy -i "${esp}" "/test/${policy}" ::/EFI/PBL/policy.cose
  dd if="${esp}" of="${disk}" bs=512 seek=2048 conv=notrunc status=none

  cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/OVMF_VARS_${name}.fd"

  python3 - "$name" "$log" "$disk" "$OVMF_CODE" "${BUILD_DIR}/OVMF_VARS_${name}.fd" "$SWTPM_ARGS" "$TIMEOUT" << "PYEOF"
import subprocess, time, select, os, sys

name, log, disk, ovmf_code, ovmf_vars, swtpm_args, timeout_s = sys.argv[1:8]

cmd = [
    "timeout", timeout_s,
    "qemu-system-x86_64",
    "-drive", f"if=pflash,format=raw,readonly=on,file={ovmf_code}",
    "-drive", f"if=pflash,format=raw,file={ovmf_vars}",
    "-drive", f"format=raw,file={disk}",
    "-nographic",
    "-m", "256M",
]
if swtpm_args:
    cmd.extend(swtpm_args.split())

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        stdin=subprocess.PIPE)
output = b""
input_sent = False
start = time.time()

while True:
    if proc.poll() is not None:
        remaining = proc.stdout.read()
        if remaining:
            output += remaining
        break
    try:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            data = os.read(proc.stdout.fileno(), 4096)
            if data:
                output += data
    except OSError:
        break
    elapsed = time.time() - start
    if not input_sent and elapsed > 8 and b"override response code" in output:
        try:
            proc.stdin.write(b"test\n")
            proc.stdin.flush()
            input_sent = True
        except BrokenPipeError:
            input_sent = True
    if elapsed > float(timeout_s):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        break

try:
    while True:
        data = os.read(proc.stdout.fileno(), 4096)
        if not data:
            break
        output += data
except OSError:
    pass
try:
    proc.stdin.close()
except BrokenPipeError:
    pass

with open(log, "wb") as f:
    f.write(output)
print(f"  [{name}] QEMU exited {proc.returncode}, log {len(output)} bytes -> {log}")
PYEOF
}

echo ""
echo "=== Boot 1: VALID policy ==="
boot_scenario valid policy-valid.cose
echo "=== Boot 2: WRONG-KEY policy ==="
boot_scenario wrongkey policy-wrongkey.cose
echo "=== Boot 3: TAMPERED policy ==="
boot_scenario tampered policy-tampered.cose
echo "=== Boot 4: WRONG-KID policy ==="
boot_scenario wrongkid policy-wrongkid.cose

# === Check results ===
echo ""
echo "=== Checking serial output ==="

PASS=0
FAIL=0

check() {
  local label="$1"; local pattern="$2"; local log="$3"
  if grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"; FAIL=$((FAIL + 1))
  fi
}

check_absent() {
  local label="$1"; local pattern="$2"; local log="$3"
  if ! grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"; FAIL=$((FAIL + 1))
  fi
}

L_VALID="${BUILD_DIR}/pbl-serial-valid.log"
L_WRONGKEY="${BUILD_DIR}/pbl-serial-wrongkey.log"
L_TAMPERED="${BUILD_DIR}/pbl-serial-tampered.log"
L_WRONGKID="${BUILD_DIR}/pbl-serial-wrongkid.log"

check "valid: PBL banner"              "PBL — Pre-Boot Lock"                    "${L_VALID}"
check "valid: policy read"             "policy.cose: [0-9]+ bytes"             "${L_VALID}"
check "valid: signature verified"      "Policy signature verified \(root of trust\)" "${L_VALID}"
check "valid: continues to step 3"     "\[3/8\] Reading TPM NV state"           "${L_VALID}"

check "wrongkey: block message"        "Policy signature verification FAILED"   "${L_WRONGKEY}"
check "wrongkey: refuse to boot"       "refusing to boot"                       "${L_WRONGKEY}"
check_absent "wrongkey: never reaches step 3" "\[3/8\] Reading TPM NV state"    "${L_WRONGKEY}"
check "wrongkey: lock screen shown"           "THIS DEVICE IS LOCKED"           "${L_WRONGKEY}"

check "tampered: block message"        "Policy signature verification FAILED"   "${L_TAMPERED}"
check_absent "tampered: never reaches step 3" "\[3/8\] Reading TPM NV state"    "${L_TAMPERED}"

check "wrongkid: block message"        "Policy signature verification FAILED"   "${L_WRONGKID}"
check_absent "wrongkid: never reaches step 3" "\[3/8\] Reading TPM NV state"    "${L_WRONGKID}"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

# === Artifacts ===
cp "${BUILD_DIR}"/pbl-serial-*.log /test/ 2>/dev/null || true

if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
  kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== wrongkey serial (last 30 lines) ==="
  tail -30 "${L_WRONGKEY}" || true
  exit 1
fi
exit 0
'

DOCKER_RC=$?

# === Write artifact ===
cat > "${BUILD_DIR}/pbl-d215-result.txt" <<EOF
PBL D-215/D-219 policy-signature fail-closed test
Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
RoT PblApp.efi SHA-256: ${ROT_SHA}
Scenarios: valid (verify+continue), wrongkey/tampered/wrongkid (block)
Docker harness exit: ${DOCKER_RC}
EOF
echo "Artifact written: ${BUILD_DIR}/pbl-d215-result.txt"

exit ${DOCKER_RC}
