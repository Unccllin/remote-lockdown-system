#!/bin/bash
# test-d205-harness.sh — D-205 QEMU+swtpm test harness with signed verdict.
#
# Runs the mock verdict server on the host (where Python crypto packages
# are available), and boots PblApp.efi in QEMU inside Docker with --network
# host so QEMU user networking (10.0.2.2:8080) reaches the host's server.
#
# Usage:
#   bash test-d205-harness.sh [--timeout 60]
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="60"
if [[ "$1" == "--timeout" ]]; then TIMEOUT="$2"; fi

FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="/tmp/pbl-d205-ci"

mkdir -p "${BUILD_DIR}"

# === Generate keys and policy ===
echo "=== Generating D-205 test keys and policy ==="
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" --generate-keys 2>&1 | tail -5
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" --generate-policy "${BUILD_DIR}/policy.cose" 2>&1 | tail -5

# === Start mock verdict server on the host ===
echo ""
echo "=== Starting mock verdict server on host (port 8080) ==="
# Kill any existing server on port 8080
fuser -k 8080/tcp 2>/dev/null || true
sleep 1
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" --serve --port 8080 &
SERVER_PID=$!
sleep 2
echo "  Mock server PID: ${SERVER_PID}"

# Verify server is running
if ! curl -s -o /dev/null -w "" -X POST -d "test" http://127.0.0.1:8080/v1/verdict; then
  echo "ERROR: Mock server not responding"
  kill ${SERVER_PID} 2>/dev/null || true
  exit 1
fi
echo "  Mock server responding on http://127.0.0.1:8080/v1/verdict"

# === Copy files for Docker volume mount ===
cp "${FIRMWARE_DIR}/PblPkg/PblApp.efi" "${BUILD_DIR}/"

# === Run QEMU in Docker ===
echo ""
echo "=== Running D-205 test in Docker (timeout ${TIMEOUT}s) ==="

docker run --rm \
  -v "${BUILD_DIR}:/test" \
  -v "${FIRMWARE_DIR}:/firmware" \
  --network host \
  -e TIMEOUT="${TIMEOUT}" \
  pbl-qemu:latest \
  bash -c '
set -eo pipefail

BUILD_DIR="/tmp/pbl-ci"
mkdir -p "${BUILD_DIR}"

# === Start swtpm ===
echo "=== Starting swtpm ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

swtpm socket --tpmstate dir="${SWTPM_DIR}" \
  --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
  --tpm2 \
  --daemon \
  --flags not-need-init \
  --pid file="${BUILD_DIR}/swtpm.pid"
swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"
echo "  swtpm started (PID $(cat "${BUILD_DIR}/swtpm.pid" 2>/dev/null || echo "?"))"

# === Create ESP disk image ===
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
mmd -i "${DISK_ESP}" ::/EFI/PBL
mcopy -i "${DISK_ESP}" "/test/PblApp.efi" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${DISK_ESP}" "/test/policy.cose" ::/EFI/PBL/policy.cose
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

# === Boot in QEMU ===
echo ""
echo "=== Booting PblApp in OVMF (timeout ${TIMEOUT}s) ==="

OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS="/usr/share/OVMF/OVMF_VARS_4M.fd"

cp "${OVMF_VARS}" "${BUILD_DIR}/OVMF_VARS_pbl.fd"

SERIAL_LOG="${BUILD_DIR}/pbl-serial.log"

python3 << PYEOF
import subprocess, time, select, os

cmd = [
    "timeout", os.environ.get("TIMEOUT", "60"),
    "qemu-system-x86_64",
    "-drive", "if=pflash,format=raw,readonly=on,file=${OVMF_CODE}",
    "-drive", "if=pflash,format=raw,file=${BUILD_DIR}/OVMF_VARS_pbl.fd",
    "-drive", "format=raw,file=${DISK_IMG}",
    "-nographic",
    "-m", "256M",
    "-cpu", "qemu64,+rdrand",
    "-device", "e1000,netdev=net0,romfile=efi-e1000.rom",
    "-netdev", "user,id=net0",
    "-object", "rng-random,id=rng0,filename=/dev/urandom",
    "-device", "virtio-rng-pci,rng=rng0",
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
timeout_s = float(os.environ.get("TIMEOUT", "60"))

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

    if elapsed > timeout_s:
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

with open("${SERIAL_LOG}", "wb") as f:
    f.write(output)

print(f"  QEMU exited with code {proc.returncode}")
print(f"  Serial log: {len(output)} bytes")
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
check "Policy parse step" "\[2/8\] Parsing policy blob"
check "Policy parsed" "policy.cose: [0-9]+ bytes"
check "Verdict fetch step" "\[4/8\] Fetching verdict"
check "Verdict response received" "Verdict response: [0-9]+ bytes"
check "Verdict decoded" "Verdict decoded: verdict=[0-9]+"
check "Signature verified" "Verdict signature verified \(ES256\)"
check "Decision step" "\[6/8\] Evaluating decision"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

# === Show relevant serial output ===
echo ""
echo "=== Relevant serial output ==="
grep -E "policy.cose|Verdict|signature|ES256|Decision|BLOCK|ALLOW|DEGRADED|cert|WARN|OK" "${SERIAL_LOG}" || true

# === Cleanup ===
if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
    kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== Serial log (last 80 lines) ==="
  tail -80 "${SERIAL_LOG}"
  exit 1
fi

exit 0
'

# === Cleanup mock server ===
kill ${SERVER_PID} 2>/dev/null || true
