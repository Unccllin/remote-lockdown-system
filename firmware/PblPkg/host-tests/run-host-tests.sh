#!/usr/bin/env bash
# Host-side unit tests for the PBL parsing modules (D-117).
#
# These run on the build host with any C99 compiler — no EDK II checkout, no
# QEMU, no swtpm, no Docker. That is the gap D-117 named: before this, the only
# verification for individual modules was `-Werror` compilation plus one QEMU
# end-to-end boot, so a CBOR parsing regression was only visible as "the whole
# boot flow broke".
#
# What is covered here: CborDecode.c's public API — verdict parsing, policy
# parsing, COSE_Sign1 envelope extraction, protected-header parsing, and the
# malformed-input paths. What is NOT covered (and is still open in D-224): TPM
# command buffer construction and COSE signature verification with test keys.
#
# Usage: ./run-host-tests.sh [--verbose]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pbl="$here/.."
build="$here/build"
cc="${CC:-cc}"

verbose=""
if [[ "${1:-}" == "--verbose" ]]; then
  verbose="-v"
fi

rm -rf "$build"
mkdir -p "$build"

# 1. Lift the parsed structs out of the real firmware header (single source of truth)
#    into include/ so an editor/clangd resolving this directory also sees it.
python3 "$here/extract-decls.py" "$pbl/PblApp/PblApp.h" >"$here/include/pbl_decls.generated.h"

# 2. CborDecode.c includes "PblApp.h". A quoted include finds the *including
#    file's* directory first, so the shim cannot win by -I ordering alone — the
#    source is compiled from a copy in the build directory with -Iinclude first.
cp "$pbl/PblApp/CborDecode.c" "$build/CborDecode.c"

"$cc" -std=c99 -Wall -Wextra -Werror -Wno-unused-parameter \
  -I "$here/include" -I "$build" \
  "$build/CborDecode.c" "$here/host_efi.c" "$here/test_cbor_decode.c" \
  -o "$build/test_cbor_decode"

"$build/test_cbor_decode" $verbose
