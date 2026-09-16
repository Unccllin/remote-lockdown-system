#!/bin/bash
# ci-harness-persistence.sh — QEMU + swtpm two-boot persistence test for PBL.
#
# Verifies that the lock state written to TPM NV by the first PBL boot is
# read back by the second PBL boot and survives a full QEMU/OVMF reboot.
#
# Usage (from host) — custom OVMF (null platform-hierarchy lib, required for
# PcdPblTpmUsePlatformHierarchy=TRUE):
#   docker run --rm \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
#     pbl-qemu /firmware/PblPkg/ci-harness-persistence.sh
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-45}"
FIRMWARE_DIR="${FIRMWARE_DIR:-/firmware}"
BUILD_DIR="/tmp/pbl-ci-persist"

# OVMF paths: prefer the PBL custom build (which uses PeiDxeTpmPlatformHierarchyLibNull
# and leaves platformAuth empty, so PBL can use TPM_RH_PLATFORM). Fall back to the
# Ubuntu 4M split OVMF for environments that do not mount /ovmf.
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

# === swtpm lifecycle (start before each boot, stop after; state persists in SWTPM_DIR) ===
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
SWTPM_SOCK="${BUILD_DIR}/swtpm-ctrl.sock"
SWTPM_PIDFILE="${BUILD_DIR}/swtpm.pid"

start_swtpm() {
  if [ -S "${SWTPM_SOCK}" ] || [ -f "${SWTPM_PIDFILE}" ]; then
    if kill -0 "$(cat "${SWTPM_PIDFILE}" 2>/dev/null || echo 0)" 2>/dev/null; then
      echo "  swtpm already running (PID $(cat "${SWTPM_PIDFILE}"))"
      return 0
    fi
  fi

  rm -f "${SWTPM_SOCK}" "${SWTPM_PIDFILE}"
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl type=unixio,path="${SWTPM_SOCK}" \
    --tpm2 \
    --daemon \
    --flags not-need-init \
    --pid file="${SWTPM_PIDFILE}"

  # Wait for the socket to appear.
  for _ in $(seq 1 20); do
    if [ -S "${SWTPM_SOCK}" ]; then
      break
    fi
    sleep 0.1
  done

  swtpm_ioctl --unix "${SWTPM_SOCK}" -i 2>/dev/null || true
  echo "  swtpm started (PID $(cat "${SWTPM_PIDFILE}" 2>/dev/null || echo '?'))"
}

stop_swtpm() {
  if [ -f "${SWTPM_PIDFILE}" ]; then
    local pid
    pid="$(cat "${SWTPM_PIDFILE}" 2>/dev/null || echo 0)"
    if kill -0 "${pid}" 2>/dev/null; then
      echo "  Stopping swtpm (PID ${pid})"
      kill -TERM "${pid}" 2>/dev/null || true
      for _ in $(seq 1 20); do
        if ! kill -0 "${pid}" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
    fi
  fi
  rm -f "${SWTPM_SOCK}" "${SWTPM_PIDFILE}"
}

echo "=== Setting up swtpm (TPM 2.0 simulator) ==="
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"

if [ "${USE_SWTPM:-1}" = "1" ] && command -v swtpm >/dev/null 2>&1; then
  SWTPM_ARGS="-chardev socket,id=chrtpm,path=${SWTPM_SOCK} -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"
  start_swtpm
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

# === Boot 1: provision NV and write the initial lock state cache ===
echo ""
echo "=== Boot 1: provisioning and writing lock state (timeout ${TIMEOUT}s) ==="

cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/OVMF_VARS_pbl.fd"

SERIAL_LOG1="${BUILD_DIR}/pbl-serial-boot1.log"

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

    if elapsed > ${TIMEOUT}:
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

with open("${SERIAL_LOG1}", "wb") as f:
    f.write(output)

print(f"  QEMU boot 1 exited with code {proc.returncode}")
print(f"  Serial log 1: {len(output)} bytes")
print(f"  Override input sent: {input_sent}")
PYEOF

# Stop swtpm after boot 1 so it flushes state, then start a fresh instance
# for boot 2 that loads the same persisted state.
stop_swtpm

# === Boot 2: read the cached lock state and verify it persists ===
echo ""
echo "=== Boot 2: reading cached lock state (timeout ${TIMEOUT}s) ==="

SERIAL_LOG2="${BUILD_DIR}/pbl-serial-boot2.log"

start_swtpm

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

    if elapsed > ${TIMEOUT}:
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

with open("${SERIAL_LOG2}", "wb") as f:
    f.write(output)

print(f"  QEMU boot 2 exited with code {proc.returncode}")
print(f"  Serial log 2: {len(output)} bytes")
print(f"  Override input sent: {input_sent}")
PYEOF

# === Combine logs for checking ===
SERIAL_LOG="${BUILD_DIR}/pbl-serial.log"
cat "${SERIAL_LOG1}" "${SERIAL_LOG2}" > "${SERIAL_LOG}"

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

check_in_log() {
  local log="$1"
  local label="$2"
  local pattern="$3"
  if grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

count_check() {
  local log="$1"
  local label="$2"
  local pattern="$3"
  local expected="$4"
  local got
  got=$(grep -cE "${pattern}" "${log}" 2>/dev/null || echo 0)
  if [ "${got}" -eq "${expected}" ]; then
    echo "  [PASS] ${label} (count=${got})"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label} (expected ${expected}, got ${got})"
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
check "HMAC session established" "\[OK\] HMAC session established \(AES-256-CFB\)"
check "Lock screen displayed" "THIS DEVICE IS LOCKED"

# Persistence-specific checks:
# Boot 1 should see no cached state and then write it.
check_in_log "${SERIAL_LOG1}" "Boot 1: no cached state" "No cached lock state"
check_in_log "${SERIAL_LOG1}" "Boot 1: lock state cached" "\[OK\] Lock state cached to TPM NV"

# Boot 2 should read the cached state and write it back.
check_in_log "${SERIAL_LOG2}" "Boot 2: cached verdict used" "Using cached verdict"
check_in_log "${SERIAL_LOG2}" "Boot 2: lock state re-cached" "\[OK\] Lock state cached to TPM NV"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

# === Artifact output ===
ARTIFACT_DIR="${PBL_ARTIFACT_DIR:-${BUILD_DIR}}"
mkdir -p "${ARTIFACT_DIR}"
cat "${SERIAL_LOG1}" "${SERIAL_LOG2}" > "${ARTIFACT_DIR}/pbl-persistence-serial.log"

PBL_APP_SHA="$(sha256sum "${PBL_APP}" | cut -d' ' -f1)"
cat > "${ARTIFACT_DIR}/pbl-persistence-result.txt" <<EOF
PBL two-boot TPM NV persistence test
Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
PblApp.efi SHA-256: ${PBL_APP_SHA}
Boot 1 log: ${SERIAL_LOG1} ($(wc -c < "${SERIAL_LOG1}" 2>/dev/null || echo 0) bytes)
Boot 2 log: ${SERIAL_LOG2} ($(wc -c < "${SERIAL_LOG2}" 2>/dev/null || echo 0) bytes)
Result: ${PASS} PASS / ${FAIL} FAIL
EOF

echo "Artifact written: ${ARTIFACT_DIR}/pbl-persistence-result.txt"

# === Cleanup swtpm ===
stop_swtpm

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== Serial log boot 1 (last 40 lines) ==="
  tail -40 "${SERIAL_LOG1}" || true
  echo ""
  echo "=== Serial log boot 2 (last 40 lines) ==="
  tail -40 "${SERIAL_LOG2}" || true
  exit 1
fi

exit 0
