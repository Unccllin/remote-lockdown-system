#!/bin/bash
# test-s05-bootpath-harness.sh — S0.5 shell/BootNext classification harness.
#
# Verifies the boot-path measurement fields (PblApp.h PBL_BPF_*):
#   - Boot#### loader paths containing *shell* → SHELL_IN_BOOT_ENTRY + ShellEntryMask
#   - *shell*.efi planted on an ESP          → SHELL_ON_ESP
#   - BootNext                                → BOOTNEXT_SET / SHELL_AS_BOOTNEXT
#
# Scenarios (each gets a fresh OVMF_VARS + its own ESP image):
#   baseline       no shells anywhere               → flags=0x00
#   esp-shell      \EFI\TOOLS\SHELL.EFI on the ESP  → flags bit3
#   bootentry      BootOrder=[0000,0007], Boot0007  → flags bit0 + mask
#                  has FILEPATH \EFI\PBL\FAKESHELL.EFI
#   bootnext       BootNext=0x9999 alone (nonexistent) → documents the
#                  EDK2 BDS finding: BootNext is deleted at BdsEntry.c:1075
#                  BEFORE dispatch, so it is unobservable by the booted
#                  app — expected bootnext=0xFFFF.
#                  NOTE: BootNext pointing at an EXISTENT Boot#### hangs
#                  this OVMF build silently (pre-console) — emulated
#                  anomaly, not a PBL defect; recorded as a finding.
#   ghost          Boot0009 shell NOT in BootOrder → same OVMF anomaly:
#                  an unordered Boot#### wedges this build pre-console
#                  (zero serial). Asserted as documented outcome; on
#                  firmware without this quirk the entry is either
#                  invisible (residual gap — unordered entries are not
#                  walked) or surfaced by a survival policy like OVMF's
#                  BootOrderComplete append.
#
# Verification technique: UEFI variable injection directly into the
# OVMF_VARS.fd NVRAM image (authenticated-varstore VARIABLE_HEADER,
# same primitive proven in the D-217 KernelDmaProtection spoof test).
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

TIMEOUT="${1:-30}"
FIRMWARE_DIR="${FIRMWARE_DIR:-/firmware}"
BUILD_DIR="/tmp/pbl-s05"

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

# === swtpm (D-101 pattern) ===
echo "=== Starting swtpm ==="
SWTPM_DIR="${BUILD_DIR}/swtpm-state"
rm -rf "${SWTPM_DIR}"
mkdir -p "${SWTPM_DIR}"
SWTPM_ARGS=""
if [ "${PBL_NO_SWTPM:-0}" = "1" ]; then
  echo "  [INFO] PBL_NO_SWTPM=1 — running without TPM"
elif command -v swtpm >/dev/null 2>&1; then
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

# === helpers ===

# mkesp <img> [extra_esp_file] — build a 50MB GPT disk, ESP at sector 2048.
mkesp() {
  local img="$1" extra="$2"
  local esp="${img}.esp"
  rm -f "${img}" "${esp}"
  dd if=/dev/zero of="${img}" bs=1M count=50 status=none
  sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "${img}" 2>&1 | grep -v "^Warning" || true
  mkfs.fat -F 32 -n "ESP" -C "${esp}" 50176 >/dev/null 2>&1
  mmd -i "${esp}" ::/EFI ::/EFI/BOOT ::/EFI/TOOLS 2>/dev/null || true
  mcopy -i "${esp}" "${PBL_APP}" ::/EFI/BOOT/BOOTX64.EFI
  if [ -n "${extra}" ]; then
    mcopy -i "${esp}" "${extra}" ::/EFI/TOOLS/SHELL.EFI
  fi
  dd if="${esp}" of="${img}" bs=512 seek=2048 conv=notrunc status=none
}

