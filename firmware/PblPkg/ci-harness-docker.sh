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

# Timeout in seconds. Accepts `40`, `--timeout 40` and `--timeout=40`.
# See ci-harness.sh for why: the old `TIMEOUT="${1:-30}"` took the flag as the
# value, and the embedded Python then emitted `if elapsed > --timeout:` — a
# NameError that surfaced as a traceback with no hint about the argument.
TIMEOUT=30
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)   TIMEOUT="${2:-30}"; shift 2 || shift ;;
    --timeout=*) TIMEOUT="${1#*=}"; shift ;;
    [0-9]*)      TIMEOUT="$1"; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: timeout must be an integer number of seconds, got '${TIMEOUT}'" >&2
  exit 2
fi

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
# PBL_SWTPM_DIR lets a caller supply an already-provisioned TPM state directory
# (e.g. one a sidecar container wrote NV 0x01C00003 into — see the provision step
# below). When it is set the state is *reused*; when it is not, a fresh state is
# created exactly as before, so the default behaviour is unchanged.
SWTPM_DIR="${PBL_SWTPM_DIR:-${BUILD_DIR}/swtpm-state}"
if [ -z "${PBL_SWTPM_DIR:-}" ]; then
  rm -rf "${SWTPM_DIR}"
fi
mkdir -p "${SWTPM_DIR}"

# === D-131: provision PBL_AK_NAME BEFORE the QEMU-facing swtpm starts ===
#
# PBL derives device_id from the 34-byte AK Name stored at NV 0x01C00003
# (C2 §1.3). On a fresh swtpm that index has never been written, so PBL
# correctly reports "unprovisioned" and suppresses the verdict request — a
# harness that only ever runs that way can never show the enrolled path.
#
# Recipe established 2026-10-29 by probe, after several wrong turns worth
# recording so they are not repeated:
#   * the TCTI must point at swtpm's DATA port (`swtpm:host=..,port=<data>`);
#     the `path=` form is rejected by tss2 3.2 (jammy) AND tss2 5.7 (trixie)
#     with "Could not load tcti", and pointing `host/port` at the *ctrl* port
#     fails the same way;
#   * `tpm2_startup -c` is required, because swtpm runs with --flags
#     not-need-init — without it every command answers RC 0x100 INITIALIZE;
#   * attributes must be the numeric dword 0x420D000D (PBL's own platform
#     attribute set: PPWRITE|AUTHWRITE|POLICYWRITE|PPREAD|AUTHREAD|POLICYREAD|
#     NO_DA|PLATFORMCREATE). The pipe-separated names are rejected.
#
# This runs before the QEMU swtpm because the two need different transports:
# tpm2-tools needs a TCP data socket, while QEMU must own the data channel via
# CMD_SET_DATAFD (see the note above the swtpm start). The state survives the
# restart — proven by the enrolled artifact, not assumed.
AK_NAME_HEX="${PBL_AK_NAME_HEX:-000b$(printf 'ab%.0s' $(seq 1 32))}"
AK_BIN="${BUILD_DIR}/ak-name.bin"
AK_NAME_PROVISIONED=0

if [ -n "${PBL_SWTPM_DIR:-}" ] && [ -f "${SWTPM_DIR}/tpm2-00.permall" ]; then
  # A caller supplied an already-provisioned state directory.
  AK_NAME_PROVISIONED=1
  echo "  [INFO] reusing provisioned TPM state: ${SWTPM_DIR}"
elif [ "${PROVISION_AK_NAME:-1}" = "1" ] && command -v tpm2_nvdefine >/dev/null 2>&1 \
     && command -v tpm2_startup >/dev/null 2>&1; then
  PROVIDE_DATA_PORT="${PBL_PROV_DATA_PORT:-2431}"
  PROVIDE_CTRL_PORT="${PBL_PROV_CTRL_PORT:-2432}"
  PROV_PID="${BUILD_DIR}/swtpm-prov.pid"
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl "type=tcp,port=${PROVIDE_CTRL_PORT}" \
    --server "type=tcp,port=${PROVIDE_DATA_PORT}" \
    --tpm2 --daemon --flags not-need-init --pid "file=${PROV_PID}"
  for _ in $(seq 1 50); do [ -s "${PROV_PID}" ] && break; sleep 0.1; done
  sleep 1

  # python3 rather than xxd: xxd is absent from the harness image.
  python3 -c "import sys; sys.stdout.buffer.write(bytes.fromhex('${AK_NAME_HEX}'))" > "${AK_BIN}"
  export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=${PROVIDE_DATA_PORT}"
  tpm2_startup -c >/dev/null 2>&1 || true
  if tpm2_nvdefine 0x01C00003 -C o -s 34 -a 0x02060004 >/dev/null 2>&1 \
     && tpm2_nvwrite 0x01C00003 -C p -i "${AK_BIN}" >/dev/null 2>&1; then
    AK_NAME_PROVISIONED=1
    echo "  AK Name provisioned: ${AK_NAME_HEX}"
  else
    echo "  [WARN] provisioning failed — running the unprovisioned path"
  fi
  unset TPM2TOOLS_TCTI

  # Stop the provisioning instance and wait for it to release the state lock;
  # starting the QEMU swtpm while it still holds the lock fails with
  # "Could not lock access to lockfile".
  if [ -s "${PROV_PID}" ]; then
    kill "$(cat "${PROV_PID}")" 2>/dev/null || true
    for _ in $(seq 1 50); do
      kill -0 "$(cat "${PROV_PID}" 2>/dev/null)" 2>/dev/null || break
      sleep 0.1
    done
  fi
  sleep 1
