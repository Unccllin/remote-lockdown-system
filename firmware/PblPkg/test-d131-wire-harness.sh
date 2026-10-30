#!/bin/bash
# test-d131-wire-harness.sh — prove on the wire that the verdict request carries
# the device_id PBL derived from the AK Name.
#
# D-131 was closed on an artifact showing `[OK] device_id from AK Name: ABAB...`
# in the serial log. That proves the derivation but not that the value is what
# gets sent: the QEMU ESP had no policy blob, so PBL logged
# "No lock_service_uri in policy — skipping online fetch" and never posted.
# This harness makes the POST happen and keeps the request bytes.
#
# It closes the loop D-200 records as its blocker ("No runtime test with PBL
# firmware"): a real PBL boot, over real TLS, with the pin from the policy blob,
# against a server that logs what it received.
#
# Requirements — all of these are check failures, not silent skips:
#   * /firmware/PblPkg/PblApp.efi              built PblApp
#   * /test/{server-cert.pem,server-key.pem,policy.cose,d131-wire-capture.py}
#       produced on the host by:
#       python3 firmware/PblPkg/d131-wire-capture.py --gen-assets /test/assets \
#           --host 10.0.2.2 --port 8443
#   * PBL_SWTPM_DIR pointing at an already-provisioned TPM state dir, produced by:
#       scripts/provision-qemu-tpm.sh <dir>
#   * swtpm, qemu-system-x86_64, mtools, sgdisk, and OVMF (mounted at /ovmf)
#
# Usage (from the host):
#   docker run --rm --network host \
#     -e PBL_SWTPM_DIR=/test/tpm \
#     -v "$PWD/firmware:/firmware:ro" \
#     -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
#     -v /tmp/d131-wire-rundir:/test \
#     pbl-qemu /firmware/PblPkg/test-d131-wire-harness.sh --timeout 60
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT=60
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)   TIMEOUT="${2:-60}"; shift 2 || shift ;;
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
TEST_DIR="${TEST_DIR:-/test}"
BUILD_DIR="${BUILD_DIR:-/tmp/pbl-d131-wire}"
PORT="${PBL_WIRE_PORT:-8443}"
HOST_IN_GUEST="10.0.2.2"
AK_NAME_HEX="${PBL_AK_NAME_HEX:-000b$(printf 'ab%.0s' $(seq 1 32))}"
# device_id is AK Name bytes [2..34) => hex offset 4. Compare 4 bytes.
EXPECTED_DEVICE_PREFIX="${AK_NAME_HEX:4:8}"

PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
CAPTURE_PY="${TEST_DIR}/d131-wire-capture.py"
ASSETS="${TEST_DIR}/assets"

fail() { echo "ERROR: $*" >&2; exit 1; }

# === Prerequisites: refuse to run rather than degrade into a meaningless pass ===
[ -f "${PBL_APP}" ] || fail "no PblApp.efi at ${PBL_APP} (run build-pbl.sh)"
[ -f "${CAPTURE_PY}" ] || fail "no capture script at ${CAPTURE_PY}"
for f in server-cert.pem server-key.pem policy.cose; do
  [ -f "${ASSETS}/${f}" ] || fail "missing ${ASSETS}/${f} (run --gen-assets)"
done
[ -n "${PBL_SWTPM_DIR:-}" ] || fail "set PBL_SWTPM_DIR to a provisioned TPM state dir (scripts/provision-qemu-tpm.sh)"
[ -d "${PBL_SWTPM_DIR}" ] || fail "PBL_SWTPM_DIR is not a directory: ${PBL_SWTPM_DIR}"
[ -f "${PBL_SWTPM_DIR}/tpm2-00.permall" ] || fail "${PBL_SWTPM_DIR} holds no swtpm state (tpm2-00.permall); provision it first"
command -v swtpm >/dev/null 2>&1 || fail "swtpm not installed"
command -v qemu-system-x86_64 >/dev/null 2>&1 || fail "qemu-system-x86_64 not installed"
for tool in mkfs.fat mmd mcopy sgdisk; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} not installed (mtools/dosfstools/gdisk)"
done

