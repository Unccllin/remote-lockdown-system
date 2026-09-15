#!/bin/bash
# test-chainload-harness.sh — QEMU PASS-verdict test with real Windows boot manager.
#
# Exercises PblApp.efi chain-load path (PblChainLoadWindows) against the real
# Windows 11 23H2 UEFI boot manager (bootx64.efi).  A mock verdict server
# returns a signed UNLOCKED verdict, and the policy contains the correct
# bootmgr_hash (C4 key 58).
#
# Usage:
#   bash test-chainload-harness.sh \
#     --bootmgr-efi tmp/winre/Win11Extract/efi/boot/bootx64.efi \
#     --bcd tmp/winre/Win11Extract/efi/microsoft/boot/bcd
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="60"
BOOTMGR_EFI=""
BCD_EFI=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --bootmgr-efi) BOOTMGR_EFI="$2"; shift 2 ;;
    --bcd) BCD_EFI="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$BOOTMGR_EFI" ]]; then
  BOOTMGR_EFI="/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/efi/boot/bootx64.efi"
fi
if [[ -z "$BCD_EFI" ]]; then
  BCD_EFI="/home/cllin/remote-lockdown-system/tmp/winre/Win11Extract/efi/microsoft/boot/bcd"
fi

if [[ ! -f "$BOOTMGR_EFI" ]]; then
  echo "ERROR: bootmgr-efi not found: $BOOTMGR_EFI"
  echo "  Extract a Windows ISO first (see docs/research/windows-11-23h2-iso-RE-findings.md)."
  exit 1
fi

FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="/tmp/pbl-chainload-ci"
mkdir -p "${BUILD_DIR}"

# BitLocker recovery GUID raw bytes that PblCollectBitLockerState searches for
BITLOCKER_GUID_HEX="f1b6c78eca611f4dbc369dff1b523b17"

# ============================================================================
# 1. Compute SHA-256 of the Windows boot manager (whole file).
# ============================================================================
echo "=== Computing bootmgr_hash ==="
BOOTMGR_HASH=$(sha256sum "$BOOTMGR_EFI" | awk '{print $1}')
echo "  File: $BOOTMGR_EFI"
echo "  Size: $(stat -c%s "$BOOTMGR_EFI") bytes"
echo "  SHA-256: $BOOTMGR_HASH"

# Save mismatch hash for later test (flip last nibble)
MISMATCH_HASH="${BOOTMGR_HASH%?}"
# Choose a hex digit guaranteed to differ by flipping to 0 if not 0, else 1
LAST="${BOOTMGR_HASH: -1}"
if [[ "$LAST" == "0" ]]; then
  NEW_LAST="1"
else
  NEW_LAST="0"
fi
MISMATCH_HASH="${MISMATCH_HASH}${NEW_LAST}"

# ============================================================================
# 2. Generate policy and start mock verdict server.
# ============================================================================
echo ""
echo "=== Generating test policy with bootmgr_hash ==="
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" \
  --generate-policy "${BUILD_DIR}/policy-pass.cose" \
  --bootmgr-hash "$BOOTMGR_HASH" 2>&1 | tail -8

echo ""
echo "=== Generating mismatch policy (for failure test) ==="
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" \
  --generate-policy "${BUILD_DIR}/policy-mismatch.cose" \
  --bootmgr-hash "$MISMATCH_HASH" 2>&1 | tail -2

echo ""
echo "=== Generating D-205 keys (if not cached) ==="
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" --generate-keys 2>&1 | tail -3 || true

echo ""
echo "=== Starting mock verdict server on host (port 8080) ==="
fuser -k 8080/tcp 2>/dev/null || true
sleep 1
python3 "${FIRMWARE_DIR}/PblPkg/test-d205.py" --serve --port 8080 &
SERVER_PID=$!
sleep 2

if ! curl -s -o /dev/null -w "" -X POST -d "test" http://127.0.0.1:8080/v1/verdict; then
  echo "ERROR: Mock server not responding"
  kill ${SERVER_PID} 2>/dev/null || true
  exit 1
fi
echo "  Mock server responding on http://127.0.0.1:8080/v1/verdict"

# ============================================================================
# 3. Prepare OVMF firmware images with a PBL-friendly variable store.
# ============================================================================
echo ""
echo "=== Preparing OVMF firmware images ==="

# Prefer the local EDK2 build (no network-boot options), fall back to system OVMF.
LOCAL_OVMF_DIR="/home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV"
if [[ -f "${LOCAL_OVMF_DIR}/OVMF_CODE.fd" ]]; then
  OVMF_CODE="${LOCAL_OVMF_DIR}/OVMF_CODE.fd"
  OVMF_VARS="${LOCAL_OVMF_DIR}/OVMF_VARS.fd"
  echo "  Using local EDK2 OVMF: ${OVMF_CODE}"