else
  echo "  [INFO] tpm2-tools absent or PROVISION_AK_NAME=0 — unprovisioned path"
fi


SWTPM_ARGS=""
if [ "${USE_SWTPM:-1}" = "1" ] && command -v swtpm >/dev/null 2>&1; then
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
    --tpm2 \
    --daemon \
    --flags not-need-init \
    --pid file="${BUILD_DIR}/swtpm.pid"
  # Wait for the control socket before init — without this, ioctl races
  # the daemon startup and QEMU connects to a half-initialized TPM
  # (NV commands fail while PCR/GetRandom still work).
  for _ in $(seq 1 50); do
    [ -S "${BUILD_DIR}/swtpm-ctrl.sock" ] && break
    sleep 0.1
  done
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
# The banner proves the firmware *attempted* a fetch, not that one succeeded. PblApp
# prints "[INFO] Online fetch failed: ... falling back to cache" and carries on to the
# verify step, so a bare banner check would report PASS on a machine that never reached
# the network at all (S231).
# These two are BANNER checks and are named so. In an unenrolled image the firmware
# suppresses the verdict request ("no device_id") and skips verification of the cached
# verdict, so a PASS here must never be read as "the firmware reached a server and verified
# a verdict" (S231). The functional assertions are the suppressed/skipped ones below.
check "Verdict step banner (fetch)" "\[4/8\] Fetching verdict"
check "Verdict step banner (verify)" "\[5/8\] Verifying verdict"

# What the unenrolled image actually does, asserted explicitly instead of implied.
check "Verdict request suppressed without a device_id" "Verdict request suppressed: no device_id"
check "Verification skipped for the cached verdict" "Skipping verification for cached verdict"

# Say plainly which path ran. Without a verdict server configured the online fetch
# cannot succeed, so the cache fallback is what is actually under test here.
if grep -q "Online fetch failed" "${SERIAL_LOG}" 2>/dev/null; then
  echo "  [INFO] no verdict server reached — exercising the cache fallback path"
  check "Cache fallback taken" "falling back to cache"
else
  # Do not claim success from the absence of one string; show what the firmware said.
  echo "  [INFO] no 'Online fetch failed' line; verdict-related serial output:"
  grep -aiE "fetching verdict|online fetch|falling back|verdict" "${SERIAL_LOG}" 2>/dev/null | head -5 | sed 's/^/    /'
fi
check "Decision step" "\[6/8\] Evaluating decision"
check "PCR extend step" "\[7/8\] Extending PCR 12/13"
check "Decision action step" "\[8/8\] Decision:"
check "NV indices provisioned" "\[OK\] NV indices provisioned"
check "HMAC session established" "\[OK\] HMAC session established \(bound to lock-state NV\)"
check "Self-image measured (D-217)" "PCR 13 \(self-image\) extended"
check "Loaded image digest computed (D-213)" "Loaded images: [0-9]+ \(digest [0-9A-Fa-f]"
check "Lock screen displayed" "THIS DEVICE IS LOCKED"

# D-131: assert the branch that actually ran. Neither assertion can pass for the
# other case, so a run that silently failed to provision cannot be reported as
# if it had.
if [ "${AK_NAME_PROVISIONED}" = "1" ]; then
  # AK Name = SHA-256(alg)(2 bytes) || device_id(32 bytes), so the device_id
  # starts at hex offset 4. Asserting those four hex characters is enough to
  # prove PBL sent the provisioned bytes and not a zero id. (No lookahead
  # assertions: grep -E does not support them.)
  #
  # Upper-cased deliberately: EDK2's Print renders %x as upper-case, so PBL
  # logs `device_id from AK Name: ABABABAB...ABAB`. Matching lower-case here
  # made this check fail on correct firmware — the assertion was wrong, not
  # the code, which is exactly why it is worth pinning the expected casing.
  AK_NAME_DEVICE_PREFIX="$(printf '%s' "${AK_NAME_HEX:4:4}" | tr 'a-f' 'A-F')"
  check "device_id derived from AK Name" "device_id from AK Name: ${AK_NAME_DEVICE_PREFIX}"
else
  check "unprovisioned detected" "device is unprovisioned"
  check "verdict request suppressed" "Verdict request suppressed: no device_id"
fi

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
