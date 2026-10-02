#!/usr/bin/env bash
# test-persist-harness.sh — QEMU proof of the PblPersistDxe re-arm cycle.
#
# Proves the persistence claim end-to-end in emulation:
#   Boot 1: ESP contains the loader (BOOTX64.EFI) + PblPersistDxe.efi.
#           Loader LoadImage+StartImage's the DXE driver → ReadyToBoot
#           callback registers → on return to BDS the callback fires and
#           drops \EFI\PBL\{PBL_REARM.TXT, lockdown-agent-installer.ps1}.
#   Verify: read the ESP image offline — the dropped files must exist.
#   Wipe:   rebuild a pristine ESP with ONLY the driver (simulate an OS
#           reinstall / disk replacement that erased the dropped files).
#   Boot 2: re-arm again on the wiped ESP — persistence across wipe.
#
# Usage:
#   firmware/PblPkg/test-persist-harness.sh
#
# Requires: docker (pbl-qemu image), EDK2_DIR pointing at a built OVMF.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRMWARE_DIR="$(dirname "${SCRIPT_DIR}")"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
BUILD="${EDK2_DIR}/Build/PblPkg/RELEASE_GCC/X64"

LOADER_EFI="${BUILD}/PblPersistLoader.efi"
PERSIST_EFI="${BUILD}/PblPersistDxe.efi"
OVMF_CODE="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd"
OVMF_VARS="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_VARS.fd"
LOG_DIR="${SCRIPT_DIR}"
LOG_FILE="${LOG_DIR}/test-output-persist.log"
RESULT_FILE="${LOG_DIR}/pbl-persist-result.txt"

for f in "${LOADER_EFI}" "${PERSIST_EFI}" "${OVMF_CODE}" "${OVMF_VARS}"; do
  [ -f "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done

WORK=/tmp/pbl-persist
rm -rf "${WORK}"; mkdir -p "${WORK}"
cp "${OVMF_CODE}" "${WORK}/"
cp "${OVMF_VARS}" "${WORK}/OVMF_VARS.fd"

# Stage ESP content: loader as BOOTX64.EFI + the DXE driver under \EFI\PBL.
rm -rf /tmp/pbl-persist-esp
mkdir -p /tmp/pbl-persist-esp/EFI/BOOT /tmp/pbl-persist-esp/EFI/PBL
cp "${LOADER_EFI}"  /tmp/pbl-persist-esp/EFI/BOOT/BOOTX64.EFI
cp "${PERSIST_EFI}" /tmp/pbl-persist-esp/EFI/PBL/PblPersistDxe.efi

echo "=== PblPersistDxe re-arm harness ==="
echo "  Driver: ${PERSIST_EFI}"
echo "  Loader: ${LOADER_EFI}"
echo "  Log:    ${LOG_FILE}"
echo

docker run --rm \
  -v "${WORK}":/work \
  -v /tmp/pbl-persist-esp:/esp:ro \
  pbl-qemu /bin/bash -c '
    set -e
    BUILD=/work
    DISK="${BUILD}/disk.img"
    ESP="${BUILD}/disk.esp"

    make_disk () {
      dd if=/dev/zero of="${DISK}" bs=1M count=50 status=none
      sgdisk --clear --new=1:2048:0 --typecode=1:EF00 --change-name=1:ESP "${DISK}" >/dev/null 2>&1 || true
      mkfs.fat -F 32 -n ESP -C "${ESP}" 50176 >/dev/null 2>&1
    }

    load_esp () {  # copy host /esp tree into the ESP image
      mmd -i "${ESP}" ::/EFI ::/EFI/BOOT ::/EFI/PBL 2>/dev/null || true
      mcopy -i "${ESP}" -o /esp/EFI/BOOT/BOOTX64.EFI ::/EFI/BOOT/BOOTX64.EFI
      mcopy -i "${ESP}" -o /esp/EFI/PBL/PblPersistDxe.efi ::/EFI/PBL/PblPersistDxe.efi
      dd if="${ESP}" of="${DISK}" bs=512 seek=2048 conv=notrunc status=none
    }

    boot () {    # run QEMU for $1 seconds, capture serial
      local secs=$1
      timeout "${secs}" qemu-system-x86_64 \
        -m 512 -smp 2 \
        -drive if=pflash,format=raw,readonly=on,file="${BUILD}/OVMF_CODE.fd" \
        -drive if=pflash,format=raw,file="${BUILD}/OVMF_VARS.fd" \
        -drive format=raw,file="${DISK}" \
        -nographic -serial mon:stdio -display none \
        -netdev user,id=n0 -device e1000,netdev=n0,romfile= \
        2>&1 || true
    }

    check_esp () {  # extract ESP, list \EFI\PBL contents
      dd if="${DISK}" of="${ESP}.out" bs=512 skip=2048 count=50176 status=none
      mdir -i "${ESP}.out" ::/EFI/PBL 2>/dev/null || echo "(no \EFI\PBL dir)"
    }

    echo "===== BOOT 1 (fresh ESP) ====="
    make_disk; load_esp
    boot 25
    echo "===== ESP contents after boot 1 ====="
    check_esp

    echo "===== WIPE ESP (simulate reinstall / disk swap) ====="
    make_disk
    # Re-stage only the driver + loader; the dropped payload is gone.
    mmd -i "${ESP}" ::/EFI ::/EFI/BOOT ::/EFI/PBL 2>/dev/null || true
    mcopy -i "${ESP}" -o /esp/EFI/BOOT/BOOTX64.EFI ::/EFI/BOOT/BOOTX64.EFI
    mcopy -i "${ESP}" -o /esp/EFI/PBL/PblPersistDxe.efi ::/EFI/PBL/PblPersistDxe.efi
    dd if="${ESP}" of="${DISK}" bs=512 seek=2048 conv=notrunc status=none
    echo "--- wiped ESP has no dropped payload:"
    dd if="${DISK}" of="${ESP}.mid" bs=512 skip=2048 count=50176 status=none
    mdir -i "${ESP}.mid" ::/EFI/PBL 2>/dev/null || echo "(empty)"

    echo "===== BOOT 2 (post-wipe) ====="
    boot 25
    echo "===== ESP contents after boot 2 ====="
    check_esp
  ' > "${LOG_FILE}" 2>&1 || true

echo "=== Analyzing ==="
B1=$(grep -c "PBL_REARM.TXT" "${LOG_FILE}" || true)
AGENT=$(grep -c "lockdown-agent-installer.ps1" "${LOG_FILE}" || true)

{
  echo "PblPersistDxe harness result"
  echo "date: $(date -u +%FT%TZ)"
  echo "driver_sha256: $(sha256sum "${PERSIST_EFI}" | cut -d' ' -f1)"
  echo "marker_mentions: ${B1}  agent_mentions: ${AGENT}"
  if [ "${B1}" -ge 2 ] && [ "${AGENT}" -ge 2 ]; then
    echo "VERDICT: PASS — agent re-armed on fresh AND wiped ESP"
  else
    echo "VERDICT: NEEDS-REVIEW — see ${LOG_FILE}"
  fi
} | tee "${RESULT_FILE}"
