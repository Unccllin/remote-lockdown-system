# PblPkg — Pre-Boot Lock UEFI Application

## What this is

PBL is a signed UEFI application that runs in the BDS phase before the
Windows Boot Manager. It determines whether the machine is administratively
LOCKED and, if so, prevents the machine from reaching Windows in a way that
survives OS reinstall, disk replacement, and firmware reflash attempts —
while never bricking a machine.

## Status

**Scaffold** — all source files are stubs returning `EFI_UNSUPPORTED`.
The contracts (C1–C4) are frozen. Agents A, B, D fill in the implementations.

## Contracts (frozen 2026-09-05)

| Contract | File | Scope |
|----------|------|-------|
| C1 | `docs/adr/PBL-C1-LockVerdict.md` | LockVerdict COSE_Sign1 wire format |
| C2 | `docs/adr/PBL-C2-TPM-Contract.md` | TPM NV index layout, sessions, PCR |
| C3 | `docs/adr/PBL-C3-Network-Client.md` | PblHttpsPost API |
| C4 | `docs/adr/PBL-C4-Policy-Blob.md` | Policy blob schema |

See `docs/adr/PBL-IMPLEMENTATION-PLAN.md` for the full plan.

## Build

```bash
# Prerequisites: EDK II at ~/.local/src/edk2, NASM, GCC5
./build-pbl.sh --arch X64 --toolchain GCC5
# Output: PblApp.efi
```

## Test (QEMU + swtpm)

```bash
./ci-harness.sh --timeout 30
# Boots PblApp.efi in OVMF with swtpm, checks serial output
```

## File layout

```
PblPkg/
  PblPkg.dec          # package declarations (GUIDs, PCDs)
  PblPkg.dsc          # build description (X64+AARCH64, GCC5+VS2019)
  PblPkg.fdf          # flash description (minimal — app, not firmware)
  build-pbl.sh        # reproducible build script
  ci-harness.sh       # QEMU + swtpm smoke test
  PblApp/
    PblApp.inf        # module info (UEFI_APPLICATION)
    PblApp.h          # central header (all contract types + prototypes)
    PblApp.c          # entry point (8-step flow)
    PlatformState.c   # REQ-01,02,04,07,08,09,10 collection
    SpiProtections.c  # REQ-03
    Policy.c          # C4 parse + sig verify + anti-rollback (REQ-11)
    Svn.c             # REQ-02 bootmgr SVN
    AmtCheck.c        # REQ-04 AMT
    DciCheck.c        # REQ-04 USB DCI
    DmaProtection.c   # REQ-07 Kernel DMA Protection
    Mor.c             # REQ-07 Memory Overwrite Request
    TpmClient.c       # C2 TPM commands (REQ-05,06,11,12,13)
    TcgLog.c          # REQ-12 TCG event log
    HttpsClient.c     # C3 PblHttpsPost
    TlsVerify.c       # C3 §4 cert pinning
    CborEncode.c      # C3 §3.2 request body
    CborDecode.c      # C1/C4 COSE_Sign1 + CBOR parsing
    Verdict.c         # C1 §7 9-step verification
    Decision.c        # C4 §5 18-step evaluation
    LockScreen.c      # REQ-14 lock screen UI
    Override.c        # REQ-14 offline challenge/response
    ChainLoad.c       # LoadImage/StartImage bootmgfw.efi
    Sbat.c            # SBAT section
```

## Design corrections (non-negotiable, from charter §0)

1. "Reflash-proof UEFI app" is FALSE. Survivability from TPM NV + BitLocker
   PCR sealing + server state.
2. Fail-closed on data (BitLocker), fail-open on availability (cached verdict
   + grace_until, never brick).
3. Lock decision must be MEASURED into PCR 12/13 (never 0–7).
