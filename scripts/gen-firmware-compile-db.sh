#!/usr/bin/env bash
# gen-firmware-compile-db.sh — emit firmware/PblPkg/compile_commands.json so a
# C language server can analyse the PBL sources.
#
# Why (S141): PblApp is EDK II C. Without EDK II's include paths, clangd reports
# `'Uefi.h' file not found`, and every downstream symbol (STATIC, EFI_STATUS,
# EFIAPI) cascades into "unknown type name" errors — 9 blockers for a single
# missing -I. The project builds with build-pbl.sh + EDK II; nothing about the
# source is wrong, the language server just had no compile database.
#
# The generated file is gitignored: it embeds a machine-local EDK II path.
#
# Usage:
#   scripts/gen-firmware-compile-db.sh
#   EDK2_DIR=/path/to/edk2 scripts/gen-firmware-compile-db.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PBL_DIR="$PROJECT_ROOT/firmware/PblPkg"

# Same default as firmware/PblPkg/build-pbl.sh.
EDK2_DIR="${EDK2_DIR:-/home/cllin/.local/src/edk2}"

if [ ! -d "$EDK2_DIR/MdePkg/Include" ]; then
  echo "[FAIL] EDK II not found at $EDK2_DIR (set EDK2_DIR)" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[FAIL] python3 is required to emit the JSON" >&2
  exit 1
fi

python3 - "$PBL_DIR" "$EDK2_DIR" <<'PY'
import json
import sys
from pathlib import Path

pbl_dir = Path(sys.argv[1])
edk2 = Path(sys.argv[2])

includes = [
    edk2 / "MdePkg/Include",
    edk2 / "MdePkg/Include/X64",
    edk2 / "MdeModulePkg/Include",
    edk2 / "ShellPkg/Include",
    edk2 / "NetworkPkg/Include",
    edk2 / "CryptoPkg/Include",
    pbl_dir / "PblApp",
]

# EDK II materialises PCDs per module into a generated AutoGen.h during the
# build, so FixedPcdGet32(PcdPblVersion) etc. cannot resolve without one. Use
# the newest build tree if build-pbl.sh has been run; otherwise warn (the
# sources are still analysed, only PCD symbols will be unresolved).
# EDK II nests generated headers as Build/<Pkg>/<BUILD>/<ARCH>/<Pkg>/<Module>/<Module>/DEBUG/AutoGen.h
# so match anywhere under the package build root and keep the PblApp ones.
autogen = sorted(
    (
        p
        for p in (list(pbl_dir.glob("Build/**/AutoGen.h")) + list(edk2.glob("Build/PblPkg/**/AutoGen.h")))
        if "PblApp" in p.parts
    ),
    key=lambda p: p.stat().st_mtime,
)
if autogen:
    autogen_h = autogen[-1]
    flags_extra = ["-include", str(autogen_h)]
    includes.append(autogen_h.parent)
else:
    flags_extra = []
    print(
        "note: no EDK II AutoGen.h for PblApp found — PCD macros "
        "(FixedPcdGet*, PcdPbl*) will stay unresolved. Run "
        "firmware/PblPkg/build-pbl.sh once for full fidelity.",
        file=sys.stderr,
    )

flags = ["-D", "MDE_CPU_X64", "-std=gnu11", "-ffreestanding", "-fshort-wchar", "-Wall", *flags_extra]
for inc in includes:
    flags += ["-I", str(inc)]

entries = []
for src in sorted(pbl_dir.glob("PblApp/*.c")):
    entries.append(
        {
            "directory": str(pbl_dir),
            "file": str(src),
            "arguments": ["gcc", *flags, "-c", str(src)],
        }
    )

out = pbl_dir / "compile_commands.json"
out.write_text(json.dumps(entries, indent=2) + "\n")
print(f"wrote {out} ({len(entries)} translation units)")
PY
