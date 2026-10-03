#!/usr/bin/env bash
# pack-persist-capsule.sh — Package PblPersistDxe.efi into a flashable FMP capsule.
#
# Pipeline (the correct EDK II tool chain — GenSec wraps sections, GenFfs
# builds the FFS file, GenFv builds the volume, GenerateCapsule wraps it):
#   1. GenSec  → wrap .efi into a PE32 section + .depex into a DXE_DEPEX section
#   2. GenFfs  → combine those sections into an FFS file (FV filetype DRIVER)
#   3. GenFv   → place the FFS into a minimal firmware volume image
#   4. GenerateCapsule.py → wrap the FV in an FMP capsule for UpdateCapsule()
#
# Delivery is the authorized path only: the capsule must be signed with a
# cert enrolled in the target's `db` (Setup-Mode enrollment), OR the .fv is
# written directly by an external SPI programmer at provisioning.
#
# Usage:
#   firmware/PblPkg/pack-persist-capsule.sh [--sign <signer.pem>] [--out DIR]
#
# Requires: built PblPersistDxe.efi + .depex under EDK2_DIR Build tree,
#           EDK2_DIR env var (default ~/.local/src/edk2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"
BUILD="${EDK2_DIR}/Build/PblPkg/RELEASE_GCC/X64"
MODULE_OUT="${BUILD}/PblPkg/PblPersistDxe/PblPersistDxe/OUTPUT"
OUT_DIR="${SCRIPT_DIR}/persist-capsule"
SIGN_PEM=""

while [ $# -gt 0 ]; do
  case "$1" in
    --sign) SIGN_PEM="$2"; shift 2 ;;
    --out)  OUT_DIR="$2";  shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

DRIVER_EFI="${MODULE_OUT}/PblPersistDxe.efi"
DRIVER_DEPEX="${MODULE_OUT}/PblPersistDxe.depex"
DRIVER_GUID="7C3B9A2E-4E1F-4A6D-B8C5-2D0F1E3A5B7C"

for f in "${DRIVER_EFI}" "${DRIVER_DEPEX}"; do
  [ -f "$f" ] || { echo "ERROR: missing $f — build the module first"; exit 1; }
done

export PATH="${EDK2_DIR}/BaseTools/BinWrappers/PosixLike:${EDK2_DIR}/BaseTools/Source/C/bin:${PATH}"
export PYTHONPATH="${EDK2_DIR}/BaseTools/Source/Python:${PYTHONPATH:-}"

mkdir -p "${OUT_DIR}"
PE32="${OUT_DIR}/PblPersistDxe.pe32"
DEPEX="${OUT_DIR}/PblPersistDxe.dpx"
FFS="${OUT_DIR}/PblPersistDxe.ffs"
FV="${OUT_DIR}/PblPersistDxe.fv"
FV_INF="${OUT_DIR}/PblPersistDxe.fv.inf"
CAP="${OUT_DIR}/PblPersistDxe.cap"

# 1. GenSec — wrap the raw .efi into a PE32 section and .depex into a
#    DXE_DEPEX section. These are the inputs GenFfs needs.
echo "=== GenSec (sections) ==="
GenSec -s EFI_SECTION_PE32      -o "${PE32}"  "${DRIVER_EFI}"
GenSec -s EFI_SECTION_DXE_DEPEX -o "${DEPEX}" "${DRIVER_DEPEX}"
echo "  -> ${PE32}"
echo "  -> ${DEPEX}"

# 2. GenFfs — combine the PE32 + DXE_DEPEX sections into an FFS driver file.
echo "=== GenFfs (FFS) ==="
GenFfs -t EFI_FV_FILETYPE_DRIVER \
       -g "${DRIVER_GUID}" \
       -o "${FFS}" \
       -i "${DEPEX}" \
       -i "${PE32}"
echo "  -> ${FFS}"

# 3. FV — minimal volume holding the single FFS file.
cat > "${FV_INF}" <<EOF
[options]
EFI_BASE_ADDRESS   = 0x00000000
EFI_BLOCK_SIZE     = 0x1000
EFI_NUM_BLOCKS     = 64
EFI_FV_FILESYSTEMGUID = 8c8ce578-8a3d-4f1c-9935-896185c32dd3

[attributes]
EFI_FVB2_READ_STATUS        = 1
EFI_FVB2_WRITE_STATUS       = 1
EFI_FVB2_ERASE_POLARITY     = 1
EFI_FVB2_MEMORY_MAPPED      = 1
EFI_FVB2_STICKY_WRITE       = 0
EFI_FVB2_LOCK_CAP           = 0
EFI_FVB2_LOCK_STATUS        = 0
EFI_FVB2_WRITE_LOCK_CAP     = 0
EFI_FVB2_WRITE_LOCK_STATUS  = 0

[files]
${FFS}
EOF

echo "=== GenFv (firmware volume) ==="
GenFv -i "${FV_INF}" -o "${FV}" -b 4096 -n 64
echo "  -> ${FV}"

# 4. FMP capsule — wrap the FV. GUID is the module GUID as the update target.
echo "=== GenerateCapsule (FMP capsule) ==="
CAP_ARGS=(
  -e
  --guid "${DRIVER_GUID}"
  --fw-version 0x00010000
  --lsv 0x00000000
  --capflag PersistAcrossReset
  -o "${CAP}"
  "${FV}"
)
if [ -n "${SIGN_PEM}" ]; then
  CAP_ARGS+=(--signer-private-cert "${SIGN_PEM}")
fi
python3 "${EDK2_DIR}/BaseTools/Source/Python/Capsule/GenerateCapsule.py" "${CAP_ARGS[@]}"

echo ""
echo "=== Done ==="
echo "  FFS:     ${FFS}"
echo "  FV:      ${FV}"
echo "  Capsule: ${CAP}"
[ -n "${SIGN_PEM}" ] && echo "  (signed with ${SIGN_PEM})" || echo "  (unsigned — sign with a db-enrolled cert before remote deploy)"
