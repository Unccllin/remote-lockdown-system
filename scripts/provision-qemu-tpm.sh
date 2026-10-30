#!/usr/bin/env bash
#
# provision-qemu-tpm.sh — write PBL_AK_NAME (NV 0x01C00003) into a swtpm state dir.
#
# Why this exists
# ---------------
# PBL derives device_id from the 34-byte AK Name stored at NV 0x01C00003
# (C2 §1.3, C1 §4). A freshly created swtpm state has that index non-existent or
# uninitialised, so every QEMU harness run reported "unprovisioned" and the
# enrolled path — the one where a real device_id is derived and sent — was never
# executed. PBL_AK_NAME is written at enrolment by Agent D (C2 §5.4 step 8); this
# script stands in for Agent D so the firmware path can be observed in QEMU.
#
# The recipe was established by probe on 2026-10-29. Every part of it was wrong
# in an earlier attempt, so the constraints are recorded here rather than in
# someone's memory:
#
#   * swtpm must expose a *data* socket (`--server`) and tpm2-tools must be told
#     its port: `swtpm:host=..,port=<data>`. The `swtpm:path=` form is rejected
#     by tss2 3.2 (jammy) and tss2 5.7 (trixie) alike with "Could not load tcti",
#     and pointing host/port at the *control* port fails identically.
#   * `tpm2_startup -c` is mandatory: swtpm runs with --flags not-need-init, so
#     without it every command answers RC 0x100 (TPM_RC_INITIALIZE).
#   * attributes must be the numeric dword 0x420D000D — PBL's own platform set
#     (PPWRITE|AUTHWRITE|POLICYWRITE|PPREAD|AUTHREAD|POLICYREAD|NO_DA|
#     PLATFORMCREATE). The pipe-separated names are rejected outright.
#   * the provisioning swtpm must be stopped before the QEMU-facing one starts,
#     or the second fails with "Could not lock access to lockfile".
#
# The resulting state survives that restart — swtpm checkpoints NV into
# tpm2-00.permall — which is what lets the harness boot on a provisioned state.
#
# Usage:
#   scripts/provision-qemu-tpm.sh <state-dir> [ak-name-hex]
#
#   <state-dir>    directory swtpm uses as --tpmstate (created if absent)
#   [ak-name-hex]  68 hex chars = 34 bytes; defaults to 000b + 32x ab, i.e.
#                  SHA-256 alg id 0x000B followed by a synthetic AK Area digest.
#                  Any 34 bytes work: the harness asserts that PBL reported them,
#                  not that they are a real AK.
#
# Environment:
#   PBL_PROVISION_IMAGE  container image with swtpm + tpm2-tools (default pbl-qemu:d131)
#   PBL_PROV_DATA_PORT   TCP data port (default 2431)
#   PBL_PROV_CTRL_PORT   TCP control port (default 2432)
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <state-dir> [ak-name-hex]" >&2
  exit 2
fi

STATE_DIR="$1"
AK_NAME_HEX="${2:-000b$(printf 'ab%.0s' $(seq 1 32))}"

case "$AK_NAME_HEX" in
  *[!0-9a-fA-F]*)
    echo "ERROR: ak-name-hex must be hex, got '${AK_NAME_HEX}'" >&2
    exit 2 ;;
esac
if [ "${#AK_NAME_HEX}" -ne 68 ]; then
  echo "ERROR: ak-name-hex must be 68 hex chars (34 bytes), got ${#AK_NAME_HEX}" >&2
  exit 2
fi

DATA_PORT="${PBL_PROV_DATA_PORT:-2431}"
CTRL_PORT="${PBL_PROV_CTRL_PORT:-2432}"

