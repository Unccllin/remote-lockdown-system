#!/bin/bash
# test-pbl-ovmf.sh — QEMU + swtpm smoke test for PblApp.efi
#
# Usage:
#   ./test-pbl-ovmf.sh [output-log.txt]
#
# This boots PblApp.efi in OVMF with a swtpm-backed TPM 2.0 emulator,
# writes the serial output to a log file, and exits after a timeout.
# The pbl-qemu Docker image provides qemu, swtpm, mtools, dosfstools, and gdisk.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
PBL_EFI="${SCRIPT_DIR}/PblApp.efi"
OVMF_CODE="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd"
OVMF_VARS="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_VARS.fd"
LOG_FILE="${1:-/tmp/pbl-ovmf.log}"
RUNTIME_SEC="${PBL_RUNTIME_SEC:-60}"

if [ ! -f "${PBL_EFI}" ]; then
  echo "ERROR: PblApp.efi not found at ${PBL_EFI}"
  exit 1
fi

if [ ! -f "${OVMF_CODE}" ] || [ ! -f "${OVMF_VARS}" ]; then
  echo "ERROR: OVMF not found at ${OVMF_CODE}"
  exit 1
fi

# Fresh work area on the host. It gets bind-mounted into the pbl-qemu container.
rm -rf /tmp/pbl-ovmf
mkdir -p /tmp/pbl-ovmf/swtpm

cp "${OVMF_CODE}" /tmp/pbl-ovmf/
cp "${OVMF_VARS}" /tmp/pbl-ovmf/OVMF_VARS_pbl.fd

# Stage the PBL image in a directory the container turns into a FAT32 ESP.
rm -rf /tmp/pbl-esp
mkdir -p /tmp/pbl-esp/EFI/BOOT
cp "${PBL_EFI}" /tmp/pbl-esp/EFI/BOOT/BOOTX64.EFI

echo "=== PBL OVMF smoke test ==="
echo "  PblApp.efi: ${PBL_EFI}"
echo "  OVMF code:  ${OVMF_CODE}"
echo "  Log:        ${LOG_FILE}"
echo "  Runtime:    ${RUNTIME_SEC}s"
echo ""

docker run --rm \
  -v /tmp/pbl-ovmf:/tmp/pbl-ovmf \
  -v /tmp/pbl-esp:/esp:ro \
  -e RUNTIME_SEC="${RUNTIME_SEC}" \
  pbl-qemu /bin/bash -x -c '
    set -e

    BUILD=/tmp/pbl-ovmf
    DISK="${BUILD}/pbl_disk.img"
    ESP="${BUILD}/pbl_disk.esp"

    # ---- Build a GPT disk image with a FAT32 ESP ----
    dd if=/dev/zero of="${DISK}" bs=1M count=50 status=none
    sgdisk --clear \
           --new=1:2048:0 \
           --typecode=1:EF00 \
           --change-name=1:"ESP" \
           "${DISK}" 2>&1 | grep -v "^Warning" || true

    mkfs.fat -F 32 -n "ESP" -C "${ESP}" 50176 2>&1
    mmd -i "${ESP}" ::/EFI
    mmd -i "${ESP}" ::/EFI/BOOT
    mcopy -i "${ESP}" /esp/EFI/BOOT/BOOTX64.EFI ::/EFI/BOOT/BOOTX64.EFI
    dd if="${ESP}" of="${DISK}" bs=512 seek=2048 conv=notrunc status=none

    # ---- Start swtpm ----
    SWTPM_DIR="${BUILD}/swtpm"
    mkdir -p "${SWTPM_DIR}"
    swtpm socket \
      --tpmstate dir="${SWTPM_DIR}" \
      --tpm2 \
      --server type=unixio,path="${SWTPM_DIR}/swtpm-sock" \
      --ctrl type=unixio,path="${SWTPM_DIR}/swtpm-ctrl" \
      --log file="${SWTPM_DIR}/swtpm.log" \
      --flags not-need-init &
    SWTPM_PID=$!
    sleep 0.5

    # ---- Boot OVMF with the disk + TPM ----
    timeout "${RUNTIME_SEC}s" \
      qemu-system-x86_64 \
        -m 512 \
        -smp 2 \
        -drive if=pflash,format=raw,readonly=on,file="${BUILD}/OVMF_CODE.fd" \
        -drive if=pflash,format=raw,file="${BUILD}/OVMF_VARS_pbl.fd" \
        -drive format=raw,file="${DISK}" \
        -nographic \
        -serial mon:stdio \
        -display none \
        -device e1000,netdev=net0,romfile= \
        -netdev user,id=net0 \
        -object rng-random,id=rng0,filename=/dev/urandom \
        -device virtio-rng-pci,rng=rng0 \
        -chardev socket,id=chrtpm,path="${SWTPM_DIR}/swtpm-sock" \
        -tpmdev emulator,id=tpm0,chardev=chrtpm \
        -device tpm-tis,tpmdev=tpm0 \
        2>&1 || true

    kill "${SWTPM_PID}" 2>/dev/null || true
  ' > "${LOG_FILE}" 2>&1

echo "=== Done ==="
echo "  Log written to: ${LOG_FILE}"
