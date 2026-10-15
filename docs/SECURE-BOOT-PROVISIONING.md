# Secure Boot Provisioning (D-130)

Per-machine Secure Boot owner enrollment for the PBL firmware. This is the
repeatable sequence the D-130 ruling chose: **owner keys enrolled at
provisioning** — every unit gets a touch, so we enroll our own `db` signing
cert rather than going through the Microsoft UEFI portal. External SPI flash
(CH341A) is the per-unit fallback when a machine rejects variable enrollment.

Reference: `docs/adr/PBL-SECURE-BOOT-DEPLOYMENT.md` (the frozen design).

## The four steps

```text
[signing host]                [target machine]
gen-secureboot-keys.sh   ->   provision-secureboot.ps1
sign-pbl.sh                   (enrolls PK/KEK/db -> SecureBoot arms)
```

### 0. Generate owner keys (signing host, once)

```bash
./scripts/gen-secureboot-keys.sh --out ./sb-keys
#   -> sb-keys/auth/{PK,KEK,db,dbx}.auth   (unsigned — valid in Setup Mode)
#   -> sb-keys/keys/PBL.{key,crt,der}      (the code-signing cert — keep .key offline)
#   -> sb-keys/manifest.json
```

The `.auth` files are unsigned — they are accepted **only while the machine
is in Setup Mode** (no PK enrolled). Generate once per fleet identity; the
same `db.auth` (with your PBL cert) goes to every unit.

### 1. Enroll on the target (Windows, Administrator)

Copy `sb-keys/auth/` to the target. Machine must be booted UEFI with Secure
Boot enabled in firmware setup but still in Setup Mode (no PK yet).

```powershell
powershell -ExecutionPolicy Bypass -File scripts/provision-secureboot.ps1 `
    -AuthDir C:\pbl\auth          # add -WhatIf to dry-run, -NoReboot to skip reboot
```

Order inside the script: `dbx -> db -> KEK -> PK` — PK last because writing
it flips `SetupMode -> 0` and arms Secure Boot on the next boot. After reboot:

```text
SetupMode = 0   DeployedMode = 1   SecureBoot = 1
```

If the machine already has a PK enrolled (`SetupMode=0`), unsigned `.auth`
cannot replace it — clear keys in firmware setup first, or use `-Force` only
when re-provisioning a machine that already carries the owner PK.

### 2. Sign the firmware (signing host)

```bash
./scripts/sign-pbl.sh --key sb-keys/keys/PBL.key --cert sb-keys/keys/PBL.crt
#   -> firmware/PblPkg/PblApp.signed.efi       (verified with sbverify)
#   -> firmware/PblPkg/persist-capsule/PblPersistDxe.cap  (signed, if built)
```

### 3. Flash / deploy

- **ESP install:** copy `PblApp.signed.efi` to the ESP and boot — Secure Boot
  accepts it because the signing cert is in `db`.
- **Capsule update:** place the signed `PblPersistDxe.cap` in
  `/EFI/UpdateCapsule/` and reboot; firmware applies it.
- **Fallback:** for a unit that rejects variable enrollment, write
  `PblPersistDxe.fv` into SPI flash with a CH341A programmer at provisioning.

## Verification

`firmware/PblPkg/d130-provision-proof.txt` — QEMU+OVMF evidence that an
enrolled vars store boots the signed `PblApp.efi` (to the lock screen) and
rejects a 1-byte-tampered binary with `Access Denied — rejected probably by
Secure Boot`. Real-hardware confirmation is D-129.

## Threat model note

`Decision.c` already **BLOCKs** the boot when `SecureBoot=0` or
`SetupMode=1`. So a machine that has not been provisioned (or where
enrollment failed) fails closed — it will not boot Windows until owner keys
are enrolled and Secure Boot is on. That is the intended behavior.
