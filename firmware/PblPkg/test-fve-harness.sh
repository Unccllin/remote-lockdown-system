#!/bin/bash
# test-fve-harness.sh — D-120 FVE-FS metadata detection + boot-disk binding.
#
# Boots PblApp.efi in QEMU+swtpm three times:
#   1. samedisk  — one GPT disk: partition 1 = ESP (FAT, BOOTX64.EFI),
#                  partition 2 = synthetic FVE-FS volume. The FVE volume
#                  shares PBL's boot disk → expect "bound to boot disk".
#   2. otherdisk — raw ESP disk + a SECOND raw disk carrying the FVE-FS
#                  volume. Different device-path disk prefix → expect
#                  "not on boot disk" (negative binding case).
#   3. nofve     — no FVE volume anywhere. Expect: no FVE lines.
#
# Runs inside the pbl-qemu container:
#   docker run --rm \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v <OVMF FV dir>:/ovmf:ro \
#     pbl-qemu /firmware/PblPkg/test-fve-harness.sh
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-35}"
FIRMWARE_DIR="${FIRMWARE_DIR:-/firmware}"
BUILD_DIR="${BUILD_DIR:-/tmp/pbl-fve-ci}"
PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
RESULT="${BUILD_DIR}/pbl-fve-result.txt"

# OVMF paths: prefer the PBL custom build (PeiDxeTpmPlatformHierarchyLibNull)
# when /ovmf is mounted — the distro OVMF randomizes platformAuth at EndOfDxe
# (HierarchyChangeAuth), which breaks empty-password RS_PW provisioning.
if [ -f "/ovmf/OVMF_CODE.fd" ] && [ -f "/ovmf/OVMF_VARS.fd" ]; then
  OVMF_CODE="/ovmf/OVMF_CODE.fd"
  OVMF_VARS_SRC="/ovmf/OVMF_VARS.fd"