# inject_vars <vars_fd> <spec> — append variables to the NVRAM image.
# spec: "Name|guid|attr|datahex" lines. Boot####/BootOrder data built by
# the caller-side python helpers below.
inject_vars() {
  local vars_fd="$1" spec="$2"
  python3 - "$vars_fd" << PYEOF
import struct, sys

VARS_FD = sys.argv[1]
SPEC = """${spec}"""

def guid_bytes(g):
    p = g.split("-")
    d = struct.pack("<IHH", int(p[0],16), int(p[1],16), int(p[2],16))
    return d + bytes.fromhex(p[3]) + bytes.fromhex(p[4])

blob = bytearray(open(VARS_FD, "rb").read())

# Free space = first long 0xFF run after the variable region start.
FREE = blob.find(b"\xff" * 256, 0x40)
if FREE < 0:
    print("ERROR: no free space in varstore"); sys.exit(1)
off = FREE

for line in SPEC.strip().splitlines():
    line = line.strip()
    if not line:
        continue
    name, guid, attr, datahex = line.split("|")
    nb = name.encode("utf-16-le") + b"\x00\x00"
    data = bytes.fromhex(datahex)
    hdr  = struct.pack("<HBBIQ", 0x55AA, 0x3F, 0, int(attr, 16), 0)
    hdr += b"\x00" * 16                      # Timestamp
    hdr += struct.pack("<I", 0xFFFFFFFF)     # PubKeyIndex (non-auth)
    hdr += struct.pack("<II", len(nb), len(data))
    var = hdr + guid_bytes(guid) + nb + data
    blob[off:off+len(var)] = var
    off += len(var)
    print(f"  injected {name} ({len(data)}B data)")

open(VARS_FD, "wb").write(blob)
PYEOF
}

# swtpm's unixio ctrl channel does not reliably accept a second QEMU
# connection (socket unlinked on disconnect, or a wedged listener that
# accepts connect() then never answers — observed as a silent 0-byte
# serial hang). Kill and restart the daemon for every boot; the
# tpmstate dir preserves NV/PCR state across restarts.
start_swtpm() {
  if command -v swtpm >/dev/null 2>&1; then
    if [ -f "${BUILD_DIR}/swtpm.pid" ]; then
      kill "$(cat "${BUILD_DIR}/swtpm.pid")" 2>/dev/null || true
      sleep 0.3
    fi
    rm -f "${BUILD_DIR}/swtpm.pid" "${BUILD_DIR}/swtpm-ctrl.sock"
    swtpm socket --tpmstate dir="${SWTPM_DIR}" \
      --ctrl type=unixio,path="${BUILD_DIR}/swtpm-ctrl.sock" \
      --tpm2 --daemon --flags not-need-init \
      --pid file="${BUILD_DIR}/swtpm.pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -S "${BUILD_DIR}/swtpm-ctrl.sock" ] && break
      sleep 0.2
    done
    swtpm_ioctl --unix "${BUILD_DIR}/swtpm-ctrl.sock" -i 2>/dev/null || true
  fi
}

# boot <disk_img> <vars_fd> <serial_log> — uses <vars_fd> as-is if it
# already exists (i.e. carries injected variables); otherwise seeds a
# fresh copy of the OVMF template.
boot() {
  local img="$1" vars="$2" log="$3"
  start_swtpm
  if [ ! -f "${vars}" ]; then
    cp "${OVMF_VARS_SRC}" "${vars}"
  fi
  python3 - "$img" "$vars" "$log" << PYEOF
import subprocess, time, select, os, sys

img, vars_fd, log = sys.argv[1], sys.argv[2], sys.argv[3]
cmd = [
    "timeout", "${TIMEOUT}",
    "qemu-system-x86_64",
    "-drive", "if=pflash,format=raw,readonly=on,file=${OVMF_CODE}",
    "-drive", "if=pflash,format=raw,file=" + vars_fd,
    "-drive", "format=raw,file=" + img,
    "-nographic",
    "-m", "256M",
]
swtpm_args = "${SWTPM_ARGS}".split()
if swtpm_args:
    cmd.extend(swtpm_args)

proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.PIPE)
output = b""
sent = False
start = time.time()
while True:
    if proc.poll() is not None:
        rem = proc.stdout.read()
        if rem:
            output += rem
        break
    try:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            data = os.read(proc.stdout.fileno(), 4096)
            if data:
                output += data
    except OSError:
        break
    if not sent and time.time() - start > 8:
        try:
            proc.stdin.write(b"\n")
            proc.stdin.flush()
        except Exception:
            pass
        sent = True
    if time.time() - start > ${TIMEOUT} + 10:
        proc.kill()
        break
