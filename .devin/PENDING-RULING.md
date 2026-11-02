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

## D-131 device_id ruling (opened 2026-10-28, session 152)

D-131 says `PBL_PLATFORM_STATE.DeviceId` is never written, so every verdict
request carries 32 zero bytes. Sharpened on reopening: `getDevice`
(`serverless/pbl/devices.ts:22`) is an exact KV key read, and enrolment stores
the real AK-derived hex, so the lookup for `000…0` always misses and the
unknown-device branch returns **UNLOCKED** (`verdict.ts:105-125`). The online
path can therefore never deliver `locked`, `tracking` or `recovering` — a
lockdown bypass, not only an attestation gap.

Two coupled decisions. Neither can be made from source alone.

### Q1 — what does PBL do when `PBL_AK_NAME` is absent or all-zero?

The NV index is zero-filled until enrolment writes it (C2 §5.4 step 8), and
`PblTpmNvDefineSpace` creates it before any agent runs.

- [x] Q1 — unprovisioned behaviour → **(A) refuse to fetch** — recommended
option accepted. An all-zero `PBL_AK_NAME` means unprovisioned: PBL sends no
verdict request and goes to the cached-verdict → denied-boot-with-local-unlock
path per C3 §6.1. No C1 wire change, no server-side guessing.

- [x] Q2 — unknown-device verdict → **(A) unknown ⇒ not UNLOCKED** — recommended
option accepted. The unknown-device branch stops returning `VERDICT_UNLOCKED`;
it falls to the cached-verdict / denied-boot-with-local-unlock path. This
supersedes D-200's 'UNLOCKED + enrolment reason' choice, which was made before
D-131 showed the firmware was presenting a zero device_id.

**Ruling closed 2026-10-28, session 152** — (A) + (A). Implementation:
firmware populates `PBL_PLATFORM_STATE.DeviceId` from NV `0x01C00003` and skips
the online fetch when it is unprovisioned; the server's unknown-device branch
turns fail-closed. D-131 closes on a QEMU run showing a real device_id and a
non-UNLOCKED unknown-device verdict, not on the code landing.

### Q2 — what does the server do for a `device_id` it does not know?

Independent of Q1, and on its own enough to remove the bypass: today an
unknown id yields UNLOCKED. Any cleared TPM, rogue machine, or imaged-but-not-
enrolled unit obtains an unlock verdict by presenting an id the server does not
know. D-200 documents UNLOCKED as a deliberate choice.

- [x] Q2 — unknown-device verdict → **(A) stop returning UNLOCKED**.


## D-134 TPM hierarchy ruling (opened 2026-11-02, session 166)

PBL stores its NV state (lock state, policy version, lock epoch, **and the AK
Name that yields `device_id`**) in a TPM NV index. The hierarchy that owns those
indices decides whether the product works on a real machine, and the evidence
now says the current production default does not.

### What is established (experiment, not inference)

- `PcdPblTpmUsePlatformHierarchy=TRUE` (production default, `PblPkg.dec:72`)
  writes and reads with `TPM_RH_PLATFORM` + `PLATFORMCREATE`, attributes
  `0x420D000D`.
- Stock OVMF **randomizes or disables the platform hierarchy** at EndOfDxe
  (`PeiDxeTpmPlatformHierarchyLib`). Against it, PBL gets `0x9A2` on
  `NV_Read(AK_NAME)` — i.e. `device_id` empty, verdict suppressed, machine
  silently unmanaged. Our QEMU only works because the PBL OVMF build is patched
  to the Null library (`ovmf-platform-hierarchy-null.patch`).
- The owner-hierarchy fallback (`PCD=FALSE`) **cannot read what it defines**:
  it defines with `0x02040004` (no `OWNERREAD`) and authorizes with
  `TPM_RH_OWNER` → `0x149 TPM_RC_NV_AUTHORIZATION`. Adding `OWNERREAD`
  (`0x02060004`), or authorizing with the index handle, makes it readable.
- An index created by provisioning under one hierarchy cannot be migrated later:
  `PLATFORMCREATE` makes it undeletable by the owner hierarchy.
- Untested: whether Windows sets a non-empty `ownerAuth`.

Artifacts: `firmware/PblPkg/artifacts/d130-tpm-hierarchy-results.txt`,
`firmware/PblPkg/artifacts/d134-nv-auth-matrix-results.txt`.

### Q1 — which hierarchy owns the enrolled AK Name index?

- [ ] Q1 — hierarchy → **(A) owner hierarchy + `OWNERREAD`, with enrolment and
      firmware agreeing** (recommended). The index is created once at
      provisioning with `AUTHREAD|OWNERREAD`, PBL reads it with `TPM_RH_OWNER`
      (empty owner auth), and `PCD` defaults to FALSE everywhere so there is one
      code path. Cost: the lock state no longer survives `TPM2_Clear(RH_OWNER)`
      — which is the stated reason the platform hierarchy was chosen — so Q2
      must be answered.
- [ ] Q1 — other options: **(B)** keep the platform hierarchy and require
      firmware that leaves `platformAuth` empty (document it as a fleet
      requirement and test it on the HP machine first); **(C)** keep the platform
      hierarchy for the lock state but move **only the AK Name index** to the
      owner hierarchy, so `device_id` survives even when the lock state does not.

### Q2 — if the owner hierarchy is chosen, what happens on `TPM2_Clear`?

A user or a Windows refresh can clear the owner hierarchy, taking the lock state
with it. Options: re-provision on first boot after a clear (detect missing index
→ treat as unenrolled and refuse to unlock, which is fail-closed but loses
lockdown persistence); seal a copy of the lock state to the platform hierarchy as
well (two indices, belt and braces); or accept the loss and re-lock on next
contact.

- [ ] Q2 — clear behaviour → **(A) fail-closed: a cleared TPM is an unenrolled
      device** (recommended, consistent with the D-131 Q1 ruling that an absent
      AK Name means "refuse to fetch"). Re-lock requires a fresh enrolment, which
      is also the only way to restore `device_id`.

### Q3 — is the owner-hierarchy read safe against a non-empty `ownerAuth`?

If Windows sets `ownerAuth`, a `TPM_RH_OWNER`-authorized read from firmware fails
exactly as it does today on stock OVMF, and option (A) would be no better than
(B). This needs a check on a Windows-provisioned TPM before (A) is implemented.

- [ ] Q3 — verify on a Windows machine → run `tpm2_nvread` (or the equivalent)
      against an index created with `OWNERREAD` on a TPM that Windows has
      already provisioned; record the result. If `ownerAuth` is non-empty,
      fall back to index-handle authorization (`AUTHREAD` only), which the
      matrix shows works without any hierarchy auth.
