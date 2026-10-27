# Pending Ruling — open questions awaiting user decision

> **Mode gate.** While this file contains unchecked `- [ ]` items, the session
> is in DISCUSSION MODE. No code edits. Ambiguous imperatives ("proceed",
> "go", "continue", "do it") mean **continue the ruling** — present the next
> question or answer, never start implementing. When the user answers an item,
> mark it `[x]`. When no `- [ ]` items remain, task mode resumes.
>
> Check: `scripts/check-ruling.sh` (exits 1 while items are open).

## NG-Q1 architecture ruling (opened 2026-09-18)

- [x] Q1 — Ordering: fix-first vs interleaved → **fix-first**
- [x] Q2-Q8 consolidated — approve the segmented plan → **approved via "proceed"** — S0–S5 as presented
- [x] Keystone anchor: TPM restart counter as boot-ID → **adopted** (recommended default)
- [x] Resume verdict semantics: DEGRADED alarm vs BLOCK-adjacent → **DEGRADED alarm** (recommended default)

Ruling closed 2026-09-18 — plan accepted with recommended defaults. Task mode.

## D-130 signing ruling (opened 2026-10-14)

PblApp.efi (and the PblPersistDxe capsule) must be signed for Secure Boot.
Three delivery paths; pick the strategy (they are NOT mutually exclusive —
a staged approach is allowed and probably correct).

### Context that constrains the choice
- `pack-persist-capsule.sh` already supports `--sign <signer.pem>`.
- `sign-efi.sh` already supports `--test` (self-signed) and `--pfx` (prod cert).
- The hardware test plan (`HARDWARE-TEST-PLAN.md`) currently says "disable
  Secure Boot" — meaning unsigned PblApp boots fine on the HP test box TODAY.
- The capsule (`persist-capsule/`) is what survives disk-swap; its signature
  is what makes it durable. Unsigned/self-signed capsule = only works where
  you control db.
- Fleet goal: any company-owned Windows machine, Secure Boot on.

### Q1 — which signing strategy?

- [x] Q1 — signing strategy → **owner-cert + db enrollment** (the designed
      path per PBL-SECURE-BOOT-DEPLOYMENT.md §2.1). Resolves to modified-D:
      A is not dev-only — it's the fleet path. Microsoft portal (B) is
      UNNECESSARY because every unit gets a provisioning touch (db is
      enrollable at imaging/setup). External SPI clip (C) held as the
      per-unit fallback only for units that reject capsule delivery.
      Rationale: Computrace model — you own the platform, so you own db;
      the signing cert lives in db, enrolled at provisioning alongside
      PK/KEK (SetupMode→0, DeployedMode→1). `Decision.c` already BLOCKs
      on SecureBoot=0/SetupMode=1.

- [x] Q2 — cert custody → **you hold the PFX** (owner keys: PK/KEK/db +
      PBL signing cert). No Partner Center account needed — provisioning
      touch on each machine removes the need for MS-signed binaries.
      Store PFX offline; `sign-efi.sh --pfx` already supports it.

**Ruling closed 2026-10-14** — owner-cert + provisioning-time db enrollment;
Microsoft portal dropped; SPI clip = per-unit fallback. Implementation:
sign PblApp.efi + persist capsule with owner cert, enroll owner db during
the per-machine provisioning step.

