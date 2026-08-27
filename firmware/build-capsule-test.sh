#!/bin/bash
# build-capsule-test.sh — Build and test UEFI capsule update in QEMU
#
# This script:
# 1. Builds the AntiTheft DXE driver (capsule payload)
# 2. Generates signing keys (self-signed)
# 3. Creates signed and unsigned capsule files
# 4. Builds CapsuleLoader.efi (UEFI app to process capsules)
# 5. Creates a FAT test disk with CapsuleLoader + capsule
# 6. Boots QEMU/OVMF and verifies the capsule is processed
#
# Usage: bash build-capsule-test.sh
#

set -e

PROJECT_DIR="/home/cllin/remote-lockdown-system"
FIRMWARE_DIR="$PROJECT_DIR/firmware"
EDK2_DIR="/home/cllin/.local/src/edk2"
CAPSULE_OUTPUT="$FIRMWARE_DIR/capsule-output"

export WORKSPACE=$EDK2_DIR
export PACKAGES_PATH=$EDK2_DIR:$FIRMWARE_DIR
export EDK_TOOLS_PATH=$EDK2_DIR/BaseTools
export PATH="/home/cllin/.local/bin:$EDK2_DIR/BaseTools/BinWrappers/PosixLike:$PATH"

echo "=========================================="
echo "  UEFI Capsule Update Build + Test"
echo "=========================================="
echo ""

# Step 1: Build the DXE driver (capsule payload)
echo "[1/6] Building AntiTheft DXE driver (capsule payload)..."
source $EDK2_DIR/edksetup.sh --reconfig 2>&1 | tail -1
build -p $FIRMWARE_DIR/AntiTheftCapsule.dsc -a X64 -t GCC -b RELEASE 2>&1 | grep -E "Done|Failed"

PAYLOAD="$EDK2_DIR/Build/AntiTheftCapsule/RELEASE_GCC/X64/AntiTheftFmpDxe.efi"
CAPSULE_LOADER="$EDK2_DIR/Build/AntiTheftCapsule/RELEASE_GCC/X64/CapsuleLoader.efi"

echo "  Payload: $PAYLOAD ($(stat -c%s $PAYLOAD) bytes)"
echo "  Loader:  $CAPSULE_LOADER ($(stat -c%s $CAPSULE_LOADER) bytes)"
echo ""

# Step 2: Generate signing keys (if not already present)
echo "[2/6] Generating capsule signing keys..."
mkdir -p $CAPSULE_OUTPUT
cd $CAPSULE_OUTPUT

if [ ! -f capsule_signer.key ]; then
    openssl req -x509 -newkey rsa:2048 -keyout capsule_signer.key \
        -out capsule_signer.crt -days 3650 -nodes \
        -subj "/CN=AntiTheft Capsule Signer/O=Remote Lockdown System" 2>&1 | grep -v "^[-+*.]"
    cat capsule_signer.key capsule_signer.crt > signer_private_cert.pem
    cp capsule_signer.crt other_public_cert.pem
    cp capsule_signer.crt trusted_public_cert.pem
    echo "  [OK] Keys generated"
else
    echo "  [OK] Keys already exist"
fi
echo ""

# Step 3: Generate capsules (signed + unsigned)
echo "[3/6] Generating capsule files..."
FMP_GUID="a1b2c3d4-e5f6-4789-abcd-ef0123456789"

# Signed capsule
GenerateCapsule -e \
    -o AntiTheft.cap \
    --guid $FMP_GUID \
    --fw-version 0x00010000 \
    --lsv 0x00000001 \
    --capflag PersistAcrossReset \
    --signer-private-cert signer_private_cert.pem \
    --other-public-cert other_public_cert.pem \
    --trusted-public-cert trusted_public_cert.pem \
    --hash-algorithm SHA256 \
    "$PAYLOAD" 2>&1 | grep -E "Success|error"

# Unsigned capsule (for testing without signature verification)
GenerateCapsule -e \
    -o AntiTheft_unsigned.cap \
    --guid $FMP_GUID \
    --fw-version 0x00010000 \
    --lsv 0x00000001 \
    --capflag PersistAcrossReset \
    "$PAYLOAD" 2>&1 | grep -E "Success|error"

