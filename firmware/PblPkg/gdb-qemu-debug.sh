#!/bin/bash
# gdb-qemu-debug.sh — QEMU + GDB debugging for PBL EFI binary
#
# This is the WinDbg alternative: GDB + QEMU for UEFI debugging.
#
# Usage:
#   docker run --rm -v /home/cllin/.local/src/edk2:/edk2 -v /home/cllin/remote-lockdown-system/firmware:/firmware pbl-qemu:latest /firmware/PblPkg/gdb-qemu-debug.sh
#
# What this does:
#   1. Starts QEMU with OVMF firmware + PBL EFI binary
#   2. QEMU waits for GDB connection (-S flag)
#   3. GDB connects and sets breakpoints
#   4. Step through PBL code

set -eo pipefail

EDK2_DIR="${EDK2_DIR:-/edk2}"
FIRMWARE_DIR="/firmware"
BUILD_DIR="/tmp/pbl-gdb"

mkdir -p "${BUILD_DIR}"

# Install GDB if not present
if ! which gdb >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq gdb >/dev/null 2>&1
fi

# Check prerequisites
PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
if [ ! -f "${PBL_APP}" ]; then
    echo "ERROR: PblApp.efi not found"
    exit 1
fi

OVMF_DIR="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV"
if [ ! -f "${OVMF_DIR}/OVMF_CODE.fd" ]; then
    echo "ERROR: OVMF not built"
    exit 1
fi

# Create a FAT disk image with PBL
MKFS=$(which mkfs.fat 2>/dev/null || which mkdosfs 2>/dev/null)
MMD=$(which mmd 2>/dev/null)
MCOPY=$(which mcopy 2>/dev/null)
export MTOOLS_SKIP_CHECK=1

DISK_IMG="${BUILD_DIR}/pbl-disk.img"
${MKFS} -C "${DISK_IMG}" 32
${MMD} -i "${DISK_IMG}" ::/EFI
${MMD} -i "${DISK_IMG}" ::/EFI/BOOT
${MMD} -i "${DISK_IMG}" ::/EFI/Microsoft
${MMD} -i "${DISK_IMG}" ::/EFI/Microsoft/Boot
${MCOPY} -i "${DISK_IMG}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
${MCOPY} -i "${DISK_IMG}" "${PBL_APP}" ::/EFI/Microsoft/Boot/bootmgfw.efi

echo "=== QEMU + GDB Debug Setup ==="
echo "PBL binary: ${PBL_APP}"
echo "OVMF firmware: ${OVMF_DIR}/OVMF_CODE.fd"
echo "Disk image: ${DISK_IMG}"
echo ""
echo "Starting QEMU with GDB server on port 1234..."
echo "Connect with: gdb -ex 'target remote :1234'"
echo ""

# Start QEMU with GDB stub (-s) and freeze (-S)
# -s = GDB server on port 1234
# -S = freeze CPU at startup (wait for GDB)
# -d int = log interrupts
qemu-system-x86_64 \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_DIR}/OVMF_CODE.fd" \
    -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS.fd" \
    -drive format=raw,file="${DISK_IMG}" \
    -net none \
    -m 256M \
    -s -S \
    -serial stdio \
    -display none \
    -d int 2>&1 | tee "${BUILD_DIR}/qemu-gdb.log"
