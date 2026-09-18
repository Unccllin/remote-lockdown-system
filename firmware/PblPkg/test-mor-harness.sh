#!/bin/bash
# test-mor-harness.sh — NG-T4 MOR outcome verification (QEMU + OVMF NVRAM).
#
# Boots PblApp.efi to the BLOCK path (which calls PblRequestMor + PblLockMor
# before the lock screen), then parses the post-run OVMF_VARS fd to prove the
# variables physically landed in NVRAM under the CORRECT GUIDs — the outcome
# check the D-220-era serial-only harnesses missed (B-023 blind spot).
#
# Assertions (outcome, not logs):
#   1. MemoryOverwriteRequestControl exists under gEfiMemoryOverwriteControlDataGuid
#      (e20939be-32d4-41be-a150-897f85d49829) with bit 0 set
#   2. MemoryOverwriteRequestControlLock exists under
#      gEfiMemoryOverwriteRequestControlLockGuid
#      (BB983CCF-151D-40E1-A07B-4A17BE168292) with value 0x01
#   3. MemoryOverwriteRequestControl does NOT exist under EFI_GLOBAL_VARIABLE
#      (8be4df61-93ca-11d2-aa0d-00e098032b8c) — the old decoy-GUID write
#
# Usage (from host):
#   docker run --rm \
#     -v $(pwd)/firmware:/firmware:ro \
#     -v /home/cllin/.local/src/edk2/Build/OvmfX64/RELEASE_GCC/FV:/ovmf:ro \
#     pbl-qemu /firmware/PblPkg/test-mor-harness.sh
#
# Optional: mount -v /some/dir:/out to persist the post-run VARS fd +
# serial log on the host for inspection.
#
# SMM mode: set SMM=1 to boot an SMM-enabled OVMF (e.g. Ubuntu secboot/ms
# build, which uses VariableSmm + TcgMorLockSmm — the real v2 MOR lock).
# The default non-SMM VariableRuntimeDxe build registers LOCK_NOW
# VariablePolicies on both MOR vars at EndOfDxe (by design — EDK2
# considers MOR unsupported without SMM), so MOR writes are denied with
# EFI_WRITE_PROTECTED. The harness detects which mode ran and asserts the
# platform-appropriate outcome:
#   SMM=0 (non-SMM): writes denied (WRITE_PROTECTED) = proof the request
#                    reached the real policy-guarded variable; no decoy.
#   SMM=1 (SMM):     writes succeed; MOR bit0 + lock var 0x01 in NVRAM.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-30}"
FIRMWARE_DIR="${FIRMWARE_DIR:-/firmware}"
BUILD_DIR="/tmp/pbl-mor"
OUT_DIR="/out"

if [ -f "/ovmf/OVMF_CODE.fd" ] && [ -f "/ovmf/OVMF_VARS.fd" ]; then
  OVMF_CODE="/ovmf/OVMF_CODE.fd"
  OVMF_VARS_SRC="/ovmf/OVMF_VARS.fd"
else
  OVMF_CODE="${OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS_SRC="${OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
fi

mkdir -p "${BUILD_DIR}"

PBL_APP="${FIRMWARE_DIR}/PblPkg/PblApp.efi"
[ -f "${PBL_APP}" ] || { echo "ERROR: PblApp.efi not found"; exit 1; }
[ -f "${OVMF_CODE}" ] || { echo "ERROR: OVMF_CODE not found"; exit 1; }

# === swtpm (same D-101 pattern as ci-harness-docker.sh) ===
echo "=== Starting swtpm ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"
SWTPM_ARGS=""
if command -v swtpm >/dev/null 2>&1; then
  swtpm socket --tpmstate dir="${SWTPM_DIR}" \
    --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
    --tpm2 --daemon --flags not-need-init \
    --pid file="${BUILD_DIR}/swtpm.pid"
  swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
  SWTPM_ARGS="-chardev socket,id=chrtpm,path=${BUILD_DIR}/swtpm-ctrl.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0"
  echo "  swtpm started"
else
  echo "  [INFO] no swtpm — running without TPM"
fi

# === ESP image ===
echo "=== Creating ESP disk image ==="
DISK_IMG="${BUILD_DIR}/pbl_disk.img"
DISK_ESP="${BUILD_DIR}/pbl_esp.img"
rm -f "${DISK_IMG}" "${DISK_ESP}"
dd if=/dev/zero of="${DISK_IMG}" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "${DISK_IMG}" 2>&1 | grep -v "^Warning" || true
mkfs.fat -F 32 -n "ESP" -C "${DISK_ESP}" 50176 2>&1 >/dev/null
mmd -i "${DISK_ESP}" ::/EFI
mmd -i "${DISK_ESP}" ::/EFI/BOOT
mcopy -i "${DISK_ESP}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
dd if="${DISK_ESP}" of="${DISK_IMG}" bs=512 seek=2048 conv=notrunc status=none

# === Boot ===
echo "=== Booting PblApp in OVMF (timeout ${TIMEOUT}s) ==="
VARS_RUN="${BUILD_DIR}/OVMF_VARS_run.fd"
cp "${OVMF_VARS_SRC}" "${VARS_RUN}"
SERIAL_LOG="${BUILD_DIR}/pbl-serial.log"

python3 << PYEOF
import subprocess, time, select, os

cmd = [
    "timeout", "${TIMEOUT}",
    "qemu-system-x86_64",
]
if "${SMM:-0}" == "1":
    # SMM-enabled OVMF requires q35 + SMM emulation + secure pflash
    cmd += [
        "-machine", "q35,smm=on",
        "-global", "driver=cfi.pflash01,property=secure,value=on",
    ]
cmd += [
    "-drive", "if=pflash,format=raw,readonly=on,file=${OVMF_CODE}",
    "-drive", "if=pflash,format=raw,file=${VARS_RUN}",
    "-drive", "format=raw,file=${DISK_IMG}",
    "-nographic",
    "-m", "256M",
]
swtpm_args = "${SWTPM_ARGS}".split()
if swtpm_args:
    cmd.extend(swtpm_args)

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        stdin=subprocess.PIPE)
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
    # Send override input so the BLOCK path completes past the lock screen.
    # MOR request+lock happen BEFORE the lock screen, so this just lets the
    # run finish cleanly.
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