echo "  Signed capsule:   $(stat -c%s AntiTheft.cap) bytes"
echo "  Unsigned capsule: $(stat -c%s AntiTheft_unsigned.cap) bytes"
echo ""

# Step 4: Create test disk
echo "[4/6] Creating FAT test disk..."
TEST_DIR="/tmp/uefi-test"
mkdir -p $TEST_DIR

# Check for tools
MKFS=$(which mkfs.fat 2>/dev/null || echo "/tmp/disk-tools/extract/usr/sbin/mkfs.fat")
SGDISK=$(which sgdisk 2>/dev/null || echo "/usr/sbin/sgdisk")
MMD=$(which mmd 2>/dev/null || echo "/tmp/disk-tools/extract/usr/bin/mmd")
MCOPY=$(which mcopy 2>/dev/null || echo "/tmp/disk-tools/extract/usr/bin/mcopy")

rm -f $TEST_DIR/capsule_boot.img $TEST_DIR/capsule_boot.img.esp
dd if=/dev/zero of=$TEST_DIR/capsule_boot.img bs=1M count=50 status=none
$SGDISK --clear --new=1:2048:0 --typecode=1:EF00 $TEST_DIR/capsule_boot.img 2>&1 | grep -v "^Warning"
$MKFS -F 32 -n "ESP" -C $TEST_DIR/capsule_boot.img.esp 50176 2>&1
$MMD -i $TEST_DIR/capsule_boot.img.esp ::/EFI
$MMD -i $TEST_DIR/capsule_boot.img.esp ::/EFI/BOOT
$MCOPY -o -i $TEST_DIR/capsule_boot.img.esp $CAPSULE_LOADER ::/EFI/BOOT/BOOTX64.EFI
$MCOPY -o -i $TEST_DIR/capsule_boot.img.esp $CAPSULE_OUTPUT/AntiTheft.cap ::/AntiTheft.cap
dd if=$TEST_DIR/capsule_boot.img.esp of=$TEST_DIR/capsule_boot.img bs=512 seek=2048 conv=notrunc status=none
echo "  [OK] Test disk created"
echo ""

# Step 5: Boot QEMU
echo "[5/6] Booting QEMU with capsule test..."
OVMF_DIR="$EDK2_DIR/Build/OvmfX64/RELEASE_GCC/FV"
cp $OVMF_DIR/OVMF_VARS.fd $TEST_DIR/OVMF_VARS_capsule.fd

QEMU=$(which qemu-system-x86_64 2>/dev/null || echo "/tmp/qemu-pkgs/extract/usr/bin/qemu-system-x86_64")
export LD_LIBRARY_PATH="/tmp/libs-pkgs/extract/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"

timeout 45 $QEMU \
    -L $TEST_DIR/pc-bios \
    -drive if=pflash,format=raw,readonly=on,file=$OVMF_DIR/OVMF_CODE.fd \
    -drive if=pflash,format=raw,file=$TEST_DIR/OVMF_VARS_capsule.fd \
    -drive format=raw,file=$TEST_DIR/capsule_boot.img \
    -nographic -serial mon:stdio -display none -m 256M -nic none \
    2>&1 | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' | tee $TEST_DIR/capsule-test-output.log

echo ""

# Step 6: Verify results
echo "[6/6] Verifying test results..."
if grep -q "Capsule Update Test Complete" $TEST_DIR/capsule-test-output.log && \
   grep -q "AgentInstalled = 1" $TEST_DIR/capsule-test-output.log && \
   grep -q "AgentVersion = 0x0100" $TEST_DIR/capsule-test-output.log; then
    echo "  [PASS] Capsule update test PASSED"
    echo "  - Capsule format validated"
    echo "  - Payload extracted and loaded"
    echo "  - DXE driver executed"
    echo "  - NVRAM variables set"
    exit 0
else
    echo "  [FAIL] Capsule update test FAILED"
    echo "  Check $TEST_DIR/capsule-test-output.log for details"
    exit 1
fi