else
  OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.ms.fd"
  OVMF_VARS="/usr/share/OVMF/OVMF_VARS_4M.ms.fd"
  if [[ ! -f "${OVMF_CODE}" ]]; then
    OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
    OVMF_VARS="/usr/share/OVMF/OVMF_VARS_4M.fd"
  fi
  echo "  Using system OVMF: ${OVMF_CODE}"
fi

cp "${OVMF_CODE}" "${BUILD_DIR}/OVMF_CODE_pbl.fd"
cp "${OVMF_VARS}" "${BUILD_DIR}/OVMF_VARS_pbl.fd"

# The test-d205.py --generate-keys step above creates a root cert in /tmp.
# We add it to dbx so PblCollectDbDbxState sees an X.509-based revocation.
DBX_CERT="/tmp/pbl-d205-root-cert.der"
if [[ ! -f "${DBX_CERT}" ]]; then
  echo "WARN: ${DBX_CERT} not found; PBL may block because dbx looks empty."
fi

virt-fw-vars --inplace "${BUILD_DIR}/OVMF_VARS_pbl.fd" \
  --enroll-microsoft \
  --set-true SecureBoot \
  --set-false SetupMode \
  --set-true SecureBootEnable \
  --set-true MemoryOverwriteRequestControl \
  ${DBX_CERT:+ --add-dbx-cert d719b2cb-3d3a-4596-a3bc-dad00e67656f "${DBX_CERT}"} \
  >/dev/null 2>&1 || true

echo "  OVMF_VARS_pbl.fd prepared with SecureBoot=1, MemoryOverwrite=1, db/dbx"

# ============================================================================
# 4. Build ESP images inside Docker.
# ============================================================================
echo ""
echo "=== Preparing test artifacts ==="

# Make a BCD with the BitLocker recovery GUID so PblCollectBitLockerState
# reports BitLocker enabled.  Appending the raw GUID is enough because the
# function does a byte scan; the real BCD does NOT contain this GUID.
if [[ -f "$BCD_EFI" ]]; then
  cat "$BCD_EFI" > "${BUILD_DIR}/BCD"
else
  : > "${BUILD_DIR}/BCD"
fi
printf "%s" "$BITLOCKER_GUID_HEX" | xxd -r -p >> "${BUILD_DIR}/BCD"
echo "  BCD prepared ($(stat -c%s "${BUILD_DIR}/BCD") bytes, GUID appended)"

cp "${FIRMWARE_DIR}/PblPkg/PblApp.efi" "${BUILD_DIR}/PblApp.efi"

echo ""
echo "=== Running PASS-verdict test in Docker (timeout ${TIMEOUT}s) ==="

run_qemu_test() {
  local POLICY_NAME="$1"
  local OUT_LOG="$2"

  # OUT_LOG is written under /test (host BUILD_DIR is mounted at /test)
  local OUT_LOG_DOCKER="/test/$(basename "${OUT_LOG}")"

  docker run --rm \
    -v "${BUILD_DIR}:/test" \
    -v "${FIRMWARE_DIR}:/firmware:ro" \
    --network host \
    -e TIMEOUT="${TIMEOUT}" \
    -e POLICY_NAME="${POLICY_NAME}" \
    -e OUT_LOG="${OUT_LOG_DOCKER}" \
    pbl-qemu:latest \
    bash -c '
set -eo pipefail

BUILD_DIR="/tmp/pbl-ci"
mkdir -p "${BUILD_DIR}"

# swtpm
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
export SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"

# ESP
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
mmd -i "${DISK_ESP}" ::/EFI/Microsoft
mmd -i "${DISK_ESP}" ::/EFI/Microsoft/Boot
mcopy -i "${DISK_ESP}" /test/PblApp.efi ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${DISK_ESP}" /test/${POLICY_NAME} ::/EFI/PBL/policy.cose
mcopy -i "${DISK_ESP}" /test/bootmgfw.efi ::/EFI/Microsoft/Boot/bootmgfw.efi
mcopy -i "${DISK_ESP}" /test/BCD ::/EFI/Microsoft/Boot/BCD
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

OVMF_CODE="/test/OVMF_CODE_pbl.fd"
OVMF_VARS="/test/OVMF_VARS_pbl.fd"
export OVMF_CODE OVMF_VARS
export DISK_IMG BUILD_DIR

python3 << 'PYEOF'
import subprocess, time, select, os

cmd = [
    "timeout", os.environ.get("TIMEOUT", "60"),
    "qemu-system-x86_64",
    "-machine", "q35",
    "-global", "ICH9-LPC.disable_s3=1",
    "-global", "ICH9-LPC.disable_s4=1",
    "-drive", "if=pflash,format=raw,readonly=on,file=" + os.environ.get("OVMF_CODE"),
    "-drive", "if=pflash,format=raw,file=" + os.environ.get("OVMF_VARS"),
    "-drive", "format=raw,file=" + os.environ.get("DISK_IMG"),
    "-nographic",
    "-m", "512M",
    "-cpu", "qemu64,+rdrand",
    "-device", "virtio-net-pci,netdev=net0,romfile=",
    "-netdev", "user,id=net0",
    "-device", "intel-iommu",
    "-object", "rng-random,id=rng0,filename=/dev/urandom",
    "-device", "virtio-rng-pci,rng=rng0",
]

swtpm_extra = os.environ.get("SWTPM_ARGS", "")
if swtpm_extra:
    cmd.extend(swtpm_extra.split())

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    stdin=subprocess.PIPE,
)

