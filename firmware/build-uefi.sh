#!/bin/bash
# build-uefi.sh — Build and test the AntiTheft UEFI firmware module in QEMU
#
# This script:
# 1. Builds OVMF firmware from source with HTTP support enabled
# 2. Builds the UEFI applications using EDK II:
#    - AntiTheftHello.efi — basic UEFI variable persistence test
#    - AntiTheftNetInit.efi — network stack loader + HTTP check-in test
# 3. Creates GPT-partitioned disk images with the EFI apps
# 4. Boots them in QEMU with the custom OVMF firmware
# 5. Verifies UEFI variable persistence across reboots
# 6. Verifies firmware-level HTTP check-in to a local server
#
# Prerequisites (all set up in this environment):
# - EDK II at ~/.local/src/edk2
# - NASM at ~/.local/bin/nasm
# - QEMU at /tmp/qemu-extract/usr/bin/qemu-system-x86_64
# - mtools, dosfstools, gdisk extracted to /tmp/
# - iasl (ACPI compiler) at /tmp/iasl-extract/usr/bin/iasl

set -eo pipefail

# === Paths ===
EDK2_DIR="/home/cllin/.local/src/edk2"
FIRMWARE_DIR="/home/cllin/remote-lockdown-system/firmware"
BUILD_DIR="/tmp/uefi-test"
QEMU="/tmp/qemu-extract/usr/bin/qemu-system-x86_64"
MKFS="/tmp/dosfstools-extract/usr/sbin/mkfs.fat"
MMD="/tmp/mtools-extract/usr/bin/mmd"
MCOPY="/tmp/mtools-extract/usr/bin/mcopy"
MDIR="/tmp/mtools-extract/usr/bin/mdir"
SGDISK="/tmp/gdisk-extract/usr/sbin/sgdisk"

export PATH="/home/cllin/.local/bin:/tmp/iasl-extract/usr/bin:${EDK2_DIR}/BaseTools/BinWrappers/PosixLike:${PATH}"
export C_INCLUDE_PATH="/tmp/libs-extract/usr/include:${C_INCLUDE_PATH:-}"
export LD_LIBRARY_PATH="/tmp/libs-extract/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export EDK_TOOLS_PATH="${EDK2_DIR}/BaseTools"
export WORKSPACE="${EDK2_DIR}"
export PACKAGES_PATH="${EDK2_DIR}:${FIRMWARE_DIR}"
export MTOOLS_SKIP_CHECK=1
export PYTHON_COMMAND=python3

mkdir -p "${BUILD_DIR}"

# === Step 0: Build OVMF with HTTP support ===
echo "=== Building OVMF with HTTP support ==="
cd "${EDK2_DIR}"
source edksetup.sh

OVMF_DIR="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV"
if [ ! -f "${OVMF_DIR}/OVMF_CODE.fd" ]; then
    build -p OvmfPkg/OvmfPkgX64.dsc -a X64 -t GCC -b RELEASE \
        -D NETWORK_HTTP_ENABLE=TRUE \
        -D NETWORK_HTTP_BOOT_ENABLE=FALSE \
        -D NETWORK_TLS_ENABLE=FALSE \
        -D NETWORK_ALLOW_HTTP_CONNECTIONS=TRUE \
        -D NETWORK_IP6_ENABLE=FALSE
else
    echo "OVMF already built — skipping (remove ${OVMF_DIR} to rebuild)"
fi

# === Step 1: Build the UEFI applications ===
echo ""
echo "=== Building AntiTheftHello.efi (variable persistence test) ==="
build -p AntiTheftHello.dsc -a X64 -t GCC -b RELEASE
HELLO_APP="${EDK2_DIR}/Build/AntiTheftHello/RELEASE_GCC/X64/AntiTheftHello.efi"
echo "Built: ${HELLO_APP} ($(stat -c%s "${HELLO_APP}") bytes)"

echo ""
echo "=== Building AntiTheftNetInit.efi (HTTP check-in test) ==="
build -p AntiTheftNetInit.dsc -a X64 -t GCC -b RELEASE
NETINIT_APP="${EDK2_DIR}/Build/AntiTheftNetInit/RELEASE_GCC/X64/AntiTheftNetInit.efi"
echo "Built: ${NETINIT_APP} ($(stat -c%s "${NETINIT_APP}") bytes)"

# === Helper: Create a disk image with an EFI app ===
create_disk_image() {
    local app_path="$1"
    local disk_img="$2"

    rm -f "${disk_img}" "${disk_img}.esp"
    dd if=/dev/zero of="${disk_img}" bs=1M count=50 status=none
    "${SGDISK}" --clear \
        --new=1:2048:0 \
        --typecode=1:EF00 \
        --change-name=1:"ESP" \
        "${disk_img}" 2>&1 | grep -v "^Warning"
    "${MKFS}" -F 32 -n "ESP" -C "${disk_img}.esp" 50176 2>&1
    "${MMD}" -i "${disk_img}.esp" ::/EFI
    "${MMD}" -i "${disk_img}.esp" ::/EFI/BOOT
    "${MCOPY}" -i "${disk_img}.esp" "${app_path}" ::/EFI/BOOT/BOOTX64.EFI
    dd if="${disk_img}.esp" of="${disk_img}" bs=512 seek=2048 conv=notrunc status=none
}