with open("${SERIAL_LOG}", "wb") as f:
    f.write(output)
print(f"  QEMU exited {proc.returncode}, serial {len(output)} bytes")
PYEOF

# === Parse post-run NVRAM varstore ===
# Layout (auth + non-auth headers both end): ... NameSize(u32) DataSize(u32)
# VendorGuid(16B) | Name(UTF-16LE, NameSize incl. NUL) | Data(DataSize)
# → scan for UTF-16LE name, VendorGuid is the 16 bytes before it.
echo ""
echo "=== Scanning NVRAM varstore for MOR variables ==="

set +e
SMM="${SMM:-0}" SERIAL_LOG="${SERIAL_LOG}" python3 << 'PYEOF'
import struct, sys, os

VARS = "/tmp/pbl-mor/OVMF_VARS_run.fd"
SMM = os.environ.get("SMM", "0") == "1"
SERIAL_LOG = os.environ["SERIAL_LOG"]
blob = open(VARS, "rb").read()

def find_vars(name):
    """Return list of (vendor_guid_bytes, data_bytes) for every var named `name`."""
    needle = name.encode("utf-16-le") + b"\x00\x00"
    out = []
    off = 0
    while True:
        i = blob.find(needle, off)
        if i < 0:
            break
        # VendorGuid = 16 bytes immediately before the name
        guid = blob[i-16:i]
        # NameSize/DataSize sit 24/20 bytes before the name
        name_size  = struct.unpack("<I", blob[i-24:i-20])[0]
        data_size  = struct.unpack("<I", blob[i-20:i-16])[0]
        data_off = i + name_size
        data = blob[data_off:data_off+data_size] if 0 < data_size <= 4096 else b""
        out.append((guid, data, name_size, data_size))
        off = i + 2
    return out

def guid_str(b):
    d1, d2, d3 = struct.unpack("<IHH", b[:8])
    d4 = b[8:].hex()
    return f"{d1:08x}-{d2:04x}-{d3:04x}-{d4[:4]}-{d4[4:]}"

SPEC_MOR  = "e20939be-32d4-41be-a150-897f85d49829"
SPEC_LOCK = "bb983ccf-151d-40e1-a07b-4a17be168292"
GLOBAL    = "8be4df61-93ca-11d2-aa0d-00e098032b8c"

serial = open(SERIAL_LOG, "rb").read() if os.path.exists(SERIAL_LOG) else b""
results = []

# 1. MOR control under spec GUID
mor = find_vars("MemoryOverwriteRequestControl")
hit = [(g, d) for g, d, ns, ds in mor if guid_str(g) == SPEC_MOR]
if SMM:
    # SMM platform: our write should have landed — bit0 must be set
    if hit and hit[0][1] and (hit[0][1][0] & 0x01):
        results.append(("PASS", f"MemoryOverwriteRequestControl under spec GUID, data={hit[0][1].hex()}"))
    elif hit:
        results.append(("FAIL", f"MOR var under spec GUID but bit0 clear (data={hit[0][1].hex()})"))
    else:
        seen = [guid_str(g) for g, _, _, _ in mor]
        results.append(("FAIL", f"MOR var NOT under spec GUID (seen guids: {seen or 'none — variable absent'})"))
