#!/bin/bash
# test-s11-bootid-harness.sh — S1.1 TPM restart-counter boot-ID harness.
#
# Boots the DEBUG PblApp in QEMU + OVMF + swtpm with a signed-verdict mock
# server, and asserts:
#
#   1. PBL reads TPM2_ReadClock and reports a non-zero reset counter
#      ("Boot-ID: reset=N" with N > 0).
#   2. The restart counter and clock-safe flag are populated.
#   3. The verdict request reaches the server carrying a boot_id field.
#
# The reset counter is the keystone boot-ID anchor: it increments on every
# cold boot (TPM reset / TPM2_Startup CLEAR) and cannot be read or rolled
# back by the OS. The server correlates the PBL boot_id with the next agent
# check-in — a check-in with no matching PBL boot is a bypass signal (S1.2).
# restartCount is retained separately as the S1.4 resume-detection signal.
#
# Run inside the pbl-qemu Docker image:
#   docker run --rm --network host \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v /path/to/testdir:/test \
#     pbl-qemu /firmware/PblPkg/test-s11-bootid-harness.sh
#
# /test must contain: PblApp.efi (DEBUG build), policy.cose, test-d205.py.
#
# SERVER TOPOLOGY (verified 2026-09-19): the pbl-qemu image has no
# 'cryptography'/'cbor2' modules, so the mock server CANNOT run in-container.
# Run it on the HOST instead, unbuffered so boot_id prints land in the log:
#   python3 -u firmware/PblPkg/test-d205.py --serve --port 8080 > /test/server.log &
# With --network host, slirp's 10.0.2.2 gateway forwards to the HOST loopback,
# so the guest reaches the host server on :8080. The host-side server.log is
# the boot_id wire evidence (the in-container server.log check below only
# fires when the image happens to have the deps).
#
# policy.cose must be a FULL policy (keys 1,2,70,71,76,77 + cert chain key 77),
# e.g. 'python3 test-d205.py --generate-policy /test/policy.cose'. The minimal
# committed firmware/policy.cose lacks the cert chain and trips the D-205
# fail-closed guard ("policy has no cert chain").
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

BUILD_DIR=/tmp/pbl-s11-ci
mkdir -p "${BUILD_DIR}"
DISK_IMG="${BUILD_DIR}/disk.img"
DISK_ESP="${BUILD_DIR}/esp.img"
SERIAL_LOG="${BUILD_DIR}/serial.log"
SWTPM_DIR="${BUILD_DIR}/swtpm-state"

rm -f "${DISK_IMG}" "${DISK_ESP}"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

# === Start swtpm ===
swtpm socket --tpmstate dir="${SWTPM_DIR}" \
  --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
  --tpm2 \
  --daemon \
  --flags not-need-init \
  --pid file="${BUILD_DIR}/swtpm.pid"
swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"

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

cp /ovmf/OVMF_VARS.fd "${BUILD_DIR}/vars.fd" 2>/dev/null || \
  cp /usr/share/OVMF/OVMF_VARS_4M.fd "${BUILD_DIR}/vars.fd"

# Mock verdict server inside the container (needs python3+cryptography).
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
  -object rng-random,id=rng0,filename=/dev/urandom \
  -device virtio-rng-pci,rng=rng0 \
  ${SWTPM_ARGS} \
  > "${SERIAL_LOG}" 2>&1 || true

cp "${SERIAL_LOG}" /test/serial-s11.log 2>/dev/null || true

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

echo "=== S1.1 boot-ID checks ==="
# BootId (resetCount) must be reported and non-zero — swtpm resetCount >= 1
# after every TPM2_Startup CLEAR (i.e., every cold boot).
check "Boot-ID line printed" "Boot-ID: reset=[0-9]+ restart=[0-9]+ safe=[01]"
check "Reset counter (boot-ID) non-zero" "Boot-ID: reset=[1-9][0-9]*"
check "Platform state collected" "Collecting platform state"
check "Verdict request reached server" "Verdict response: [0-9]+ bytes"
check "Verdict decoded" "Verdict decoded: verdict=[0-9]+"
check_absent "No TPM command failure" "ReadClock.*fail|TPM command.*fail"

# Server-side: the mock verdict server must have received a non-zero boot_id
# (key 5) in the CBOR request — the S1.1 end-to-end correlation point.
# Check the in-container log first, then the host-mounted /test/server.log
# (the host-server topology documented in the header).
SERVER_LOG=""
for cand in "${BUILD_DIR}/server.log" /test/server.log; do
  if [ -f "${cand}" ] && grep -qE "boot_id" "${cand}"; then
    SERVER_LOG="${cand}"
    break
  fi
done
# Fall back to whichever exists even if empty, so the FAIL prints a useful log.
if [ -z "${SERVER_LOG}" ]; then
  for cand in "${BUILD_DIR}/server.log" /test/server.log; do
    [ -f "${cand}" ] && SERVER_LOG="${cand}" && break
  done
fi

if [ -n "${SERVER_LOG}" ]; then
  if grep -qE "boot_id: [1-9][0-9]*" "${SERVER_LOG}"; then
    echo "  [PASS] Server received non-zero boot_id"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] Server received non-zero boot_id"
    grep -i "boot_id\|SERVER" "${SERVER_LOG}" 2>/dev/null | head -5
    FAIL=$((FAIL + 1))
  fi
else
  echo "  [SKIP] Server received non-zero boot_id (no server.log found)"
fi

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
  kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

[ "${FAIL}" -eq 0 ]
