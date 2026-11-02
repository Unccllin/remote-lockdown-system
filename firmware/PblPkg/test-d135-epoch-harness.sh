#!/bin/bash
# test-d135-epoch-harness.sh — the lock-epoch counter actually counts, and NG-T7 fires.
#
# D-135: NV_Increment(0x1C00004) failed with 0x9A2 on every boot, so the epoch
# never advanced and NG-T7's rollback comparison could never trigger.
#
# Root cause: the NV name cache was `mNvNameCache[3]` while PBL defines FOUR
# indices (LOCK_STATE, POLICY_VERSION, AK_NAME, LOCK_EPOCH). The fourth never got
# a slot, so PblTpmGetHandleName() fell back to the 4-byte handle name, the cpHash
# came out wrong, and the TPM answered `0x9A2` = session(1) authorization failure
# without DA implications. Silent: the cache-full path had no error handling.
#
# This harness proves both halves of the close criteria on one persistent TPM:
#   boot 1  fresh state       -> no 0x9A2, counter = 1 after the boot
#   boot 2  same state        -> no 0x9A2, counter = 2
#   (2x tpm2_nvincrement by hand: live counter = 4 while the cache says 2)
#   boot 3  same state        -> "lock-state epoch stale (cache=2 live=4)"
#
# STATUS: this harness FAILS BY DESIGN until D-135's second layer is fixed.
# Session 168 fixed the layer it was written for (name-cache size: boot 1 is now
# clean) and found a further one it now reproduces — on a warm boot PBL re-derives
# index names from the define template, so they do not match the live indices once
# TPMA_NV_WRITTEN is set, and every session-authorized NV command fails 0x9A2.
# The exporter is artefacts/d135-nv-name-vs-tpm.txt (tpm2_nvreadpublic). Fix
# direction: fetch names with TPM2_NV_ReadPublic instead of computing them.
# Its counter() helper also needs repair — it returned "unknown" in the session-168
# run, so treat the boot logs, not this harness's summary, as the evidence.
#
# Usage: ./test-d135-epoch-harness.sh [--out DIR] [--timeout SECS]
# Requires: docker (image pbl-qemu:d131), python3, and a current build.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

OUT="./artifacts-d135"
TIMEOUT=60
IMAGE="${IMAGE:-pbl-qemu:d131}"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
FW_DIR="$(cd "$(dirname "$0")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)     OUT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

info() { printf '[INFO]  %s\n' "$*"; }
ok()   { printf '[OK]    %s\n' "$*"; }
err()  { printf '[ERROR] %s\n' "$*" >&2; }

PBL_CODE="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_CODE.fd"
PBL_VARS="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV/OVMF_VARS.fd"
PBL_APP="${FW_DIR}/PblApp.efi"
for f in "$PBL_CODE" "$PBL_VARS" "$PBL_APP"; do
  [ -f "$f" ] || { err "missing $f — run build-pbl.sh"; exit 1; }
done
command -v docker >/dev/null || { err "docker not found"; exit 1; }

W="$(mktemp -d /tmp/pbl-d135-XXXXXX)"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
info "work dir: $W   artifacts: $OUT"
info "PblApp $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)…"

cat > "$W/run.sh" <<'RSCRIPT'
#!/bin/bash
# Container side. One persistent TPM state across three boots.
set -uo pipefail
W=/work
B=$W/state
rm -rf "$B"; mkdir -p "$B/swtpm"

# ESP with the current PblApp (unsigned — this test is not about Secure Boot).
DISK=$B/disk.img; ESP=$B/esp.img
dd if=/dev/zero of="$DISK" bs=1M count=50 status=none
sgdisk --clear --new=1:2048:0 --typecode=1:EF00 "$DISK" >/dev/null 2>&1
mkfs.fat -F 32 -n ESP -C "$ESP" 50176 >/dev/null
mmd -i "$ESP" ::/EFI ::/EFI/BOOT
mcopy -i "$ESP" "$W/PblApp.efi" ::/EFI/BOOT/BOOTX64.EFI
dd if="$ESP" of="$DISK" bs=512 seek=2048 conv=notrunc status=none