# === Step 2: Test UEFI variable persistence ===
echo ""
echo "=== Test 1: UEFI Variable Persistence ==="
create_disk_image "${HELLO_APP}" "${BUILD_DIR}/hello_disk.img"

# Fresh OVMF_VARS for first boot
cp "${OVMF_DIR}/OVMF_VARS.fd" "${BUILD_DIR}/OVMF_VARS_hello.fd"

echo "--- First boot (creates UEFI variable) ---"
timeout 20 "${QEMU}" \
    -L "${BUILD_DIR}/pc-bios" \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_DIR}/OVMF_CODE.fd" \
    -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS_hello.fd" \
    -drive format=raw,file="${BUILD_DIR}/hello_disk.img" \
    -nographic \
    -serial mon:stdio \
    -display none \
    -m 256M \
    -nic none \
    2>&1 | grep -E "Anti-Theft|AgentState|OK|INFO|ERROR|Firmware|UEFI|POC" || true

echo ""
echo "--- Second boot (verifying variable persisted) ---"
timeout 20 "${QEMU}" \
    -L "${BUILD_DIR}/pc-bios" \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_DIR}/OVMF_CODE.fd" \
    -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS_hello.fd" \
    -drive format=raw,file="${BUILD_DIR}/hello_disk.img" \
    -nographic \
    -serial mon:stdio \
    -display none \
    -m 256M \
    -nic none \
    2>&1 | grep -E "Anti-Theft|AgentState|OK|INFO|ERROR|Firmware|UEFI|POC|NON_VOLATILE|BOOTSERVICE|RUNTIME" || true

# === Step 3: Test firmware-level HTTP check-in ===
echo ""
echo "=== Test 2: Firmware-Level HTTP Check-In ==="
create_disk_image "${NETINIT_APP}" "${BUILD_DIR}/netinit_disk.img"

# Start a simple HTTP server for the check-in test
echo "Starting HTTP check-in server on port 8080..."
python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'status':'ok','message':'firmware check-in received'}).encode())
    def log_message(self,*a): pass
http.server.HTTPServer(('0.0.0.0',8080),H).serve_forever()
" &
HTTP_PID=$!
sleep 1

# Verify server is up
curl -s http://localhost:8080/checkin && echo ""

# Fresh OVMF_VARS
cp "${OVMF_DIR}/OVMF_VARS.fd" "${BUILD_DIR}/OVMF_VARS_netinit.fd"

echo ""
echo "--- Booting with network (HTTP check-in test) ---"
# Key QEMU flags for UEFI HTTP:
#   -device e1000 — NIC with UNDI option ROM (provides SimpleNetwork)
#   -device virtio-rng-pci — provides EFI_RNG_PROTOCOL (required by TcpDxe/Udp4Dxe)
#   -netdev user — QEMU user-mode networking (10.0.2.2 = host)
timeout 120 "${QEMU}" \
    -L "${BUILD_DIR}/pc-bios" \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_DIR}/OVMF_CODE.fd" \
    -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS_netinit.fd" \
    -drive format=raw,file="${BUILD_DIR}/netinit_disk.img" \
    -nographic \
    -serial mon:stdio \
    -display none \
    -m 256M \
    -device e1000,netdev=net0,romfile=efi-e1000.rom \
    -netdev user,id=net0 \
    -object rng-random,id=rng0,filename=/dev/urandom \
    -device virtio-rng-pci,rng=rng0 \
    2>&1 | grep -E "Anti-Theft|HTTP|FAIL|OK|FOUND|Loading|Configure|Request|Response|Body|check-in|Network|DHCP" || true

# Clean up HTTP server
kill ${HTTP_PID} 2>/dev/null || true

echo ""
echo "=== Done ==="
echo ""
echo "Summary:"
echo "  - AntiTheftHello.efi: UEFI variable persistence (NON_VOLATILE across reboots)"
echo "  - AntiTheftNetInit.efi: Firmware-level HTTP check-in (loads network stack from FV, DHCP, HTTP GET)"
echo ""
echo "Key findings:"
echo "  - OVMF must be built with NETWORK_HTTP_ENABLE=TRUE for EFI_HTTP_PROTOCOL"
echo "  - The DXE dispatcher does NOT auto-load network drivers in OVMF; they must be"
echo "    manually loaded from the FV using EFI_FIRMWARE_VOLUME2_PROTOCOL->ReadSection"
echo "  - TcpDxe and Udp4Dxe require EFI_RNG_PROTOCOL (via virtio-rng-pci + VirtioRngDxe)"
echo "  - Ip4Config2 must be set to DHCP policy before HTTP requests can succeed"
echo "  - QEMU user networking: 10.0.2.2 is the host address"
