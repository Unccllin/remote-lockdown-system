#!/bin/bash
# ci-harness.sh — QEMU + swtpm CI harness for PblApp.
#
# Boots PblApp.efi in OVMF (QEMU) with a swtpm TPM 2.0 simulator.
# Captures serial output and checks for the PBL banner + scaffold completion.
#
# This is a stub — Agent D delivers the full swtpm + tpm2-tools reference
# (C2 §8). This harness wires PblApp.efi into QEMU for smoke testing.
#
# Usage:
#   ./ci-harness.sh [--timeout 30]
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-30}"
FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
BUILD_DIR="/tmp/pbl-ci"
QEMU="${QEMU:-/tmp/qemu-extract/usr/bin/qemu-system-x86_64}"

# Tools from legacy build environment
MKFS="${MKFS:-/tmp/dosfstools-extract/usr/sbin/mkfs.fat}"
MMD="${MMD:-/tmp/mtools-extract/usr/bin/mmd}"
MCOPY="${MCOPY:-/tmp/mtools-extract/usr/bin/mcopy}"
SGDISK="${SGDISK:-/tmp/gdisk-extract/usr/sbin/sgdisk}"

export MTOOLS_SKIP_CHECK=1

mkdir -p "${BUILD_DIR}"

# === Check prerequisites ===
PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
if [ ! -f "${PBL_APP}" ]; then
  echo "ERROR: PblApp.efi not found at ${PBL_APP}"
  echo "Run build-pbl.sh first."
  exit 1
fi

OVMF_DIR="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV"
if [ ! -f "${OVMF_DIR}/OVMF_CODE.fd" ]; then
  echo "ERROR: OVMF not built. Run build-pbl.sh first."
  exit 1
fi

# === Start swtpm (TPM 2.0 simulator) ===
echo "=== Starting swtpm (TPM 2.0 simulator) ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

if command -v swtpm >/dev/null 2>&1; then
  # D-101: use only the --ctrl socket; QEMU's TPM backend passes the data
  # channel fd via CMD_SET_DATAFD. Pre-opening --server makes that fail.
  rm -f "${BUILD_DIR}/swtpm-ctrl.sock"
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
    --tpm2 \
    --daemon \
    --flags not-need-init \
    --pid file="${BUILD_DIR}/swtpm.pid"
  swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
  SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"
  echo "  swtpm started (PID $(cat "${BUILD_DIR}/swtpm.pid" 2>/dev/null || echo '?'))"
else
  echo "  [WARN] swtpm not installed — running without TPM"
  SWTPM_ARGS=""
fi

# === Create disk image with PblApp.efi on ESP ===
echo "=== Creating ESP disk image ==="
DISK_IMG="${BUILD_DIR}/pbl_disk.img"
rm -f "${DISK_IMG}" "${DISK_IMG}.esp"

dd if=/dev/zero of="${DISK_IMG}" bs=1M count=50 status=none
"${SGDISK}" --clear \
  --new=1:2048:0 \
  --typecode=1:EF00 \
  --change-name=1:"ESP" \
  "${DISK_IMG}" 2>&1 | grep -v "^Warning" || true

"${MKFS}" -F 32 -n "ESP" -C "${DISK_IMG}.esp" 50176 2>&1
"${MMD}" -i "${DISK_IMG}.esp" ::/EFI
"${MMD}" -i "${DISK_IMG}.esp" ::/EFI/BOOT
"${MCOPY}" -i "${DISK_IMG}.esp" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
dd if="${DISK_IMG}.esp" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

# === Boot in QEMU ===
echo ""
echo "=== Booting PblApp in OVMF (timeout ${TIMEOUT}s) ==="

# Fresh OVMF_VARS for each run
cp "${OVMF_DIR}/OVMF_VARS.fd" "${BUILD_DIR}/OVMF_VARS_pbl.fd"

SERIAL_LOG="${BUILD_DIR}/pbl-serial.log"

timeout "${TIMEOUT}" "${QEMU}" \
  -L "${BUILD_DIR}/pc-bios" \
  -drive if=pflash,format=raw,readonly=on,file="${OVMF_DIR}/OVMF_CODE.fd" \
  -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS_pbl.fd" \
  -drive format=raw,file="${DISK_IMG}" \
  -nographic \
  -serial mon:stdio \
  -display none \
  -m 256M \
  -device e1000,netdev=net0,romfile=efi-e1000.rom \
  -netdev user,id=net0 \
  -object rng-random,id=rng0,filename=/dev/urandom \
  -device virtio-rng-pci,rng=rng0 \
  ${SWTPM_ARGS} \
  > "${SERIAL_LOG}" 2>&1 || true

# === Check results ===
echo ""
echo "=== Checking serial output ==="

PASS=0
FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  if grep -qE "${pattern}" "${SERIAL_LOG}"; then
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

check "PBL banner appears" "PBL — Pre-Boot Lock"
check "Platform state step" "\[1/8\] Collecting platform state"
check "Policy parse step" "\[2/8\] Parsing policy blob"
check "TPM NV read step" "\[3/8\] Reading TPM NV state"
check "Verdict fetch step" "\[4/8\] Fetching verdict"
check "Verdict verify step" "\[5/8\] Verifying verdict"
check "Decision step" "\[6/8\] Evaluating decision"
check "PCR extend step" "\[7/8\] Extending PCR 12/13"
check "Decision action step" "\[8/8\] Decision:"
check "NV indices provisioned" "\[OK\] NV indices provisioned"
check "HMAC session established" "\[OK\] HMAC session established \(bound to lock-state NV\)"
check "Scaffold completion" "PBL scaffold complete"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

# === Cleanup swtpm ===
if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
  kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== Serial log (last 30 lines) ==="
  tail -30 "${SERIAL_LOG}"
  exit 1
fi

exit 0