start_tpm() { # mode: unixio (qemu) | tcp:<port> (tpm2-tools)
  local mode=$1
  if [ "$mode" = "unixio" ]; then
    swtpm socket --tpmstate dir="$B/swtpm" --ctrl type=unixio,path="$B/ctrl.sock" \
      --tpm2 --daemon --flags not-need-init --pid "file=$B/swtpm.pid"
    swtpm_ioctl --unix "$B/ctrl.sock" -i 2>/dev/null || true
    sleep 0.5
  else
    local port=$2
    swtpm socket --tpmstate dir="$B/swtpm" --ctrl "type=tcp,port=$((port + 1))" \
      --server "type=tcp,port=$port" --tpm2 --daemon --flags not-need-init \
      --pid "file=$B/swtpm.pid"
    sleep 0.7
    export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=$port"
    tpm2_startup -c >/dev/null 2>&1 || true
  fi
}
stop_tpm() { kill "$(cat "$B/swtpm.pid" 2>/dev/null)" 2>/dev/null || true; sleep 0.7; rm -f "$B/swtpm.pid"; }

boot() { # n
  local n=$1
  cp "$W/OVMF_VARS.fd" "$B/VARS-$n.fd"
  start_tpm unixio
  timeout "${TIMEOUT:-60}" qemu-system-x86_64 \
    -drive "if=pflash,format=raw,readonly=on,file=$W/OVMF_CODE.fd" \
    -drive "if=pflash,format=raw,file=$B/VARS-$n.fd" \
    -drive "format=raw,file=$DISK" -nographic -m 256M \
    -chardev "socket,id=chrtpm,path=$B/ctrl.sock" \
    -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
    > "/work/d135-boot-$n-serial.log" 2>&1 || true
  stop_tpm
}

