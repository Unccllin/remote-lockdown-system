# Vendored EDK II TPM headers

`IndustryStandard/Tpm12.h` and `IndustryStandard/Tpm20.h` are **verbatim copies** of
`MdePkg/Include/IndustryStandard/` from EDK II (SPDX-License-Identifier: BSD-2-Clause-Patent),
checked in so the host-side TPM command-buffer tests can compile with nothing but a C99
compiler — the promise `run-host-tests.sh` already made for the CBOR parsing tests (D-117).

They are byte-identical to upstream on purpose: `run-host-tests.sh` compares them with `cmp`
against `${EDK2_DIR:-$HOME/.local/src/edk2}` when that checkout exists and **fails** on any
difference, so the vendored copy cannot drift from the headers the firmware actually builds
against. When the checkout is absent the check prints a notice instead — the host tests still
run, they just cannot re-verify the copy that day.

Re-sync after an EDK II update:

```bash
EDK2_DIR="${EDK2_DIR:-$HOME/.local/src/edk2}"
cp "$EDK2_DIR/MdePkg/Include/IndustryStandard/Tpm12.h" \
   "$EDK2_DIR/MdePkg/Include/IndustryStandard/Tpm20.h" \
   firmware/PblPkg/host-tests/vendor/IndustryStandard/
```

Why not generate the needed subset instead (the way `extract-decls.py` lifts the parsed structs
out of `PblApp.h`)? Because the risk here is the opposite one. `PblApp.h` is *our* header, so a
copy of it can silently describe a shape our code no longer has — that is what generating from
the real file prevents. `Tpm20.h` is the *TCG's* wire format: the danger is a hand-picked subset
carrying a transcribed-wrong constant (say `TPM_CC_NV_Write`), which would make a byte-level test
assert the wrong value and pass while the firmware was wrong. Vendoring the whole upstream file
removes transcription entirely; the `cmp` drift check removes staleness.
