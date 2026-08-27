#!/bin/bash
# build-ntfs-test.sh — Build and test UEFI NTFS read capability
#
# This script:
# 1. Builds the pbatard/ntfs-3g UEFI NTFS driver (ntfs.efi)
# 2. Builds the AntiTheftNtfs.efi application (loads driver, reads file)
# 3. Creates an NTFS disk image with a marker.txt file
# 4. Creates a FAT boot disk with both ntfs.efi and AntiTheftNtfs.efi
# 5. Boots QEMU with both disks and verifies the file is read from NTFS
#
# Prerequisites:
# - EDK II at ~/.local/src/edk2
# - ntfs-3g-uefi at ~/.local/src/ntfs-3g-uefi
# - ntfs-3g tools (mkntfs, ntfscp) extracted to /tmp/ntfs-tools/extract
# - QEMU at /tmp/qemu-extract/usr/bin/qemu-system-x86_64
# - mtools, dosfstools, gdisk extracted to /tmp/

set -eo pipefail

EDK2_DIR="/home/cllin/.local/src/edk2"
NTFS3G_DIR="/home/cllin/.local/src/ntfs-3g-uefi"
FIRMWARE_DIR="/home/cllin/remote-lockdown-system/firmware"
BUILD_DIR="/tmp/uefi-test"
QEMU="/tmp/qemu-extract/usr/bin/qemu-system-x86_64"
MKFS="/tmp/dosfstools-extract/usr/sbin/mkfs.fat"
SGDISK="/tmp/gdisk-extract/usr/sbin/sgdisk"
MMD="/tmp/mtools-extract/usr/bin/mmd"
MCOPY="/tmp/mtools-extract/usr/bin/mcopy"
NTFS_EXTRACT="/tmp/ntfs-tools/extract"
export PATH="/tmp/mtools-extract/usr/bin:$NTFS_EXTRACT/usr/sbin:$NTFS_EXTRACT/usr/bin:/home/cllin/.local/bin:$PATH"
export LD_LIBRARY_PATH="$NTFS_EXTRACT/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"

mkdir -p "$BUILD_DIR"

# === Step 1: Build NTFS driver ===
echo "=== Building ntfs.efi (UEFI NTFS driver) ==="
cd "$NTFS3G_DIR"
export WORKSPACE=$PWD
export EDK2_PATH=$EDK2_DIR
export PACKAGES_PATH=$WORKSPACE:$EDK2_PATH
export EDK_TOOLS_PATH=$EDK2_PATH/BaseTools
source $EDK2_PATH/edksetup.sh --reconfig
build -a X64 -b RELEASE -t GCC -p uefi-driver.dsc 2>&1 | tail -3
NTFS_EFI="$NTFS3G_DIR/Build/RELEASE_GCC/X64/ntfs.efi"
echo "Built: $NTFS_EFI ($(stat -c%s "$NTFS_EFI") bytes)"

# === Step 2: Build AntiTheftNtfs.efi ===
echo ""
echo "=== Building AntiTheftNtfs.efi ==="
cd "$FIRMWARE_DIR"
export WORKSPACE=$EDK2_DIR
export PACKAGES_PATH=$WORKSPACE:$FIRMWARE_DIR
build -p AntiTheftNtfs.dsc -a X64 -t GCC -b RELEASE 2>&1 | tail -3
NTFS_APP="$EDK2_DIR/Build/AntiTheftNtfs/RELEASE_GCC/X64/AntiTheftNtfs.efi"
echo "Built: $NTFS_APP ($(stat -c%s "$NTFS_APP") bytes)"

# === Step 3: Create NTFS data disk with marker.txt ===
echo ""
echo "=== Creating NTFS data disk ==="
dd if=/dev/zero of="$BUILD_DIR/ntfs_raw.img" bs=1M count=16 status=none
mkntfs -F -Q -L "ANTITHEFT" "$BUILD_DIR/ntfs_raw.img" 2>&1 | tail -1

# Create marker.txt
echo "ANTI-THEFT MARKER FILE" > /tmp/marker.txt
echo "Device ID: HP-LAPTOP-001" >> /tmp/marker.txt
echo "Timestamp: $(date -u +%s)" >> /tmp/marker.txt
echo "State: ACTIVATED" >> /tmp/marker.txt
ntfscp "$BUILD_DIR/ntfs_raw.img" /tmp/marker.txt marker.txt 2>&1

# Create GPT-partitioned NTFS disk
rm -f "$BUILD_DIR/ntfs_data.img"
dd if=/dev/zero of="$BUILD_DIR/ntfs_data.img" bs=1M count=32 status=none
$SGDISK --clear --new=1:2048:0 --typecode=1:0700 --change-name=1:"NTFS" \
    "$BUILD_DIR/ntfs_data.img" 2>&1 | grep -v "^Warning"
dd if="$BUILD_DIR/ntfs_raw.img" of="$BUILD_DIR/ntfs_data.img" bs=512 seek=2048 conv=notrunc status=none

# === Step 4: Create FAT boot disk ===
echo ""
echo "=== Creating FAT boot disk ==="
rm -f "$BUILD_DIR/ntfs_boot.img" "$BUILD_DIR/ntfs_boot.img.esp"
dd if=/dev/zero of="$BUILD_DIR/ntfs_boot.img" bs=1M count=50 status=none
$SGDISK --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:"ESP" \
    "$BUILD_DIR/ntfs_boot.img" 2>&1 | grep -v "^Warning"
$MKFS -F 32 -n "ESP" -C "$BUILD_DIR/ntfs_boot.img.esp" 50176 2>&1
$MMD -i "$BUILD_DIR/ntfs_boot.img.esp" ::/EFI
$MMD -i "$BUILD_DIR/ntfs_boot.img.esp" ::/EFI/BOOT
$MCOPY -o -i "$BUILD_DIR/ntfs_boot.img.esp" "$NTFS_APP" ::/EFI/BOOT/BOOTX64.EFI
$MCOPY -o -i "$BUILD_DIR/ntfs_boot.img.esp" "$NTFS_EFI" ::/ntfs.efi
dd if="$BUILD_DIR/ntfs_boot.img.esp" of="$BUILD_DIR/ntfs_boot.img" bs=512 seek=2048 conv=notrunc status=none

# === Step 5: Boot QEMU and verify ===
echo ""
echo "=== Booting QEMU with NTFS test ==="
OVMF_DIR="$EDK2_DIR/Build/OvmfX64/RELEASE_GCC/FV"
cp "$OVMF_DIR/OVMF_VARS.fd" "$BUILD_DIR/OVMF_VARS_ntfs.fd"

timeout 25 "$QEMU" \
    -L "$BUILD_DIR/pc-bios" \
    -drive if=pflash,format=raw,readonly=on,file="$OVMF_DIR/OVMF_CODE.fd" \
    -drive if=pflash,format=raw,file="$BUILD_DIR/OVMF_VARS_ntfs.fd" \
    -drive format=raw,file="$BUILD_DIR/ntfs_boot.img" \
    -drive format=raw,file="$BUILD_DIR/ntfs_data.img" \
    -nographic -serial mon:stdio -display none -m 256M -nic none \
    2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | grep -iE "Anti-Theft|NTFS|marker|FOUND|OK|ERROR|volume|loaded|contents|bytes|ACTIVATED|Device ID|State|Timestamp|PASS|FAIL" | head -20

echo ""
echo "=== Test Complete ==="
echo "If you see 'marker.txt contents' with the file data, NTFS read from UEFI works."