else
  OVMF_CODE="${OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS_SRC="${OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
fi

mkdir -p "${BUILD_DIR}"

if [ ! -f "${PBL_APP}" ]; then
  echo "ERROR: PblApp.efi not found at ${PBL_APP}"; exit 1
fi

# === ESP image ===
ESP_IMG="${BUILD_DIR}/esp.img"
dd if=/dev/zero of="${ESP_IMG}" bs=1M count=8 2>/dev/null
mkfs.vfat "${ESP_IMG}" >/dev/null 2>&1
mmd -i "${ESP_IMG}" ::/EFI ::/EFI/BOOT 2>/dev/null || true
mcopy -i "${ESP_IMG}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI

# === Synthetic FVE-FS disk (8 MB raw) ===
# Volume header: EB 58 90 + "-FVE-FS-" @3, GUID @160, metadata offsets
# @176/184/192. Metadata block @0x10000: block header(64) + metadata
# header(48) + VMK entry (TPM protection type 0x0100).
FVE_IMG="${BUILD_DIR}/fve.img"
python3 - "${FVE_IMG}" <<'PYEOF'
import struct, sys
img = bytearray(8 * 1024 * 1024)
img[0:3] = b'\xeb\x58\x90'
img[3:11] = b'-FVE-FS-'
img[160:176] = bytes(range(16))                       # volume GUID (dummy)
md = 0x10000
for i in range(3):
    img[176 + 8*i : 184 + 8*i] = struct.pack('<Q', md if i == 0 else 0)
# FVE metadata block
img[md : md+8] = b'-FVE-FS-'
struct.pack_into('<I', img, md + 8, 2)                # block header version v2
struct.pack_into('<Q', img, md + 16, 8*1024*1024)     # encrypted_volume_size
struct.pack_into('<Q', img, md + 32, md)              # block offset 1
struct.pack_into('<Q', img, md + 40, md + 0x10000)
struct.pack_into('<Q', img, md + 48, md + 0x20000)
struct.pack_into('<Q', img, md + 56, 8192)            # volume_header_offset
# metadata header @ md+64: metadata_size @0, volume GUID @16, method @36
vmk_size = 8 + 28                                     # hdr + GUID/FT/unk/prot
meta_size = 48 + vmk_size
struct.pack_into('<I', img, md + 64, meta_size)
img[md + 80 : md + 96] = bytes(range(16))
struct.pack_into('<H', img, md + 100, 0x8004)         # AES-XTS-128
# VMK entry @ md+112: size, type=2, vtype=8, ver=1 | GUID|FTIME|unk|prot
e = md + 112
struct.pack_into('<HHHH', img, e, vmk_size, 0x0002, 0x0008, 1)
img[e+8 : e+24] = bytes(range(16, 32))                # key identifier GUID
struct.pack_into('<Q', img, e + 24, 0x01DA000000000000)  # FILETIME-ish
struct.pack_into('<H', img, e + 32, 0)
struct.pack_into('<H', img, e + 34, 0x0100)           # protection = TPM
open(sys.argv[1], 'wb').write(img)
PYEOF

# === Same-disk combo image: GPT with ESP partition + FVE partition ===
# One physical disk — both partitions share the device-path disk prefix
# (transport/messaging nodes), differing only at the HD() media node.
COMBO_IMG="${BUILD_DIR}/combo.img"
ESP_PART_IMG="${BUILD_DIR}/esp-part.img"

dd if=/dev/zero of="${ESP_PART_IMG}" bs=1M count=16 2>/dev/null
mkfs.vfat "${ESP_PART_IMG}" >/dev/null 2>&1
mmd -i "${ESP_PART_IMG}" ::/EFI ::/EFI/BOOT 2>/dev/null || true
mcopy -i "${ESP_PART_IMG}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI

dd if=/dev/zero of="${COMBO_IMG}" bs=1M count=32 2>/dev/null
sgdisk -o \
  -n 1:2048:+16M -t 1:EF00 -c 1:ESP \
  -n 2:0:+8M     -t 2:0700 -c 2:FVE \
  "${COMBO_IMG}" >/dev/null
P1_START=$(sgdisk -i 1 "${COMBO_IMG}" | awk '/First sector/{print $3}')
P2_START=$(sgdisk -i 2 "${COMBO_IMG}" | awk '/First sector/{print $3}')
dd if="${ESP_PART_IMG}" of="${COMBO_IMG}" bs=512 seek="${P1_START}" conv=notrunc 2>/dev/null
dd if="${FVE_IMG}"      of="${COMBO_IMG}" bs=512 seek="${P2_START}" conv=notrunc 2>/dev/null

cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/OVMF_VARS.fd"

# === NG-T5: partition-binding combo image (combo + BCD osdevice) ===
# A second combo image whose ESP ALSO carries \EFI\Microsoft\Boot\BCD —
# a synthetic hive (gen-bcd-hive.py) with one osloader whose osdevice
# partition-device blob names the FVE partition's GUID. PBL should bind
# the FVE volume at PARTITION level, not just disk level.
COMBO_BCD_IMG="${BUILD_DIR}/combo-bcd.img"
ESP_BCD_IMG="${BUILD_DIR}/esp-bcd.img"

# Partition 2's unique GUID is what the osdevice blob must name.
P2_GUID=$(sgdisk -i 2 "${COMBO_IMG}" | awk '/Partition unique GUID/{print $4}')
python3 "${FIRMWARE_DIR}/PblPkg/gen-bcd-hive.py" \
  --out "${BUILD_DIR}/BCD" --partition-guid "${P2_GUID}" >/dev/null

dd if=/dev/zero of="${ESP_BCD_IMG}" bs=1M count=16 2>/dev/null
mkfs.vfat "${ESP_BCD_IMG}" >/dev/null 2>&1
mmd -i "${ESP_BCD_IMG}" ::/EFI ::/EFI/BOOT ::/EFI/Microsoft ::/EFI/Microsoft/Boot 2>/dev/null || true
mcopy -i "${ESP_BCD_IMG}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "${ESP_BCD_IMG}" "${BUILD_DIR}/BCD" ::/EFI/Microsoft/Boot/BCD

cp "${COMBO_IMG}" "${COMBO_BCD_IMG}"
dd if="${ESP_BCD_IMG}" of="${COMBO_BCD_IMG}" bs=512 seek="${P1_START}" conv=notrunc 2>/dev/null

SWTPM_DIR="${BUILD_DIR}/swtpm-state"
mkdir -p "${SWTPM_DIR}"

boot() {
  local name="$1"
  local main_drive="$2"
  local extra_drive="${3:-}"
  local log="${BUILD_DIR}/serial-${name}.log"
  local sock="${BUILD_DIR}/swtpm-${name}.sock"
  swtpm socket --tpmstate dir="${SWTPM_DIR}" --tpm2 \
    --ctrl type=unixio,path="${sock}" --flags not-need-init \
    --log "file=${BUILD_DIR}/swtpm-${name}.log,level=20" &
  local spid=$!
  sleep 1
  timeout "${TIMEOUT}" qemu-system-x86_64 \
    -machine q35 -m 256M -nodefaults -nographic -no-reboot \
    -drive if=pflash,format=raw,readonly=on,file="${OVMF_CODE}" \
    -drive if=pflash,format=raw,file="${BUILD_DIR}/OVMF_VARS.fd" \
    -drive format=raw,file="${main_drive}" \
    ${extra_drive} \
    -chardev socket,id=tpm0,path="${sock}" \
    -tpmdev emulator,id=tpm0,chardev=tpm0 -device tpm-tis,tpmdev=tpm0 \
    -serial file:"${log}" -monitor none -display none \
    2>/dev/null || true
  kill "${spid}" 2>/dev/null || true
  sleep 1
}

PASS=0; FAIL=0
check() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "${pattern}" "${file}"; then
    echo "  [PASS] ${label}"; PASS=$((PASS+1))
  else
    echo "  [FAIL] ${label}"; FAIL=$((FAIL+1))
  fi
}
check_absent() {
  local label="$1" pattern="$2" file="$3"
  if grep -qE "${pattern}" "${file}"; then
    echo "  [FAIL] ${label} (unexpected match)"; FAIL=$((FAIL+1))
  else
    echo "  [PASS] ${label}"; PASS=$((PASS+1))
  fi
}

