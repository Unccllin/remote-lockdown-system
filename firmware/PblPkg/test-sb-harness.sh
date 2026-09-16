#!/bin/bash
# test-sb-harness.sh — D-217 prevention proof: Secure Boot rejects a
# tampered PblApp.efi in OVMF emulation.
#
# Requires an OVMF built with -D SECURE_BOOT_ENABLE=TRUE (see build-pbl.sh
# history / AGENTS notes). Uses virt-fw-vars (virt-firmware) on the host to
# build a vars store: generated PK, and PblApp.efi's *authenticode* hash
# enrolled in db. Three scenarios:
#
#   1. allowed        — SB vars + unmodified PblApp.efi → banner PRESENT
#   2. tampered-sb    — SB vars + 1-byte-tampered PblApp.efi → banner ABSENT
#                       (DxeImageVerificationLib rejects: hash not in db)
#   3. tampered-nosb  — plain vars (SetupMode) + tampered efi → banner PRESENT
#                       (control: the tampered binary itself still runs)
#
# The tamper appends one byte past the last section — overlay bytes are
# covered by the authenticode hash but never mapped by the loader, so the
# image still executes; only the authenticode hash changes.
#
# Usage:
#   bash test-sb-harness.sh [--timeout 30]
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="30"
if [[ "$1" == "--timeout" ]]; then TIMEOUT="$2"; fi

FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="/tmp/pbl-sb-ci"
OVMF_DIR="/home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV"
PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
VIRT_SITE="/home/cllin/.local/lib/python3.14/site-packages"

mkdir -p "${BUILD_DIR}"

if [ ! -f "${PBL_APP}" ]; then
  echo "ERROR: PblApp.efi not found — run build-pbl.sh first" >&2
  exit 1
fi
if [ ! -f "${OVMF_DIR}/OVMF_CODE.fd" ]; then
  echo "ERROR: OVMF_CODE.fd not found in ${OVMF_DIR}" >&2
  exit 1
fi

# === 1. Compute authenticode hash + create tampered copy + SB vars ===
echo "=== Preparing Secure Boot test assets ==="

AUTH_HASH=$(python3 - "$PBL_APP" <<PYEOF
import sys
sys.path.insert(0, "${VIRT_SITE}")
import pefile
from virt.peutils.pesign import pe_authenticode_hash
pe = pefile.PE("$PBL_APP")
print(pe_authenticode_hash(pe, "sha256").hex())
PYEOF
)
echo "  PblApp.efi authenticode SHA-256: ${AUTH_HASH}"

python3 - "$PBL_APP" "${BUILD_DIR}/PblApp-tampered.efi" <<'PYEOF'
import sys
# Append one byte past the last section. Overlay bytes are included in the
# authenticode hash but never mapped by the loader — the image still runs,
# only the hash changes. (Flipping a byte inside .reloc corrupts the
# relocation table the loader applies, which fails with Unsupported even
# without Secure Boot — not a clean control.)
data = bytearray(open(sys.argv[1], 'rb').read())
data += b'\xAA'
open(sys.argv[2], 'wb').write(data)
PYEOF
echo "  Tampered copy: ${BUILD_DIR}/PblApp-tampered.efi (1 byte appended)"

virt-fw-vars -i "${OVMF_DIR}/OVMF_VARS.fd" \
  -o "${BUILD_DIR}/OVMF_VARS-sb.fd" \
  --enroll-generate PBL-Test --no-microsoft \
  --add-db-hash 4aaff29d-68df-49ee-8aa9-347d3759a7d7 "${AUTH_HASH}" \
  --sb 2>&1 | grep -E "add db hash|SecureBootEnable|writing raw" || true
echo "  SB vars: ${BUILD_DIR}/OVMF_VARS-sb.fd"
cp "${OVMF_DIR}/OVMF_VARS.fd" "${BUILD_DIR}/OVMF_VARS-plain.fd"
cp "${PBL_APP}" "${BUILD_DIR}/PblApp.efi"

# === 2. Run the 3 boot scenarios in Docker ===
echo ""
echo "=== Running Secure Boot scenarios in Docker (timeout ${TIMEOUT}s each) ==="

docker run --rm \
  -v "${BUILD_DIR}:/test" \
  -v "${OVMF_DIR}:/ovmf:ro" \
  -e TIMEOUT="${TIMEOUT}" \
  pbl-qemu:latest \
  bash -c '
set -eo pipefail

BUILD_DIR="/tmp/pbl-sb"
mkdir -p "${BUILD_DIR}"

OVMF_CODE="/ovmf/OVMF_CODE.fd"

