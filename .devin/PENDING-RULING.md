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

- [x] Q1 — hierarchy → **(A2) owner hierarchy + index-handle auth**. Accepted
      with the refinement the matrix forced: authorize the read with the *index
      handle*, not `TPM_RH_OWNER`, so `ownerAuth` and `platformAuth` both drop out
      of the failure surface. Enrolment and firmware must agree on the hierarchy.
      ~~(A) owner hierarchy + `OWNERREAD` with `TPM_RH_OWNER` auth~~ was the
      original recommendation; superseded because it still depends on `ownerAuth`. The index is created once at
      provisioning with `AUTHREAD|OWNERREAD`, PBL reads it with `TPM_RH_OWNER`
      (empty owner auth), and `PCD` defaults to FALSE everywhere so there is one
      code path. Cost: the lock state no longer survives `TPM2_Clear(RH_OWNER)`
      — which is the stated reason the platform hierarchy was chosen — so Q2
      must be answered.
- [x] Q1 — other options rejected: **(B)** keep the platform hierarchy and
      require firmware that leaves `platformAuth` empty — fails closed and silently
      on any machine whose firmware does the standard thing; **(C)** split
      hierarchies (AK Name owner, lock state platform) — two provisioning schemes
      and after a clear `device_id` and lock state can disagree.

### Q2 — if the owner hierarchy is chosen, what happens on `TPM2_Clear`?

A user or a Windows refresh can clear the owner hierarchy, taking the lock state
with it. Options: re-provision on first boot after a clear (detect missing index
→ treat as unenrolled and refuse to unlock, which is fail-closed but loses
lockdown persistence); seal a copy of the lock state to the platform hierarchy as
well (two indices, belt and braces); or accept the loss and re-lock on next
contact.

- [x] Q2 — clear behaviour → **(A) fail-closed: a cleared TPM is an unenrolled
      device**. Missing index = unprovisioned = refuse to fetch, consistent with
      the D-131 Q1 ruling. Re-lock requires a fresh enrolment, which is also the
      only way to restore `device_id`.

### Q3 — is the owner-hierarchy read safe against a non-empty `ownerAuth`?

If Windows sets `ownerAuth`, a `TPM_RH_OWNER`-authorized read from firmware fails
exactly as it does today on stock OVMF, and option (A) would be no better than
(B). This needs a check on a Windows-provisioned TPM before (A) is implemented.

- [x] Q3 — moot under Q1(A2): index-handle authorization never touches
      `ownerAuth`, so there is nothing left to verify. No Windows check needed;
      the hardware window stays focused on D-129/D-134's firmware question.

**Ruling closed 2026-11-02, session 166** — Q1 (A2) + Q2 (A) + Q3 (moot).
Implementation: owner-hierarchy NV indices with `OWNERREAD`, `NV_Read`
authorized by the index handle, `PcdPblTpmUsePlatformHierarchy` default FALSE,
and provisioning scripts moved to the owner hierarchy so enrolment and firmware
agree. D-134 closes on a QEMU run showing a real `device_id` on a fresh owner-
provisioned TPM, plus the HP confirmation in the D-129 window.

## Per-device installer ruling (opened 2026-11-03, session 190)

The self-hosted dashboard's "one-click installer" button downloads an NSIS exe
from `GET /api/installer/:deviceId/nsis`. It installs the agent as an `sc.exe`
service. The agent has **no** `StartServiceCtrlDispatcher` (0 hits repo-wide), so
the SCM starts the process, never receives a status report, fails the service
with 1053 about 30 seconds later, and terminates it. The device checks in once
and then goes dark on every boot.

Session 189 fixed the serverless/generic installer by making it a wrapper over
`agent/installer.py`, whose persistence is the only one verified on real hardware
(HP box): scheduled task `SystemHealthMonitor` + HKLM Run key + VBS launcher +
tamper-protection ACLs, in `%ProgramData%\LockdownAgent`.

### Context that constrains the choice
- Four install mechanisms exist, with three different install directories:
  NSIS/`sc.exe` (Program Files), ZIP/`install.ps1` → NSSM or a bare
  `Start-Process` (Program Files), CLI/GUI installer → scheduled task
  (ProgramData), generic wrapper → the same.
- The ZIP's `install.ps1` needs `nssm.exe`, which is neither bundled in the ZIP
  nor a repo dependency; without it the script falls back to `Start-Process`,
  i.e. no persistence at all. It also applies no tamper protection and no
  Defender exclusion.
- `buildDeviceConfig` (installer.js) emits `server_url`, `device_hostname`,
  `api_key`, `poll_interval`, `sign_requests`, `server_supports_ack_dedup`,
  `boot_lock_enabled`, `enrolled_at` (+ optional `google_api_key`).
  `installer.py`'s `write_config` emits 12 keys including `device_id`,
  `lockdown_folder`, `lock_sentinel`, `pending_ack_file`, `recovery_key_file`
  and `verify_tls`.