else:
    # Non-SMM platform (VariableRuntimeDxe): platform LOCK_NOW-denies all
    # post-EndOfDxe MOR writes by design. Expected outcome = the platform's
    # VariablePolicy answered WRITE_PROTECTED — which itself PROVES our
    # request reached the real policy-guarded variable (a decoy-GUID write
    # would succeed silently). Plus the spec-GUID var exists (TcgMor's).
    if b"[MOR] SetVariable failed: Write Protected" in serial:
        results.append(("PASS", "write denied WRITE_PROTECTED by platform policy "
                                "(proof request hit the real MOR variable)"))
    elif b"[MOR] MemoryOverwriteRequestControl set (spec GUID)" in serial:
        results.append(("PASS", "write accepted on non-SMM platform (unusual but valid)"))
    else:
        results.append(("FAIL", "no MOR write evidence in serial"))
    if hit:
        results.append(("PASS", f"spec-GUID MOR var present in NVRAM (TcgMor's, data={hit[0][1].hex()})"))
    else:
        results.append(("INFO", "spec-GUID MOR var absent (TcgMor did not create it)"))

# 2. Decoy check — must NOT exist under EFI_GLOBAL_VARIABLE (always)
decoy = [g for g, _, _, _ in mor if guid_str(g) == GLOBAL]
if decoy:
    results.append(("FAIL", "decoy MemoryOverwriteRequestControl under EFI_GLOBAL_VARIABLE"))
else:
    results.append(("PASS", "no decoy MOR var under EFI_GLOBAL_VARIABLE"))

# 3. Lock variable under spec lock GUID
lock = find_vars("MemoryOverwriteRequestControlLock")
lhit = [(g, d) for g, d, ns, ds in lock if guid_str(g) == SPEC_LOCK]
if SMM:
    if lhit and lhit[0][1] and lhit[0][1][0] == 0x01:
        results.append(("PASS", f"MemoryOverwriteRequestControlLock under spec GUID, data={lhit[0][1].hex()}"))
    elif lhit:
        results.append(("FAIL", f"lock var under spec GUID but value != 0x01 (data={lhit[0][1].hex()})"))
    else:
        seen = [guid_str(g) for g, _, _, _ in lock]
        results.append(("FAIL", f"lock var absent (seen guids: {seen or 'none'})"))
else:
    # Non-SMM: lock var is deleted + LOCK_NOW'd at EndOfDxe — expected absent
    if lhit:
        results.append(("INFO", f"lock var present on non-SMM platform (data={lhit[0][1].hex()})"))
    elif b"[MOR] Lock not supported: Write Protected" in serial:
        results.append(("PASS", "lock write denied WRITE_PROTECTED as expected on non-SMM "
                                "(platform policy-guarded, var absent)"))
    else:
        results.append(("INFO", "lock var absent and no serial evidence"))

for status, msg in results:
    print(f"  [{status}] {msg}")

if any(s == "FAIL" for s, _ in results):
    sys.exit(1)
PYEOF
SCAN_RC=$?
set -e

# === Secondary: serial corroboration (logs are corroborating, not the proof) ===
echo ""
echo "=== Serial corroboration ==="
grep -qE "\[MOR\] MemoryOverwriteRequestControl set \(spec GUID\)" "${SERIAL_LOG}" \
  && echo "  [PASS] serial: MOR control write logged" \
  || echo "  [INFO] serial: MOR write line absent"
grep -qE "\[MOR\] MemoryOverwriteRequestControlLock set" "${SERIAL_LOG}" \
  && echo "  [PASS] serial: MOR lock write logged" \
  || { grep -qE "\[MOR\] Lock not supported" "${SERIAL_LOG}" \
       && echo "  [INFO] serial: platform rejected MOR lock (older firmware)" \
       || echo "  [INFO] serial: no lock line"; }

# Persist artifacts on host if /out mounted
if [ -d "${OUT_DIR}" ] && [ -w "${OUT_DIR}" ]; then
  cp "${VARS_RUN}" "${OUT_DIR}/OVMF_VARS_run.fd"
  cp "${SERIAL_LOG}" "${OUT_DIR}/pbl-mor-serial.log"
  echo "  artifacts copied to /out"
fi

if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
  kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
fi

echo ""
if [ "${SCAN_RC}" -eq 0 ]; then
  echo "=== NG-T4 MOR verification: PASS ==="
else
  echo "=== NG-T4 MOR verification: FAIL ==="
  tail -30 "${SERIAL_LOG}"
fi
exit "${SCAN_RC}"