# A mounted /ovmf directory is a deliberate statement of intent, so an incomplete
# one is a hard failure. Previously a missing OVMF_VARS.fd (e.g. a varstore edit
# that silently produced nothing) fell through to the stock non-Secure-Boot OVMF
# and the run reported "Secure Boot disabled" while looking entirely normal —
# which cost two runs and nearly produced a wrong conclusion.
if [ -d /ovmf ] && [ -n "$(ls -A /ovmf 2>/dev/null)" ]; then
  [ -f /ovmf/OVMF_CODE.fd ] || fail "/ovmf is mounted but /ovmf/OVMF_CODE.fd is missing"
  [ -f /ovmf/OVMF_VARS.fd ] || fail "/ovmf is mounted but /ovmf/OVMF_VARS.fd is missing"
  OVMF_CODE="/ovmf/OVMF_CODE.fd"
  OVMF_VARS_SRC="/ovmf/OVMF_VARS.fd"
else
  OVMF_CODE="${OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS_SRC="${OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
fi
[ -f "${OVMF_CODE}" ] || fail "no OVMF_CODE at ${OVMF_CODE}"

mkdir -p "${BUILD_DIR}"
SERIAL_LOG="${BUILD_DIR}/serial.log"
SERVER_LOG="${BUILD_DIR}/server.log"
CAPTURE_DIR="${BUILD_DIR}/captured"

# === swtpm on the provisioned state (QEMU owns the data channel) ===
echo "=== Starting swtpm on provisioned state ==="
SWTPM_PID="${BUILD_DIR}/swtpm.pid"
rm -f "${SWTPM_PID}"
swtpm socket --tpmstate "dir=${PBL_SWTPM_DIR}" \
  --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
  --tpm2 --daemon --flags not-need-init --pid "file=${SWTPM_PID}"
for _ in $(seq 1 50); do
  if [ -S "${BUILD_DIR}/swtpm-ctrl.sock" ]; then break; fi
  sleep 0.1
done
swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
echo "  swtpm started (PID $(cat "${SWTPM_PID}" 2>/dev/null || echo '?'))"

# if/fi rather than `[ x ] && cmd || true`: the latter is not if-then-else (C can
# run when A is true) and shellcheck is right to flag it.
# shellcheck disable=SC2317,SC2329  # invoked via `trap cleanup EXIT` below
cleanup() {
  if [ -s "${SWTPM_PID}" ]; then
    kill "$(cat "${SWTPM_PID}")" 2>/dev/null || true
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    kill "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# === TLS capture server (stdlib only; this image has no cryptography/cbor2) ===
BIND="${PBL_WIRE_BIND:-127.0.0.1}"
echo "=== Starting TLS capture server on ${BIND}:${PORT} ==="
rm -rf "${CAPTURE_DIR}"
# Bind address: slirp maps the guest's 10.0.2.2 to the QEMU process's own
# network stack. Loopback is the tightest binding that can work, but depending
# on how the harness is containerised the mapping can land on the container's
# external address instead, so this is overridable rather than hard-coded.
python3 "${CAPTURE_PY}" --serve --assets "${ASSETS}" \
  --port "${PORT}" --bind "${BIND}" --out "${CAPTURE_DIR}" > "${SERVER_LOG}" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  grep -q "listening on" "${SERVER_LOG}" 2>/dev/null && break
  sleep 0.1
done
grep -q "listening on" "${SERVER_LOG}" || { cat "${SERVER_LOG}"; fail "capture server did not start"; }
echo "  server PID ${SERVER_PID}"

# === ESP: PblApp + policy blob ===
echo "=== Creating ESP (PblApp + policy.cose) ==="
DISK_IMG="${BUILD_DIR}/pbl_disk.img"
DISK_ESP="${BUILD_DIR}/pbl_esp.img"
rm -f "${DISK_IMG}" "${DISK_ESP}"
dd if=/dev/zero of="${DISK_IMG}" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:ESP "${DISK_IMG}" >/dev/null 2>&1
mkfs.fat -F 32 -n "ESP" -C "${DISK_ESP}" 50176 >/dev/null 2>&1
mmd -i "${DISK_ESP}" ::/EFI
mmd -i "${DISK_ESP}" ::/EFI/BOOT
mmd -i "${DISK_ESP}" ::/EFI/PBL
mcopy -i "${DISK_ESP}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${DISK_ESP}" "${ASSETS}/policy.cose" ::/EFI/PBL/policy.cose
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/vars.fd"

# === Boot: TPM + NIC (DHCP) + RNG ===
echo "=== Booting PblApp (QEMU: slirp network, TPM, RNG; timeout ${TIMEOUT}s) ==="
# OVMF's Secure Boot build requires SMM: without -machine q35,smm=on and the
# secure pflash global the firmware stalls with no serial output at all (which is
# exactly what happened the first time this was tried). Opt-in so the existing
# non-Secure-Boot runs are unchanged.
MACHINE_ARGS=(-machine q35)
# OVMF's SMM build drives the TPM over CRB, not TIS. With tpm-tis under SMM the
# guest reaches a TPM that has none of our provisioned indices — every NV read
# comes back TPM_RC_HANDLE (0x18B / 0x9A2), which reads like "device
# unprovisioned" but is an interface mismatch.
TPM_DEVICE="tpm-tis"
if [ "${PBL_SECURE_BOOT:-0}" = "1" ]; then
  MACHINE_ARGS=(-machine "q35,smm=on" -global "driver=cfi.pflash01,property=secure,value=on")
  TPM_DEVICE="tpm-crb"
fi

timeout "${TIMEOUT}" qemu-system-x86_64 "${MACHINE_ARGS[@]}" \
  -drive if=pflash,format=raw,readonly=on,file="${OVMF_CODE}" \
  -drive if=pflash,format=raw,file="${BUILD_DIR}/vars.fd" \
  -drive format=raw,file="${DISK_IMG}" \
  -nographic -m 512M \
  -device virtio-net-pci,netdev=net0,romfile= \
  -netdev user,id=net0 \
  -object filter-dump,id=dump0,netdev=net0,file="${BUILD_DIR}/wire.pcap" \
  -object rng-random,id=rng0,filename=/dev/urandom \
  -device virtio-rng-pci,rng=rng0 \
  -chardev socket,id=chrtpm,path="${BUILD_DIR}/swtpm-ctrl.sock" \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device "${TPM_DEVICE}",tpmdev=tpm0 \
  > "${SERIAL_LOG}" 2>&1 || true

echo "  serial log: $(wc -c < "${SERIAL_LOG}") bytes"
echo "  server log: $(wc -c < "${SERVER_LOG}") bytes"
# The pcap answers the one question the serial log cannot: did the guest put a
# single packet on the wire toward the server? "No SYN" and "SYN unanswered"
# are different defects, and guessing between them already cost this harness two
# runs (certificate algorithm, bind address).
if [ -f "${BUILD_DIR}/wire.pcap" ]; then
  echo "  pcap: $(wc -c < "${BUILD_DIR}/wire.pcap") bytes -> ${BUILD_DIR}/wire.pcap"
else
  echo "  pcap: NOT WRITTEN"
fi

# === Checks ===
PASS=0
FAIL=0
check() {
  local label="$1" pattern="$2" file="${3:-${SERIAL_LOG}}"
  if grep -qE "${pattern}" "${file}"; then
    echo "  [PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== Wire checks ==="
# The firmware must actually have reached the network and posted.
check "policy blob loaded from ESP"       "policy\.cose: [0-9]+ bytes"
check "device_id derived from AK Name"    "device_id from AK Name: ${EXPECTED_DEVICE_PREFIX^^}"
check "verdict request posted over TLS"   "POSTing verdict request to https://${HOST_IN_GUEST}:${PORT}"
# The server's own record is the artifact: it parsed the request it received.
check "server received a request"         "\\[SERVER\\] /v1/verdict [0-9]+ bytes" "${SERVER_LOG}"
check "wire device_id matches AK Name"    "device_id=${EXPECTED_DEVICE_PREFIX}" "${SERVER_LOG}"

# D-200 response half: the firmware must decode AND verify the verdict the server
# signed, not fall back to its cache. These are the two lines that distinguish
# "got bytes" from "accepted a verdict".
check "verdict decoded by firmware"       "Verdict decoded: verdict="
check "verdict signature verified"        "Verdict signature verified"
# No separate "not all zero" assertion: matching the expected prefix already
# proves it, and grep -E has no lookahead to express the negative cleanly.

CAPTURED_COUNT=$(find "${CAPTURE_DIR}" -name '*.bin' -type f 2>/dev/null | wc -l)
if [ "${CAPTURED_COUNT}" -ge 1 ]; then
  echo "  [PASS] request body captured (${CAPTURED_COUNT} file(s))"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] request body captured"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="
if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "=== server log ==="; tail -20 "${SERVER_LOG}"
  echo "=== serial log (tail) ==="; tail -40 "${SERIAL_LOG}"
  exit 1
fi
exit 0