boot_scenario() {
  local name="$1"      # scenario label
  local efi="$2"       # which PblApp binary
  local vars="$3"      # which OVMF VARS file
  local log="${BUILD_DIR}/pbl-serial-${name}.log"

  local esp="${BUILD_DIR}/esp-${name}.img"
  local disk="${BUILD_DIR}/disk-${name}.img"
  rm -f "${esp}" "${disk}"

  dd if=/dev/zero of="${disk}" bs=1M count=50 status=none
  sgdisk --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:"ESP" \
    "${disk}" 2>&1 | grep -v "^Warning" || true
  mkfs.fat -F 32 -n "ESP" -C "${esp}" 50176 >/dev/null 2>&1
  mmd -i "${esp}" ::/EFI
  mmd -i "${esp}" ::/EFI/BOOT
  mcopy -i "${esp}" "/test/${efi}" ::/EFI/BOOT/BOOTX64.EFI
  dd if="${esp}" of="${disk}" bs=512 seek=2048 conv=notrunc status=none

  cp "/test/${vars}" "${BUILD_DIR}/OVMF_VARS_${name}.fd"

  python3 - "$name" "$log" "$disk" "$OVMF_CODE" "${BUILD_DIR}/OVMF_VARS_${name}.fd" "$TIMEOUT" << "PYEOF"
import subprocess, time, select, os, sys

name, log, disk, ovmf_code, ovmf_vars, timeout_s = sys.argv[1:7]

cmd = [
    "timeout", timeout_s,
    "qemu-system-x86_64",
    "-drive", f"if=pflash,format=raw,readonly=on,file={ovmf_code}",
    "-drive", f"if=pflash,format=raw,file={ovmf_vars}",
    "-drive", f"format=raw,file={disk}",
    "-nographic",
    "-m", "256M",
]

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        stdin=subprocess.PIPE)
output = b""
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
    if time.time() - start > float(timeout_s):
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

with open(log, "wb") as f:
    f.write(output)
print(f"  [{name}] QEMU exited {proc.returncode}, log {len(output)} bytes")
PYEOF
}

echo ""
echo "=== Boot 1: ALLOWED (SB vars, enrolled hash) ==="
boot_scenario allowed PblApp.efi OVMF_VARS-sb.fd
echo "=== Boot 2: TAMPERED under Secure Boot ==="
boot_scenario tampered-sb PblApp-tampered.efi OVMF_VARS-sb.fd
echo "=== Boot 3: TAMPERED without Secure Boot (control) ==="
boot_scenario tampered-nosb PblApp-tampered.efi OVMF_VARS-plain.fd

# === Check results ===
echo ""
echo "=== Checking serial output ==="

PASS=0
FAIL=0

check() {
  local label="$1"; local pattern="$2"; local log="$3"
  if grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"; FAIL=$((FAIL + 1))
  fi
}

check_absent() {
  local label="$1"; local pattern="$2"; local log="$3"
  if ! grep -qE "${pattern}" "${log}"; then
    echo "  [PASS] ${label}"; PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"; FAIL=$((FAIL + 1))
  fi
}

L_ALLOWED="${BUILD_DIR}/pbl-serial-allowed.log"
L_TAMP_SB="${BUILD_DIR}/pbl-serial-tampered-sb.log"
L_TAMP_NO="${BUILD_DIR}/pbl-serial-tampered-nosb.log"

check "allowed: PBL banner"            "PBL — Pre-Boot Lock"          "${L_ALLOWED}"
check "allowed: reaches decision"      "\[8/8\] Decision:"            "${L_ALLOWED}"
check "allowed: self-image measured"   "Self-image SHA-256: [0-9A-Fa-f]{64}" "${L_ALLOWED}"

check_absent "tampered-sb: NO banner"  "PBL — Pre-Boot Lock"          "${L_TAMP_SB}"
check_absent "tampered-sb: NO decision" "\[8/8\] Decision:"           "${L_TAMP_SB}"
check_absent "tampered-sb: NO lock screen" "THIS DEVICE IS LOCKED"    "${L_TAMP_SB}"

check "control: tampered binary still boots w/o SB" "PBL — Pre-Boot Lock" "${L_TAMP_NO}"
check "control: reaches decision"    "\[8/8\] Decision:"              "${L_TAMP_NO}"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="

cp "${BUILD_DIR}"/pbl-serial-*.log /test/ 2>/dev/null || true

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== tampered-sb serial (last 30 lines) ==="
  tail -30 "${L_TAMP_SB}" || true
  exit 1
fi
exit 0
'

DOCKER_RC=$?

# === Write artifact ===
cat > "${BUILD_DIR}/pbl-sb-result.txt" <<EOF
PBL D-217 Secure Boot rejection test
Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)
PblApp.efi SHA-256: $(sha256sum "${PBL_APP}" | cut -d' ' -f1)
Authenticode SHA-256 (enrolled in db): ${AUTH_HASH}
Scenarios: allowed (enrolled hash boots), tampered-sb (rejected), tampered-nosb (control boots)
Docker harness exit: ${DOCKER_RC}
EOF
echo "Artifact written: ${BUILD_DIR}/pbl-sb-result.txt"

exit ${DOCKER_RC}