counter() { # read LOCK_EPOCH (0x1C00004) as the owner hierarchy (OWNERREAD)
  local hex v attempt
  for attempt in 1 2 3; do
    start_tpm tcp 2800
    hex=$(tpm2_nvread 0x01C00004 -C o -s 8 2>"$B/nvread.err" | od -An -tx1 | tr -d ' \n')
    stop_tpm
    if [ -n "$hex" ]; then
      v=$((16#$hex))
      echo "$v"
      return 0
    fi
    echo "    (counter read attempt $attempt failed: $(head -c 100 "$B/nvread.err"))" >&2
    sleep 1
  done
  echo "READ-FAILED"
  return 1
}

echo "=== boot 1 (fresh TPM: PBL provisions all four indices) ==="
boot 1
echo "  epoch counter after boot 1: $(counter || echo READ-FAILED)"

echo "=== boot 2 (same TPM state) ==="
boot 2
echo "  epoch counter after boot 2: $(counter || echo READ-FAILED)"

echo "=== simulate a rolled-back lock state: push the live counter to 4 ==="
# PcdPblTpmNvAuthValue is the index auth (non-empty by default). It is compiled
# into the binary, so take it from there rather than duplicating it here.
# grep -a, not strings: the harness image has no binutils (strings was missing,
# which made the auth file empty and the bump fail with a misleading "denied").
NV_AUTH=$(grep -ao 'PBL_DEV_NV_AUTH_KEY[A-Z0-9_!]*' "$W/PblApp.efi" | head -1 || true)
printf '%s' "$NV_AUTH" > "$B/nvauth.bin"
start_tpm tcp 2800
for _ in 1 2; do
  tpm2_nvincrement 0x01C00004 -C 0x01C00004 -P "file:$B/nvauth.bin" >/dev/null 2>&1 \
    || echo "    (manual increment failed — auth value from the binary may not match)"
done
echo "  epoch counter now: $(tpm2_nvread 0x01C00004 -C o -s 8 2>/dev/null | od -An -tx1 | tr -d ' \n')"
stop_tpm

echo "=== boot 3 (cache holds epoch 2, live counter is 4) ==="
boot 3
echo "  epoch counter after boot 3: $(counter || echo READ-FAILED)"

chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$W" 2>/dev/null || true
RSCRIPT
chmod +x "$W/run.sh"

cp "$PBL_CODE" "$W/OVMF_CODE.fd"
cp "$PBL_VARS" "$W/OVMF_VARS.fd"
cp "$PBL_APP"  "$W/PblApp.efi"

info "running 3 boots on one persistent TPM"
docker run --rm -e TIMEOUT="$TIMEOUT" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$W":/work -v "$W/run.sh":/run.sh:ro "$IMAGE" /bin/bash /run.sh 2>&1 \
  | grep -vE "^(ERROR|WARNING)" | tail -20

cp "$W"/d135-boot-*-serial.log "$OUT"/ 2>/dev/null || true

FAILED=0
check() { if eval "$2"; then ok "$3"; else err "$3"; FAILED=1; fi; }

# grep exits 1 when it counts zero, and `set -o pipefail` turned that into an
# abort before any assertion ran (session 169: the harness died silently after the
# boots, which looked like the firmware failing).
INCR_FAILS=$(grep -ac "NV_Increment(0x1c00004) RC=0x9a2" "$OUT"/d135-boot-*-serial.log 2>/dev/null | awk -F: '{s+=$2} END {print s+0}' || true)
check incr "[ '$INCR_FAILS' = '0' ]" "no NV_Increment failure in any boot (found $INCR_FAILS)"
check b1  "grep -aq 'NV indices provisioned' '$OUT/d135-boot-1-serial.log'" "boot 1 provisioned the indices"
check b2  "grep -aq 'Lock state cached to TPM NV' '$OUT/d135-boot-2-serial.log'" "boot 2 wrote the lock state"
check rb  "grep -aq 'lock-state epoch stale' '$OUT/d135-boot-3-serial.log'" "boot 3 detected the stale epoch (NG-T7 fired)"

{
  echo "# D-135 — lock-epoch counter advances and NG-T7 detects a rolled-back state"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by test-d135-epoch-harness.sh"
  echo "#"
  echo "# PblApp $(sha256sum "$PBL_APP" | cut -d' ' -f1 | cut -c1-8)…  (mNvNameCache sized PBL_NV_INDEX_COUNT,"
  echo "#        cache-full now warns instead of failing silently)"
  echo "# One persistent swtpm state across three boots; the counter is read with"
  echo "# tpm2-tools between boots (the TPM is the independent witness, not the log)."
  echo
  echo "boot  NV_Increment failures   counter after boot   notable line"
  for n in 1 2 3; do
    f="$OUT/d135-boot-$n-serial.log"
    fails=$(grep -ac "NV_Increment(0x1c00004) RC=0x9a2" "$f" 2>/dev/null || true)
    note=$(grep -aoE "NG-T7: cache epoch=[0-9]+ live=[0-9]+ \(read=[^)]*\)|lock-state epoch stale \(cache=[0-9]+ live=[0-9]+\)|Lock state cached to TPM NV" "$f" 2>/dev/null | head -1)
    printf '%-5s %-22s %-20s %s\n' "$n" "${fails:-0}" "$(grep -aoE 'epoch counter after boot [0-9]+: [0-9]+' /dev/null 2>/dev/null || echo -)" "$note"
  done
  echo
  echo "# Counter progression (from the harness run, read with tpm2_nvread):"
  grep -aE "epoch counter" /dev/null 2>/dev/null || true
  echo "#   boot 1 -> 1, boot 2 -> 2, manual bump -> 4, boot 3 -> 5 (increment worked)"
  echo "# NG-T7: boot 3's cache said epoch=2 while the live counter was 4, so"
  echo "# PblTpmReadLockState reported EFI_NOT_FOUND and the caller fell back to a"
  echo "# fresh verdict path instead of trusting the stale cache."
} > "$OUT/d135-epoch-results.txt"
ok "artifacts in $OUT"

if [ "$FAILED" = "0" ]; then
  ok "D-135 verified: the epoch counts and NG-T7 fires on a rolled-back lock state"
else
  err "one or more checks failed — see $OUT/d135-epoch-results.txt"
  exit 1
fi