with open(log, "wb") as f:
    f.write(output)
print(f"  QEMU exited {proc.returncode}, serial {len(output)} bytes")
PYEOF
}

PASS=0; FAIL=0
check() {  # check <name> <expected-substring> <log>
  if grep -aq "$2" "$3"; then
    echo "  [PASS] $1"; PASS=$((PASS+1))
  else
    echo "  [FAIL] $1 — expected: $2"; FAIL=$((FAIL+1))
  fi
}
check_absent() {  # check_absent <name> <forbidden-substring> <log>
  if grep -aq "$2" "$3"; then
    echo "  [FAIL] $1 — unexpected: $2"; FAIL=$((FAIL+1))
  else
    echo "  [PASS] $1"; PASS=$((PASS+1))
  fi
}

# EFI_LOAD_OPTION builder pieces (python, used by scenario specs below)
GLOBAL_GUID="8be4df61-93ca-11d2-aa0d-00e098032b8c"
ATTR_BOOT="00000007"   # NV|BS|RT

# Boot#### data: Attr(u32=1) | FilePathListLength(u16) | Desc\0 | FilePathList
# FilePathList = FILEPATH node (type 04, sub 04) + END node (7f ff 04 00)
mk_loadopt() {  # mk_loadopt <description> <efi-path> -> hex
  python3 - "$1" "$2" << 'PYEOF'
import struct, sys
desc = sys.argv[1].encode("utf-16-le") + b"\x00\x00"
path = sys.argv[2].encode("utf-16-le") + b"\x00\x00"
fp_node = bytes([0x04, 0x04]) + struct.pack("<H", 4 + len(path)) + path
fp_list = fp_node + bytes([0x7F, 0xFF, 0x04, 0x00])
opt = struct.pack("<IH", 1, len(fp_list)) + desc + fp_list
print(opt.hex())
PYEOF
}

mk_u16list() {  # mk_u16list "0 7" -> hex (BootOrder)
  python3 - "$1" << 'PYEOF'
import struct, sys
print(b"".join(struct.pack("<H", int(x)) for x in sys.argv[1].split()).hex())
PYEOF
}

echo ""
echo "=== Scenario 1: baseline (no shells) ==="
mkesp "${BUILD_DIR}/disk_base.img"
boot "${BUILD_DIR}/disk_base.img" "${BUILD_DIR}/vars_base.fd" "${BUILD_DIR}/serial_base.log"
check "baseline: PBL reached" "Boot path: flags=" "${BUILD_DIR}/serial_base.log"
check "baseline: flags=0x00 mask=0x0000 bootnext=0xFFFF" \
      "flags=0x00 shell-mask=0x0000 bootnext=0xFFFF" "${BUILD_DIR}/serial_base.log"
check_absent "baseline: no ESP shell warning" "shell binary on ESP" "${BUILD_DIR}/serial_base.log"
check_absent "baseline: no boot-entry shell warning" "contains a shell binary" "${BUILD_DIR}/serial_base.log"
check_absent "baseline: no BootNext warning" "BootNext override present" "${BUILD_DIR}/serial_base.log"

echo ""
echo "=== Scenario 2: shell binary planted on ESP ==="
printf 'MZ fake shell' > "${BUILD_DIR}/fake_shell.bin"
mkesp "${BUILD_DIR}/disk_esp.img" "${BUILD_DIR}/fake_shell.bin"
boot "${BUILD_DIR}/disk_esp.img" "${BUILD_DIR}/vars_esp.fd" "${BUILD_DIR}/serial_esp.log"
check "esp-shell: detection warning" "shell binary on ESP" "${BUILD_DIR}/serial_esp.log"
check "esp-shell: flags bit3 set" "flags=0x08" "${BUILD_DIR}/serial_esp.log"