- A per-device installer has one property the generic one cannot have: no token
  is needed on the target machine, because the API key is baked in.

### Q1 — what should the per-device Windows installer do?

- [x] Q1 — per-device install path → **(A) wrapper over `installer.py` with a
      baked-config mode** (recommended). Add `--config-file` to installer.py
      (skip enrollment, install from the provided config.json), and regenerate
      `generateNsisScript` to stage `lockdown-installer.exe` + `config.json` +
      the agent and call it — exactly the split adopted in S189, so `sc.exe`
      disappears from the generator. Keeps "double-click, no token", keeps one
      install engine, lands in `%ProgramData%\LockdownAgent` like everything
      else. Cost: the generated .nsi changes, so the `nsis-compile` check in
      `verify-environment.sh` and the installer.js unit tests need updating.

### Q2 — what happens to the ZIP + `install.ps1` (NSSM) path?

- [x] Q2 — ZIP path → **(A) ship `lockdown-installer.exe` in the ZIP and reduce
      `install.ps1` to a thin wrapper** (recommended) — the ZIP keeps working as
      the documented fallback and stops depending on NSSM. Alternative: leave it
      (documented as NSSM-optional, so persistence silently varies by machine),
      or delete the ZIP path entirely and serve only the exe.

**Ruling closed 2026-11-03, session 190** — Q1 (A) + Q2 (A). Implementation:
`--config-file` mode in `agent/installer.py` (install from a baked config, no
enrolment), `generateNsisScript` regenerated to stage `lockdown-installer.exe` +
`config.json` and delegate to it (no `sc.exe`), and `install.ps1` reduced to a
wrapper over the same binary so the ZIP stops depending on NSSM. Uninstall stays
server-authorized, matching the generic wrapper — which means the generated EULA
must stop promising token-free removal from Add/Remove Programs.

## Serverless installer ruling (opened 2026-11-03, session 191)

Session 190 removed the `sc.exe` install mechanism from the Express side. The
Worker still generates it in **two** places — `handleInstaller`
(`GET /api/installer/:deviceId`) and the re-arm script returned by
`POST /api/rearm` — so the Cloudflare path still starts an agent that Windows
kills with 1053 about 30 seconds after every boot.

### Context that constrains the choice
- Both scripts are near-identical (only the wording and `rearmed: true` differ).
  They download the agent from `/api/download/agent` into
  `$env:ProgramData\RemoteLockdown`, write an 8-key config, then
  `sc.exe create RemoteLockdownAgent binPath= "\"$inst\lockdown-agent.exe\" ..."`.
  That `binPath` quoting is itself malformed for `sc.exe`.
- `ProgramData\RemoteLockdown` is a **third** install directory: the agent's
  own state lives in `ProgramData\LockdownAgent`, `agent/installer.py` installs
  there, and the config they write omits `lockdown_folder`/`lock_sentinel`/
  `pending_ack_file`/`recovery_key_file`/`verify_tls`, so the agent falls back
  to `~/SecureData` for the lockdown folder.
- The re-arm script cannot be replaced by "just use the dashboard": it is
  returned to `PblPersistDxe` and executed on first Windows boot after a disk
  swap, so the response must stay a non-interactive script.
- The Worker has no filesystem. Anything a generated script executes must be
  downloadable from KV: `binary:agent`, `binary:installer` (the generic NSIS
  wrapper, which already contains `lockdown-installer.exe`), `binary:lockscreen`.
  KV values cap at 25 MiB; the CLI installer is a onefile PyInstaller exe.
- Existing tests assert the defect: `worker.test.ts` checks
  `expect(script).toContain('sc.exe create')`.

### Q1 — how should the generated serverless scripts install the agent?

- [x] Q1 — delegate source → **(A) publish the CLI installer to a new KV key**
      (recommended). Add `binary:agent-installer`; the script downloads it plus
      the agent into a temp dir, writes `config.json` there and runs
      `lockdown-installer.exe --config-file ... --silent`, so the baked
      `api_key` still needs no enrolment and no token on the target. Cost: one
      more publish step (documented next to `binary:installer`), a 503 when the
      key is missing, and the three `sc.exe` assertions rewritten.

### Q2 — the two generators are the same script twice; merge them?

- [x] Q2 — duplication → **(A) one helper, two call sites** (recommended) — a
      single `generateServerlessInstallScript({ device, config, serverUrl,
      rearmed })` used by both `handleInstaller` and the re-arm handler, so the
      install mechanism cannot drift between them again. Alternative: leave the
      two copies (they have already diverged once) or merge later.

**Ruling closed 2026-11-03, session 191** — Q1 (A) + Q2 (A). Implementation:
KV key `binary:agent-installer` (+ `/api/download/agent-installer`), one
`generateServerlessInstallScript()` used by `handleInstaller` and the re-arm
handler, both delegating to `lockdown-installer.exe --config-file ... --silent`
so the baked api_key needs no enrolment and `ProgramData\RemoteLockdown`
disappears.
