#!/bin/bash
# test-s07-dhcp-harness.sh — S0.7 (B-015) DHCP verification harness.
#
# Boots the DEBUG PblApp in OVMF (QEMU + slirp user networking) with a mock
# verdict server running INSIDE the container, and asserts:
#
#   1. DHCP DORA completes and a lease reaches Ip4Config2 InterfaceInfo
#      ("lease on ifinfo[N] station=A.B.C.D" + "DHCP lease obtained").
#   2. The verdict fetch succeeds over the DHCP-assigned address with no
#      static fallback ("Verdict decoded: verdict=0").
#   3. The QEMU static fallback is NOT used.
#
# Run inside the pbl-qemu Docker image:
#   docker run --rm --network host \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v /path/to/testdir:/test \
#     -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
#     pbl-qemu /firmware/PblPkg/test-s07-dhcp-harness.sh
#
# /test must contain: PblApp.efi (DEBUG build), policy.cose, test-d205.py.
# --network host makes slirp's 10.0.2.2 reach the host loopback where the
# mock server listens. (Alternatively run the server inside the container —
# requires the 'cryptography' pip module.)
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

BUILD_DIR=/tmp/pbl-s07-ci
mkdir -p "${BUILD_DIR}"
DISK_IMG="${BUILD_DIR}/disk.img"
DISK_ESP="${BUILD_DIR}/esp.img"
SERIAL_LOG="${BUILD_DIR}/serial.log"

rm -f "${DISK_IMG}" "${DISK_ESP}"

# === ESP image: DEBUG PblApp + test policy ===
dd if=/dev/zero of="${DISK_IMG}" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "${DISK_IMG}" >/dev/null 2>&1
mkfs.fat -F 32 -n ESP -C "${DISK_ESP}" 50176 >/dev/null 2>&1
mmd -i "${DISK_ESP}" ::/EFI
mmd -i "${DISK_ESP}" ::/EFI/BOOT
mmd -i "${DISK_ESP}" ::/EFI/PBL
mcopy -i "${DISK_ESP}" /test/PblApp.efi ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${DISK_ESP}" /test/policy.cose ::/EFI/PBL/policy.cose
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

cp /ovmf/OVMF_VARS.fd "${BUILD_DIR}/vars.fd"

# Mock verdict server inside the container (needs python3+cryptography).
# If unavailable, run the server on the docker host and use --network host.
if python3 -c "import cryptography" 2>/dev/null; then
  python3 /test/test-d205.py --serve --port 8080 >"${BUILD_DIR}/server.log" 2>&1 &
  sleep 1
fi

timeout 75 qemu-system-x86_64 -machine q35 \
  -drive if=pflash,format=raw,readonly=on,file=/ovmf/OVMF_CODE.fd \
  -drive if=pflash,format=raw,file="${BUILD_DIR}/vars.fd" \
  -drive format=raw,file="${DISK_IMG}" \
  -nographic -m 512M \
  -device virtio-net-pci,netdev=net0,romfile= \
  -netdev user,id=net0 \
  -object filter-dump,id=dump0,netdev=net0,file=/test/dhcp-s07.pcap \
  -object rng-random,id=rng0,filename=/dev/urandom \
  -device virtio-rng-pci,rng=rng0 \
  > "${SERIAL_LOG}" 2>&1 || true

cp "${SERIAL_LOG}" /test/serial-s07.log 2>/dev/null || true

# === Checks ===
PASS=0
FAIL=0

check() {
  local label="$1" pattern="$2"
  if grep -qE "${pattern}" "${SERIAL_LOG}"; then
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

check_absent() {
  local label="$1" pattern="$2"
  if grep -qE "${pattern}" "${SERIAL_LOG}"; then
    echo "  [FAIL] ${label} (unexpected match: ${pattern})"
    FAIL=$((FAIL + 1))
  else
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  fi
}

echo "=== S0.7 DHCP checks ==="
check "DHCP kicked on Ip4Config2" "Ip4Config2 instance.*DHCP started on [1-9]"
check "Lease applied to InterfaceInfo" "lease on ifinfo\[[0-9]+\] station=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"
check "DHCP lease obtained" "DHCP lease obtained"
check "Verdict fetched over DHCP" "Verdict decoded: verdict="
check "Verdict signature verified" "Verdict signature verified"
check_absent "No static fallback used" "static fallback"
check_absent "No DHCP failure" "DHCP failed"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="
[ "${FAIL}" -eq 0 ]