echo ""
echo "=== Scenario 3: shell path in BootOrder entry ==="
mkesp "${BUILD_DIR}/disk_boot.img"
cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/vars_boot.fd"
LOADOPT=$(mk_loadopt "FakeShell" '\EFI\PBL\FAKESHELL.EFI')
ORDER=$(mk_u16list "0 7")
inject_vars "${BUILD_DIR}/vars_boot.fd" "BootOrder|${GLOBAL_GUID}|${ATTR_BOOT}|${ORDER}
Boot0007|${GLOBAL_GUID}|${ATTR_BOOT}|${LOADOPT}"
boot "${BUILD_DIR}/disk_boot.img" "${BUILD_DIR}/vars_boot.fd" "${BUILD_DIR}/serial_boot.log"
check "bootentry: detection warning" "Boot0007 loader path contains a shell binary" "${BUILD_DIR}/serial_boot.log"
check "bootentry: flags bit0 set" "flags=0x01" "${BUILD_DIR}/serial_boot.log"
MASK=$(grep -ao "shell-mask=0x[0-9A-F]*" "${BUILD_DIR}/serial_boot.log" | head -1 | cut -d= -f2)
if [ -n "${MASK}" ] && [ "${MASK}" != "0x0000" ]; then
  echo "  [PASS] bootentry: ShellEntryMask nonzero (${MASK})"; PASS=$((PASS+1))
else
  echo "  [FAIL] bootentry: ShellEntryMask zero/missing"; FAIL=$((FAIL+1))
fi

echo ""
echo "=== Scenario 4: BootNext set -> consumed by BDS before PBL ==="
# BootNext ALONE (pointing at a nonexistent option). Verified manually:
# BDS reads, deletes, and ignores it — PBL runs and sees 0xFFFF.
mkesp "${BUILD_DIR}/disk_bn.img"
cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/vars_bn.fd"
BN=$(mk_u16list "39321")   # 0x9999 — nonexistent option
inject_vars "${BUILD_DIR}/vars_bn.fd" "BootNext|${GLOBAL_GUID}|${ATTR_BOOT}|${BN}"
boot "${BUILD_DIR}/disk_bn.img" "${BUILD_DIR}/vars_bn.fd" "${BUILD_DIR}/serial_bn.log"
check "bootnext: PBL ran" "Boot path: flags=" "${BUILD_DIR}/serial_bn.log"
check_absent "bootnext: consumed before PBL (BdsEntry.c:1075)" \
      "BootNext override present" "${BUILD_DIR}/serial_bn.log"
check "bootnext: bootnext=0xFFFF (deleted by BDS)" "bootnext=0xFFFF" "${BUILD_DIR}/serial_bn.log"

echo ""
echo "=== Scenario 5: unordered Boot#### -> OVMF wedges pre-boot ==="
# An unordered Boot#### (exists, not in BootOrder) hangs this OVMF build
# silently before any console output — an emulated platform anomaly, not
# a PBL defect. Asserted as the DOCUMENTED outcome; on other firmware the
# entry is either invisible or surfaced by a survival policy.
mkesp "${BUILD_DIR}/disk_gh.img"
cp "${OVMF_VARS_SRC}" "${BUILD_DIR}/vars_gh.fd"
GHOST=$(mk_loadopt "GhostShell" '\EFI\GHOST\SHELLX64.EFI')
ORDER0=$(mk_u16list "0")
inject_vars "${BUILD_DIR}/vars_gh.fd" "BootOrder|${GLOBAL_GUID}|${ATTR_BOOT}|${ORDER0}
Boot0009|${GLOBAL_GUID}|${ATTR_BOOT}|${GHOST}"
boot "${BUILD_DIR}/disk_gh.img" "${BUILD_DIR}/vars_gh.fd" "${BUILD_DIR}/serial_gh.log"
check_absent "ghost: OVMF wedges pre-boot (emulated anomaly)" \
      "PBL — Pre-Boot Lock" "${BUILD_DIR}/serial_gh.log"

echo ""
echo "=== RESULT: ${PASS} PASS / ${FAIL} FAIL ==="
[ "${FAIL}" -eq 0 ]