echo "=== Boot 1: FVE on same disk as ESP (GPT combo) ==="
boot samedisk "${COMBO_IMG}"
echo "=== Boot 2: FVE on a separate disk ==="
boot otherdisk "${ESP_IMG}" "-drive format=raw,file=${FVE_IMG}"
echo "=== Boot 3: no FVE disk ==="
boot nofve "${ESP_IMG}"
echo "=== Boot 4: FVE + BCD osdevice (partition binding) ==="
boot partbind "${COMBO_BCD_IMG}"

S1="${BUILD_DIR}/serial-samedisk.log"
S2="${BUILD_DIR}/serial-otherdisk.log"
S3="${BUILD_DIR}/serial-nofve.log"
S4="${BUILD_DIR}/serial-partbind.log"

echo ""
echo "=== Checking serial output ==="
# Boot 1 — same disk: detection + positive binding
check "PBL banner (samedisk)"    "PBL — Pre-Boot Lock" "${S1}"
check "FVE volume detected"      "FVE-FS volume detected" "${S1}"
check "FVE bound to boot disk"   "FVE volume bound to boot disk" "${S1}"
check "FVE metadata parsed"      "FVE metadata v2" "${S1}"
check "Encryption method AES-XTS" "method 0x8004" "${S1}"
check "TPM protector bitmask"    "protectors 0x0002" "${S1}"
check "NV indices provisioned"   "NV indices provisioned" "${S1}"
check "HMAC session established" "HMAC session established" "${S1}"
check "Lock screen (samedisk)"   "THIS DEVICE IS LOCKED" "${S1}"
# Boot 2 — other disk: detection + negative binding
check "FVE detected (otherdisk)"  "FVE-FS volume detected" "${S2}"
check "FVE not on boot disk"      "FVE volume not on boot disk" "${S2}"
check_absent "No false binding (otherdisk)" "FVE volume bound to boot disk" "${S2}"
check "Lock screen (otherdisk)"   "THIS DEVICE IS LOCKED" "${S2}"
# Boot 3 — absent
check "PBL banner (nofve)"       "PBL — Pre-Boot Lock" "${S3}"
check_absent "No FVE detection without disk" "FVE-FS volume detected" "${S3}"
check "Lock screen (nofve)"      "THIS DEVICE IS LOCKED" "${S3}"
# Boot 4 — NG-T5 partition-level binding: osdevice names the FVE partition
check "PBL banner (partbind)"      "PBL — Pre-Boot Lock" "${S4}"
check "FVE detected (partbind)"    "FVE-FS volume detected" "${S4}"
check "FVE bound to boot disk (partbind)" "FVE volume bound to boot disk" "${S4}"
check "FVE bound to boot PARTITION" "FVE volume bound to boot partition" "${S4}"

echo ""
echo "=== Results: ${PASS} PASS / ${FAIL} FAIL ==="
{
  echo "PBL D-120 FVE detection + binding harness — $(date -u +%FT%TZ)"
  echo "Results: ${PASS} PASS / ${FAIL} FAIL"
  echo ""
  echo "--- serial-samedisk.log ---";  cat "${S1}"
  echo "--- serial-otherdisk.log ---"; cat "${S2}"
  echo "--- serial-nofve.log ---";     cat "${S3}"
  echo "--- serial-partbind.log ---";  cat "${S4}"
} > "${RESULT}"
echo "Artifact written: ${RESULT}"

[ "${FAIL}" -eq 0 ]
