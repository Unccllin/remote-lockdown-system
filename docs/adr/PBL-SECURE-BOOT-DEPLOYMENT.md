# PBL-SECURE-BOOT-DEPLOYMENT — Binding the Lockdown to the Hardware Root

**Status:** Frozen design / deployment checklist (D-217)
**Depends on:** PBL-C2-TPM-Contract.md, PBL-C4-Policy-Blob.md

## 0. Why this document exists

D-217 (verified empirically in the RE stress-test session): a 9-byte patch to
`PblEvaluateDecision` made PBL always return PASS. **No in-binary check can
defend the binary that executes it.** The lockdown is erasable or bypassable
until two layers are in place:

- **Detection** — PBL measures its own on-disk PE image into PCR 13
  (implemented, this repo). A tampered or skipped PBL produces a different
  PCR 13; attestation and PCR-bound seals detect it.
- **Prevention** — Secure Boot (and ideally Intel Boot Guard) verifies the
  PBL image *before it runs*. Only a correctly signed binary executes.

This document is the checklist that makes the prevention layer real.

## 1. Threat model

| Attacker capability | Defense |
|---|---|
| Replaces/patches `PblApp.efi` on the ESP | Secure Boot `db` signature check — unsigned/modified image never runs |
| Deletes `PblApp.efi`, restores stock `bootmgfw.efi` boot path | Boot order must have no unsigned fallback; missing PBL → PCR 13 has no PBL extends → sealed secrets / attestation detect |
| Reflashes firmware without PBL | Intel Boot Guard (OEM-signed IBB) + TPM attestation of PCR 0–7 |
| Clears TPM (RH_OWNER) to erase lock state | Platform-hierarchy NV indices (C2 §3) survive `TPM2_Clear(RH_OWNER)`; only physical presence clears platform hierarchy |
| Enters Setup Mode, installs own PK | `Decision.c` BLOCKs when `SetupMode=1` or `SecureBoot=0` |
| Rolls back to older signed-but-vulnerable loader | `dbx` + SBAT revocation; policy `min_svn` (C4) |

## 2. Deployment checklist

### 2.1 Key enrollment (owner-controlled, not factory defaults)

- [ ] Generate owner keys: `PK`, `KEK`, `db` signing key (openssl or sbctl).
- [ ] Enroll `db`: Microsoft UEFI CA 2023 + Windows UEFI CA 2023 + **PBL
      signing certificate**. Do NOT rely on OEM `db` alone.
- [ ] Enroll `KEK` (owner + Microsoft KEK for future `db`/`dbx` updates).
- [ ] Enroll `PK` (owner). `SetupMode` → 0, `DeployedMode` → 1.
- [ ] Verify from PBL: `PlatformState.SecureBootEnabled == TRUE`,
      `SetupMode == FALSE`, `DeployedMode == TRUE` (already enforced —
      `Decision.c` REQ-01 BLOCKs otherwise).

### 2.2 Sign and install PBL

- [ ] `sbsign --key db.key --cert db.crt PblApp.efi` (or `sbctl sign`).
- [ ] Install signed image to the ESP **or** into a firmware volume
      (preferred — survives ESP wipe; see §2.5).
- [ ] Boot order: PBL first, Windows Boot Manager reachable only via
      PBL chain-load. No other boot entries that bypass PBL.
- [ ] Remove/harden fallback paths: disable USB/network boot for
      unauthorized media, or treat external-boot boots as unsealed
      (attestation detects).

### 2.3 Revocation hygiene

- [ ] `dbx` current: revokes CVE-2022-21894 (Baton Drop), BlackLotus-era
      loaders, and any CVE-listed `bootmgfw`/`shim` SBAT below policy
      `min_svn`.
- [ ] SBAT section in the signed PBL binary with a monotonically
      increasing `pbl,1,...,svn` generation.
- [ ] Policy carries `min_svn`; `Decision.c` BLOCKs below it (C4 §5).

### 2.4 TPM binding

- [ ] `PcdPblTpmUsePlatformHierarchy=TRUE` (default) — NV indices on the
      platform hierarchy survive owner clear.
- [ ] Bound HMAC session for NV lock-state access (implemented).
- [ ] Optional high-assurance tier: seal BitLocker VMK to
      PCRs `7+11+12+13` (C2 §4.3) so a skipped/tampered PBL run or a
      TRACKING-verdict PCR mismatch triggers BitLocker recovery.
- [ ] Remote attestation: server verifies PCR 12/13 quote against the
      expected extend sequence — now including the PCR 13 self-image
      extend (`SHA256(PblApp.efi file)`), then the inputs extend.

### 2.5 Firmware persistence (strongest tier)

- [ ] Package PBL as a DXE driver or UEFI app inside the OVMF/OEM firmware
      volume (FVMAIN) — survives ESP wipe and disk replacement.
- [ ] Intel Boot Guard verified+measured boot: OEM burns the IBB hash into
      fuses; unsigned firmware volumes fail verification at hardware level.
- [ ] SPI flash write protection: `BLE` + `SMM_BWP` + `PRx` ranges; BIOS
      Lock Enable set. Without this, physical/CSME attackers reflash.
- [ ] SVN/anti-rollback on the firmware capsule itself.

### 2.6 What remains unverified

- Secure Boot rejection of a tampered PblApp.efi is now proven in
  emulation: `test-sb-harness.sh` boots a SECURE_BOOT_ENABLE OVMF with a
  vars store (`virt-fw-vars`: generated PK + PblApp authenticode hash in
  db). Enrolled binary boots; 1-byte-tampered binary is rejected with
  `Access Denied -- rejected probably by Secure Boot`; the same tampered
  binary boots under plain vars (control). 8 PASS / 0 FAIL.
- Still QEMU-only. Real-hardware checks needed: OEM platform auth for
  `NV_DefineSpace`, physical-presence semantics of
  `TPM2_Clear(RH_PLATFORM)`, Boot Guard fuse state, SPI protection bits,
  and rejection on a real secure-boot chain (with a signed binary, not
  just a db hash entry).

## 3. Self-measurement detail (D-217 implementation)

`PblHashSelfImage` (PblApp.c) resolves the running image's
`EFI_LOADED_IMAGE_PROTOCOL` → `DeviceHandle` + `FilePath` media node,
opens the PE file via SimpleFS, SHA-256s the file bytes, and extends it
into PCR 13 **before** the inputs extend. On-disk bytes are deterministic
(unlike the relocated in-memory image — D-212 revert reason), so the
attestation server can replay the exact PCR 13 sequence:

```
PCR13 = extend(extend(0, SHA256(PblApp.efi)), SHA256(inputs_digest))
```

A tampered binary that forges the log but skips/changes the extend still
produces a different PCR 13. A binary that removes the measurement code
entirely removes the extend — also a different PCR 13. Detection is
complete; prevention is §2.
