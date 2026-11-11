#!/usr/bin/env python3
"""Extract what the host tests need from the real firmware headers.

The host test build must not keep its own copy of `PBL_VERDICT`, `PBL_LOCK_STATE_CACHE`,
the `PBL_NV_*` index macros, or the prototypes it calls: a copy compiles happily after
the firmware header renames a field, moves an NV index, or changes a parameter, so the
host tests would keep passing while the code they test changed shape. Instead everything
is lifted from `PblApp.h` at build time — one source of truth, and any drift is a loud
build failure.

Three things are lifted:

  * struct typedefs  (`STRUCTS`)  — by name, sliced from the nearest `typedef struct`
  * object-like macros (`MACRO_PREFIX`) — every `#define PBL_...` without a parameter list
  * function prototypes (`PROTOS`) — return type through the closing `);`

Usage: extract-decls.py <PblApp.h> > pbl_decls.generated.h
"""

import re
import sys

# Order matters: PBL_POLICY embeds the three smaller structs by value.
STRUCTS = [
    "PBL_POLICY_META",
    "PBL_TPM_SESSION_REQ",
    "PBL_OVERRIDE_RATE_LIMIT",
    "PBL_VERDICT",
    "PBL_POLICY",
    "PBL_LOCK_STATE_CACHE",
    "PBL_TPM_SESSION",
]

# Object-like macros with this prefix are copied verbatim. Copying *all* of them (rather
# than a hand-picked list) means adding `PBL_NV_LOCK_EPOCH`-style state in the firmware
# needs no change here, and a macro that references a PCD resolves through the host PCD
# header (gen-host-pcd.py) at its use site, so a changed PCD default flows into the tests.
MACRO_PREFIX = "PBL_"

# The firmware API the host tests call. Prototypes are lifted rather than redeclared so a
# signature change in PblApp.h fails this build instead of being silently tolerated.
#
# Every `PblTpm*` declaration in PblApp.h is lifted automatically (see discover_protos): the
# compiled modules call the session API across TpmClient.c/TpmSession.c, so a hand list would
# need editing every time one of those functions gained a caller, and forgetting would only
# surface as `-Wimplicit-function-declaration` noise. The explicit names below are the
# non-`PblTpm` entry points the tests call directly.
PROTOS = [
    "PblTcg2Locate",
    "PblCborDecodeVerdict",
    "PblCborDecodePolicy",
    "PblCoseExtractAll",
    "PblCoseParseProtectedHeader",
    "PblVerifyCoseSign1",
]

PROTO_PREFIXES = ("PblTpm",)

# A line that can be part of a return type: identifiers and spaces only, with an optional
# trailing '*'. Deliberately NOT "anything without a semicolon" — that earlier form walked
# backwards into a preceding struct because a field line ending in a `// comment` does not end
# with ';', which duplicated six struct definitions into the generated header.
_RETURN_TYPE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\s+[A-Za-z_][A-Za-z0-9_]*)*\s*\*?\s*$")


def extract_struct(source: str, name: str) -> str:
    """Return the `typedef struct { ... } name;` block, or raise.

    The block is sliced from the *nearest* preceding `typedef struct` to the
    closing `} name;`. Anchoring on the first `typedef struct` in the file (as a
    single non-greedy regex does) swallows every struct in between and emits
    duplicate definitions — which the compiler caught immediately.
    """
    close = re.search(r"\}\s*" + re.escape(name) + r"\s*;", source)
    if not close:
        raise SystemExit(
            f"extract-decls: no `typedef struct {{ ... }} {name};` in PblApp.h.\n"
            "  Renamed or removed? Update STRUCTS here and the host tests that use it."
        )
    start = source.rfind("typedef struct", 0, close.start())
    if start == -1:
        raise SystemExit(f"extract-decls: {name} has no `typedef struct` before it")
    return source[start : close.end()]


def extract_macros(source: str) -> list[str]:
    """Return every object-like `#define PBL_...` line, verbatim, in file order."""
    out = []
    for line in source.splitlines():
        m = re.match(r"^#define\s+(" + MACRO_PREFIX + r"[A-Z0-9_]+)(\s|$)", line)
        if not m:
            continue
        name = m.group(1)
        # Skip the include guard (`PBL_APP_H_`): copying it would make the generated
        # header define the firmware header's guard, which is meaningless here and
        # hides a genuine "guard already taken" problem instead of failing on it.
        if name.endswith(("_H_", "_H")):
            continue
        out.append(line.rstrip())
    return out


def extract_proto(source: str, name: str) -> str:
    """Return one function declaration, from its return type through `);`.

    Walks backwards over the lines that make up the return type (`EFI_STATUS`,
    `VOID`, `UINT8 *`) and stops at the first line that cannot be part of one — a
    comment, a `#define`, the previous declaration's `);`, or a `}`.
    """
    # Anchored to a line start: a plain \b search finds the first *mention*, and these
    # functions are referenced in comments above their declarations ("... the same pattern as
    # PblTpmReadLockState ..."). Slicing from a comment to the next ');' swallowed dozens of
    # unrelated declarations — six struct definitions were emitted twice and the build failed
    # with "expected PBL_POLICY * but argument is of type PBL_POLICY *".
    match = re.search(r"^" + re.escape(name) + r"\s*\(", source, re.M)
    if not match:
        raise SystemExit(
            f"extract-decls: no declaration of {name} (...) in PblApp.h.\n"
            "  Renamed or removed? Update PROTOS here and the host tests that call it."
        )

    start = source.rfind("\n", 0, match.start()) + 1
    while start > 0:
        prev_start = source.rfind("\n", 0, start - 1) + 1
        prev = source[prev_start:start].strip()
        # Stop at a `}`/`;`/`{` line too: those end the previous declaration or struct, and a
        # type-looking line above them belongs to something else.
        if prev and _RETURN_TYPE.match(prev) and not prev.endswith((";", "{", "}")):
            start = prev_start
        else:
            break

    end = source.find(");", match.end())
    if end == -1:
        raise SystemExit(f"extract-decls: {name} declaration has no `);` terminator")
    return source[start : end + 2].rstrip()


def discover_protos(source: str) -> list[str]:
    """Return every `PblTpm*` function declared at the top level of PblApp.h, in file order.

    A declaration is a name followed by `(` at the start of a line, i.e. the same shape
    `extract_proto` walks backwards from — comments mention `PblTpmXxx()` inline, so the
    line-start anchor is what keeps them out.
    """
    names = []
    for match in re.finditer(r"^(" + "|".join(PROTO_PREFIXES) + r"[A-Za-z0-9_]+)\s*\(", source, re.M):
        name = match.group(1)
        if name not in names:
            names.append(name)
    return names


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as handle:
        source = handle.read()

    out = [
        "/* GENERATED by host-tests/extract-decls.py from ../PblApp/PblApp.h — do not edit. */",
        "#ifndef PBL_DECLS_GENERATED_H",
        "#define PBL_DECLS_GENERATED_H",
        "",
    ]

    macros = extract_macros(source)
    if macros:
        out.append("/* Object-like PBL_ macros, verbatim from PblApp.h. */")
        out.extend(macros)
        out.append("")

    for name in STRUCTS:
        out.append(extract_struct(source, name))
        out.append("")

    out.append("/* Firmware API under test. */")
    for name in PROTOS + discover_protos(source):
        out.append(extract_proto(source, name))
        out.append("")

    out.append("#endif /* PBL_DECLS_GENERATED_H */")
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