output = b""
timeout_s = float(os.environ.get("TIMEOUT", "60"))
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

    if time.time() - start > timeout_s:
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

with open(os.environ.get("OUT_LOG"), "wb") as f:
    f.write(output)

print(f"  QEMU exited with code {proc.returncode}")
print(f"  Serial log: {len(output)} bytes")
PYEOF
'
}

cp "$BOOTMGR_EFI" "${BUILD_DIR}/bootmgfw.efi"

run_qemu_test "policy-pass.cose" "${BUILD_DIR}/pbl-serial-pass.log"

echo ""
echo "=== PASS-verdict output checks ==="
PASS=0
FAIL=0

check() {
  local label="$1"
  local pattern="$2"
  local log="$3"
  if grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

check "PBL banner appears" "PBL — Pre-Boot Lock" "${BUILD_DIR}/pbl-serial-pass.log"
check "Verdict signature verified" "Verdict signature verified" "${BUILD_DIR}/pbl-serial-pass.log"
check "Decision: PASS" "Decision: PASS" "${BUILD_DIR}/pbl-serial-pass.log"
check "Chain-load reached" "\[ChainLoad\]" "${BUILD_DIR}/pbl-serial-pass.log"
check "bootmgfw.efi found" "\[ChainLoad\] bootmgfw.efi: " "${BUILD_DIR}/pbl-serial-pass.log"
check "Hash verified" "bootmgfw.efi hash verified \(policy key 58\)" "${BUILD_DIR}/pbl-serial-pass.log"
check "Chain-load attempted" "(LoadImage|StartImage)" "${BUILD_DIR}/pbl-serial-pass.log"

echo ""
echo "=== PASS-verdict: relevant serial output ==="
grep -E "PBL banner|Verdict|signature|Decision|ChainLoad|bootmgfw|hash|verified|LoadImage|StartImage|WARN|OK" "${BUILD_DIR}/pbl-serial-pass.log" || true

# ============================================================================
# 4. Mismatch failure test.
# ============================================================================
echo ""
echo "=== Running mismatch hash failure test ==="
run_qemu_test "policy-mismatch.cose" "${BUILD_DIR}/pbl-serial-mismatch.log"

echo ""
echo "=== Mismatch output checks ==="
M_PASS=0
M_FAIL=0

check_m() {
  local label="$1"
  local pattern="$2"
  local log="$3"
  if grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"
    M_PASS=$((M_PASS + 1))
  else
    echo "  [FAIL] ${label}"
    M_FAIL=$((M_FAIL + 1))
  fi
}

check_m "PBL banner appears" "PBL — Pre-Boot Lock" "${BUILD_DIR}/pbl-serial-mismatch.log"
check_m "Decision: PASS (hash should fail later)" "Decision: PASS" "${BUILD_DIR}/pbl-serial-mismatch.log"
check_m "Hash mismatch detected" "\[ChainLoad\] BLOCK — bootmgfw.efi hash mismatch" "${BUILD_DIR}/pbl-serial-mismatch.log"

echo ""
echo "=== Mismatch: relevant serial output ==="
grep -E "PBL banner|Verdict|signature|Decision|ChainLoad|bootmgfw|hash|mismatch|verified|LoadImage|StartImage|WARN|OK" "${BUILD_DIR}/pbl-serial-mismatch.log" || true

# ============================================================================
# 5. Cleanup and summary.
# ============================================================================
kill ${SERVER_PID} 2>/dev/null || true

echo ""
echo "=== PASS-verdict results: ${PASS} PASS / ${FAIL} FAIL ==="
echo "=== Mismatch results: ${M_PASS} PASS / ${M_FAIL} FAIL ==="

if [[ "$FAIL" -gt 0 || "$M_FAIL" -gt 0 ]]; then
  echo ""
  echo "=== PASS log tail ==="
  tail -60 "${BUILD_DIR}/pbl-serial-pass.log" || true
  echo ""
  echo "=== Mismatch log tail ==="
  tail -60 "${BUILD_DIR}/pbl-serial-mismatch.log" || true
  exit 1
fi

echo ""
echo "=== Artifact references ==="
echo "  PASS serial log: ${BUILD_DIR}/pbl-serial-pass.log"
echo "  Mismatch serial log: ${BUILD_DIR}/pbl-serial-mismatch.log"
echo "  bootmgr_hash: $BOOTMGR_HASH"
echo "  mismatch_hash: $MISMATCH_HASH"
exit 0
