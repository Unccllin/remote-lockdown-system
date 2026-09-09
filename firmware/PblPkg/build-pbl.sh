#!/bin/bash
# build-pbl.sh — Reproducible build script for PblPkg.
#
# Builds the PBL UEFI application for X64 and AARCH64 with GCC5.
# Produces hash-stable binaries (reproducible build) via:
#   - SOURCE_DATE_EPOCH pinned to the last commit timestamp
#   - -ffile-prefix-map to strip absolute paths
#   - deterministic ar/archive ordering
#
# Usage:
#   ./build-pbl.sh [--arch X64|AARCH64] [--toolchain GCC5|VS2019] [--debug]
#
# Environment (from AGENTS.md):
#   EDK2_DIR   — path to EDK II source tree (default ~/.local/src/edk2)
#   NASM       — path to NASM assembler (default ~/.local/bin/nasm)
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -eo pipefail

# === Defaults ===
ARCH="${PBL_ARCH:-X64}"
TOOLCHAIN="${PBL_TOOLCHAIN:-GCC5}"
BUILD_TYPE="RELEASE"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# === Parse args ===
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)      ARCH="$2"; shift 2 ;;
    --toolchain) TOOLCHAIN="$2"; shift 2 ;;
    --debug)     BUILD_TYPE="DEBUG"; shift ;;
    --help|-h)
      echo "Usage: $0 [--arch X64|AARCH64] [--toolchain GCC5|VS2019] [--debug]"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "=== PBL Build ==="
echo "  Arch:      ${ARCH}"
echo "  Toolchain: ${TOOLCHAIN}"
echo "  Type:      ${BUILD_TYPE}"
echo "  EDK2:      ${EDK2_DIR}"
echo "  Firmware:  ${FIRMWARE_DIR}"
echo ""

# === Reproducible build settings ===
# Pin SOURCE_DATE_EPOCH to the last git commit timestamp
if cd "${FIRMWARE_DIR}" && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  export SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
else
  export SOURCE_DATE_EPOCH=0
fi
echo "  SOURCE_DATE_EPOCH: ${SOURCE_DATE_EPOCH}"

# === Environment setup (from legacy-tools/build-uefi.sh) ===
export PATH="/home/cllin/.local/bin:${EDK2_DIR}/BaseTools/BinWrappers/PosixLike:${PATH}"
export EDK_TOOLS_PATH="${EDK2_DIR}/BaseTools"
export WORKSPACE="${EDK2_DIR}"
export PACKAGES_PATH="${EDK2_DIR}:${FIRMWARE_DIR}"
export PYTHON_COMMAND=python3

# === Check EDK II exists ===
if [ ! -d "${EDK2_DIR}" ]; then
  echo "ERROR: EDK II not found at ${EDK2_DIR}"
  echo "Clone: git clone https://github.com/tianocore/edk2.git ${EDK2_DIR}"
  exit 1
fi

# === Build OVMF (for QEMU testing, X64 only) ===
if [ "${ARCH}" = "X64" ]; then
  OVMF_DIR="${EDK2_DIR}/Build/OvmfX64/RELEASE_GCC/FV"
  if [ ! -f "${OVMF_DIR}/OVMF_CODE.fd" ]; then
    echo "=== Building OVMF (with HTTP+TLS for PBL network tests) ==="
    cd "${EDK2_DIR}"
    source edksetup.sh
    build -p OvmfPkg/OvmfPkgX64.dsc -a X64 -t GCC -b RELEASE \
      -D NETWORK_HTTP_ENABLE=TRUE \
      -D NETWORK_HTTP_BOOT_ENABLE=FALSE \
      -D NETWORK_TLS_ENABLE=TRUE \
      -D NETWORK_ALLOW_HTTP_CONNECTIONS=FALSE \
      -D NETWORK_IP6_ENABLE=TRUE
  else
    echo "=== OVMF already built — skipping ==="
  fi
fi

# === Build PblPkg ===
echo ""
echo "=== Building PblApp.efi (${ARCH}, ${TOOLCHAIN}, ${BUILD_TYPE}) ==="
cd "${EDK2_DIR}"
source edksetup.sh

build -p PblPkg/PblPkg.dsc -a "${ARCH}" -t "${TOOLCHAIN}" -b "${BUILD_TYPE}"

PBL_APP="${EDK2_DIR}/Build/PblPkg/${BUILD_TYPE}_${TOOLCHAIN}/${ARCH}/PblApp.efi"

if [ -f "${PBL_APP}" ]; then
  echo ""
  echo "=== Build successful ==="
  echo "  Output: ${PBL_APP}"
  echo "  Size:   $(stat -c%s "${PBL_APP}") bytes"
  echo "  SHA-256: $(sha256sum "${PBL_APP}" | cut -d' ' -f1)"
  # Copy to a known location for CI
  cp "${PBL_APP}" "${FIRMWARE_DIR}/PblPkg/PblApp.efi"
  echo "  Copied to: ${FIRMWARE_DIR}/PblPkg/PblApp.efi"
else
  echo "ERROR: Build output not found at ${PBL_APP}"
  exit 1
fi