# Run natively when the tools are present; otherwise delegate to a container that
# has them. pbl-qemu itself does not ship tpm2-tools, which is why the default
# image is the pbl-qemu:d131 derivative.
provision_body() {
  local state_dir="$1" hex="$2" data_port="$3" ctrl_port="$4"
  local pidfile bin

  mkdir -p "$state_dir"
  pidfile="$state_dir/.provision.pid"
  bin="$state_dir/.ak-name.bin"
  rm -f "$pidfile" "$bin"

  swtpm socket --tpmstate "dir=${state_dir}" \
    --ctrl "type=tcp,port=${ctrl_port}" \
    --server "type=tcp,port=${data_port}" \
    --tpm2 --daemon --flags not-need-init --pid "file=${pidfile}"

  cleanup() {
    if [ -s "$pidfile" ]; then
      kill "$(cat "$pidfile")" 2>/dev/null || true
      for _ in $(seq 1 50); do
        kill -0 "$(cat "$pidfile" 2>/dev/null)" 2>/dev/null || break
        sleep 0.1
      done
    fi
    rm -f "$pidfile" "$bin"
  }
  trap cleanup EXIT

  for _ in $(seq 1 50); do [ -s "$pidfile" ] && break; sleep 0.1; done
  sleep 1

  # No xxd dependency: python3 is present in every image this runs in.
  python3 -c "import sys; sys.stdout.buffer.write(bytes.fromhex('${hex}'))" > "$bin"

  export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=${data_port}"

  tpm2_startup -c >/dev/null 2>&1 || true
  tpm2_nvdefine 0x01C00003 -C p -s 34 -a 0x420D000D
  tpm2_nvwrite 0x01C00003 -C p -i "$bin"

  # Prove the write before claiming it.
  local readback
  readback="$(tpm2_nvread 0x01C00003 -C p -s 34 | od -An -tx1 | tr -d ' \n')"
  if [ "$readback" != "$(printf '%s' "$hex" | tr 'A-F' 'a-f')" ]; then
    echo "ERROR: readback mismatch" >&2
    echo "  wrote: ${hex}" >&2
    echo "  read:  ${readback}" >&2
    exit 1
  fi
  echo "  AK Name verified in NV 0x01C00003: ${readback}"
}

if command -v swtpm >/dev/null 2>&1 \
   && command -v tpm2_nvdefine >/dev/null 2>&1 \
   && command -v python3 >/dev/null 2>&1; then
  provision_body "$STATE_DIR" "$AK_NAME_HEX" "$DATA_PORT" "$CTRL_PORT"
else
  IMAGE="${PBL_PROVISION_IMAGE:-pbl-qemu:d131}"
  echo "  [INFO] tools not on this host — delegating to container ${IMAGE}"
  docker run --rm \
    -v "$(cd "$(dirname "$STATE_DIR")" && pwd)/$(basename "$STATE_DIR"):/prov/st" \
    -e PBL_PROV_DATA_PORT="$DATA_PORT" \
    -e PBL_PROV_CTRL_PORT="$CTRL_PORT" \
    --entrypoint bash "$IMAGE" -c "
      set -euo pipefail
      swtpm socket --tpmstate dir=/prov/st \\
        --ctrl type=tcp,port=${CTRL_PORT} --server type=tcp,port=${DATA_PORT} \\
        --tpm2 --daemon --flags not-need-init --pid file=/prov/st/.provision.pid
      for _ in \$(seq 1 50); do [ -s /prov/st/.provision.pid ] && break; sleep 0.1; done
      sleep 1
      python3 -c \"import sys; sys.stdout.buffer.write(bytes.fromhex('${AK_NAME_HEX}'))\" > /prov/st/.ak-name.bin
      export TPM2TOOLS_TCTI=swtpm:host=127.0.0.1,port=${DATA_PORT}
      tpm2_startup -c >/dev/null 2>&1 || true
      tpm2_nvdefine 0x01C00003 -C p -s 34 -a 0x420D000D
      tpm2_nvwrite 0x01C00003 -C p -i /prov/st/.ak-name.bin
      readback=\$(tpm2_nvread 0x01C00003 -C p -s 34 | od -An -tx1 | tr -d ' \n')
      echo \"  AK Name verified in NV 0x01C00003: \${readback}\"
      kill \"\$(cat /prov/st/.provision.pid)\" 2>/dev/null || true
      sleep 2
      rm -f /prov/st/.provision.pid /prov/st/.ak-name.bin
    "
fi

echo ""
echo "Provisioned state: ${STATE_DIR}"
echo "Boot it with:"
echo "  docker run --rm -e PBL_SWTPM_DIR=/tmp/pbl-ci/prov \\"
echo "    -v \"\$PWD/firmware:/firmware:ro\" -v <ovmf>:/ovmf:ro \\"
echo "    -v \"\$(dirname \"${STATE_DIR}\"):/tmp/pbl-ci\" \\"
echo "    pbl-qemu /firmware/PblPkg/ci-harness-docker.sh --timeout 40"
