#!/bin/bash
# ci-harness-docker.sh — QEMU + swtpm CI harness for PblApp (Docker version).
#
# Boots PblApp.efi in OVMF (QEMU) with a swtpm TPM 2.0 simulator.
# Designed to run inside the pbl-qemu Docker image.
#
# Usage (from host) — custom OVMF (null platform-hierarchy lib, required for
# PcdPblTpmUsePlatformHierarchy=TRUE):
#   docker run --rm \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
#     pbl-qemu /firmware/PblPkg/ci-harness-docker.sh
#
# Usage (from host) — stock Ubuntu OVMF (dev fallback, may fail with platform
# hierarchy unless PcdPblTpmUsePlatformHierarchy=FALSE):
#   docker run --rm -v $(pwd)/firmware:/firmware:ro pbl-qemu \
#     /firmware/PblPkg/ci-harness-docker.sh
#
# Usage (inside container):
#   ./ci-harness-docker.sh [--timeout 30]
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-30}"
FIRMWARE_DIR="${FIRMWARE_DIR:-/firmware}"
BUILD_DIR="/tmp/pbl-ci"

# OVMF paths: prefer the PBL custom build (which uses PeiDxeTpmPlatformHierarchyLibNull
# and leaves platformAuth empty, so PBL can use TPM_RH_PLATFORM). Fall back to the
# Ubuntu 4M split OVMF for environments that do not mount /ovmf.
#
# The pbl-qemu Docker image sets OVMF_CODE/OVMF_VARS to the Ubuntu package
# paths, so the script must override them when /ovmf is mounted.
if [ -f "/ovmf/OVMF_CODE.fd" ] && [ -f "/ovmf/OVMF_VARS.fd" ]; then
  OVMF_CODE="/ovmf/OVMF_CODE.fd"
  OVMF_VARS_SRC="/ovmf/OVMF_VARS.fd"
else
  OVMF_CODE="${OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS_SRC="${OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
fi

mkdir -p "${BUILD_DIR}"

# === Check prerequisites ===
PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
if [ ! -f "${PBL_APP}" ]; then
  echo "ERROR: PblApp.efi not found at ${PBL_APP}"
  exit 1
fi

if [ ! -f "${OVMF_CODE}" ]; then
  echo "ERROR: OVMF_CODE not found at ${OVMF_CODE}"
  exit 1
fi

# === Start swtpm (TPM 2.0 simulator) ===
# swtpm is optional. Set USE_SWTPM=1 to enable.
#
# KEY FIX for D-101: Start swtpm with ONLY the --ctrl (control) socket,
# NOT the --server (data) socket. QEMU's TPM emulator backend sends
# CMD_SET_DATAFD to pass a file descriptor for the data channel via
# SCM_RIGHTS. If swtpm already has a --server socket, the data fd is
# already set and CMD_SET_DATAFD fails with TPM_RC_BAD_PARAMETER (0x1F).
# By omitting --server, QEMU can establish the data channel itself.
echo "=== Starting swtpm (TPM 2.0 simulator) ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

SWTPM_ARGS=""
if [ "${USE_SWTPM:-1}" = "1" ] && command -v swtpm >/dev/null 2>&1; then
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
  echo "  [INFO] swtpm disabled (set USE_SWTPM=1 to enable) — running without TPM"
fi

# === Create disk image with PblApp.efi on ESP ===
echo "=== Creating ESP disk image ==="
DISK_IMG="${BUILD_DIR}/pbl_disk.img"
DISK_ESP="${BUILD_DIR}/pbl_esp.img"

rm -f "${DISK_IMG}" "${DISK_ESP}"

dd if=/dev/zero of="${DISK_IMG}" bs=1M count=50 status=none
sgdisk --clear \
  --new=1:2048:0 \
  --typecode=1:EF00 \
  --change-name=1:"ESP" \
  "${DISK_IMG}" 2>&1 | grep -v "^Warning" || true

mkfs.fat -F 32 -n "ESP" -C "${DISK_ESP}" 50176 2>&1
mmd -i "${DISK_ESP}" ::/EFI
mmd -i "${DISK_ESP}" ::/EFI/BOOT
mcopy -i "${DISK_ESP}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

# === Boot in QEMU ===
echo ""
echo "=== Booting PblApp in OVMF (timeout ${TIMEOUT}s) ==="

# Fresh OVMF_VARS for each run
cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/OVMF_VARS_pbl.fd"

SERIAL_LOG="${BUILD_DIR}/pbl-serial.log"

# Use Python to capture QEMU output via subprocess.PIPE.
#
# QEMU's -serial stdio requires a TTY (TCGETS ioctl fails with ENOTTY
# when stdout is redirected to a file/pipe in a non-interactive Docker
# environment). Using -nographic with subprocess.PIPE works because
# Python's pipe doesn't require a TTY and QEMU routes serial to stdout.
python3 << PYEOF
import subprocess, time, select, os

cmd = [
    "timeout", "${TIMEOUT}",
    "qemu-system-x86_64",
    "-drive", "if=pflash,format=raw,readonly=on,file=${OVMF_CODE}",
    "-drive", "if=pflash,format=raw,file=${BUILD_DIR}/OVMF_VARS_pbl.fd",
    "-drive", "format=raw,file=${DISK_IMG}",
    "-nographic",
    "-m", "256M",
]

swtpm_args = "${SWTPM_ARGS}".split()
if swtpm_args:
    cmd.extend(swtpm_args)

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    stdin=subprocess.PIPE,
)

output = b""
input_sent = False
start = time.time()

while True:
    if proc.poll() is not None:
        # Read remaining output
        remaining = proc.stdout.read()
        if remaining:
            output += remaining
        break

    # Check for output
    try:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            data = os.read(proc.stdout.fileno(), 4096)
            if data:
                output += data
    except OSError:
        break

    # Send override input after 8 seconds to unblock the lock screen.
    # The PBL app blocks at "Enter the override response code:" waiting for input.
    # Sending "test\n" provides a non-empty response, which grants the override.
    # PblChainLoadWindows then fails (no Windows), and "scaffold complete" prints.
    elapsed = time.time() - start
    if not input_sent and elapsed > 8 and b"override response code" in output:
        try:
            proc.stdin.write(b"test\n")
            proc.stdin.flush()
            input_sent = True
        except BrokenPipeError:
            input_sent = True

    # Stop after timeout
    if elapsed > ${TIMEOUT}:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        break

# Read any final output
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

with open("${SERIAL_LOG}", "wb") as f:
    f.write(output)

print(f"  QEMU exited with code {proc.returncode}")
print(f"  Serial log: {len(output)} bytes")
print(f"  Override input sent: {input_sent}")
PYEOF

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
check "Self-image measured (D-217)" "PCR 13 \(self-image\) extended"
check "Lock screen displayed" "THIS DEVICE IS LOCKED"

# D-217: The self-image hash printed in the serial log must equal the
# SHA-256 of the PblApp.efi that was copied to the ESP — proves the
# on-disk PE measurement is deterministic (unlike reverted D-212).
LOGGED_HASH=$(grep -oE "Self-image SHA-256: [0-9A-Fa-f]{64}" "${SERIAL_LOG}" | awk '{print $3}' | tr 'A-F' 'a-f' || true)
FILE_HASH=$(sha256sum "${PBL_APP}" | awk '{print $1}')
if [ -n "${LOGGED_HASH}" ] && [ "${LOGGED_HASH}" = "${FILE_HASH}" ]; then
  echo "  [PASS] Self-image hash matches PblApp.efi (${FILE_HASH:0:16}...)"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] Self-image hash mismatch (logged=${LOGGED_HASH:-none} file=${FILE_HASH})"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

# === Cleanup swtpm ===
if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
  kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== Serial log (last 50 lines) ==="
  tail -50 "${SERIAL_LOG}"
  exit 1
fi

exit 0
