# PBL Implementation Plan — Pre-Boot Remote Firmware Lock for Windows

> **Status:** PLAN ONLY. No contracts (C1–C4) or code are written in this
> document. This maps each requirement to owning agent, files, tests, and
> dependencies so the next session can freeze contracts with confidence.
> **Source of truth for the charter:** the orchestrator prompt (PBL spec)
> pasted 2026-09-05. **Source of truth for threat model:** the completed
> research in `docs/research/windows-firmware-lecture.md`,
> `docs/RESEARCH-UEFI-STUDY-NOTES.md`, `docs/RESEARCH-TPM-KEY-STORAGE.md`,
> `docs/RESEARCH-UEFI-VARS-TPM.md`, `docs/RESEARCH-HP-HARDWARE.md`.

---

## 0. Binding design corrections (non-negotiable, from charter §0)

These three statements MUST appear verbatim in every PBL design doc and be
honored at every gate. A claim that violates them is a gate failure.

1. **"Reflash-proof UEFI app" is a false requirement.** A UEFI application
   lives in the SPI BIOS region or the ESP; a full reflash removes it.
   Survivability comes from three independent anchors, not from the app:
   - (a) **TPM NV-index lock state** — write-once / policy-locked index on a
     separate TPM device or fTPM NV store that a firmware reflash does not
     clear.
   - (b) **BitLocker VMK sealed to PCR+NV policy** — a reflashed or
     downgraded firmware produces different PCR 7/11 values and the VMK
     simply does not release.
   - (c) **Server-side state** — a machine that reappears with cleared
     firmware is still LOCKED the moment it checks in.
   No design doc may claim the UEFI app itself survives reflash.

2. **Fail-closed on data, fail-open on availability — different axes.**
   If the lock server is unreachable, PBL must NOT brick the machine. It
   falls back to the last signed lock verdict cached in TPM NV with a
   validity window (`grace_until`); after grace expires it enters
   denied-boot-with-local-unlock, never a hard brick. Data confidentiality
   never depends on server reachability — it is enforced by BitLocker
   sealing, not by PBL's decision.

3. **The lock decision must be measured, not merely made.** PBL extends its
   own decision, policy version, and inputs into PCR 12/13 via the TCG
   protocol — never into firmware-owned PCRs 0–7. A tampered or skipped PBL
   run is then detectable by attestation and enforced by BitLocker's own
   sealing policy. A check that is not measured can be skipped by re-ordering
   `BootOrder`.

---

## 1. Decision: fate of the existing `firmware/AntiTheft*` modules

### What exists today

`firmware/` holds a first-generation prototype (single commit `1da7fcd`,
50 tracked files): `AntiTheftAgent` (DXE driver + `lockdown.c`, `network.c`,
`ntfs.c`, `nvram.c`, `tpm.c`, `dns_tunnel.c`), `AntiTheftCapsule`,
`AntiTheftHello`, `AntiTheftHttp`, `AntiTheftNetInit/Probe`, `AntiTheftNtfs`,
`SetLockdown`, `SimpleLoader`, `windows-test/` tooling, `dns-tunnel/`,
`tpm-test/`, and three build scripts.

### Blast radius of deleting it (verified this session)

- **Runtime / build dependencies on the rest of the system: NONE.**
  `grep` across `scripts/`, `Makefile`, `.github/`, `server/`, `agent/`,
  `dashboard/`, `electron/` finds zero references to `firmware/`,
  `build-uefi`, or `AntiTheft`. CI does not build it; the Makefile does not
  call it; no server/agent/dashboard code imports it.
- **Documentation references (would go stale, need updating):**
  `AGENTS.md` (line 567), `docs/ARCHITECTURE-V2.md` (line 114),
  `docs/HARDWARE-TEST-CAPSULE.md` (15 refs), `docs/RESEARCH-TPM-KEY-STORAGE.md`,
  `docs/RESEARCH-UEFI-VARS-TPM.md`, `scripts/usb-readme.txt`.
- **Historical records (append-only, keep as-is):** `.devin/memory/`,
  `.devin/graph/trace*.md` reference AntiTheft as past session work — these
  are history and must not be rewritten.
- **`.gitignore`** lines 63–65 ignore `firmware/Build/`, `firmware/Conf/`,
  `firmware/capsule-output/` — still valid for PblPkg builds, leave them.

### Reuse value assessment (honest)

The existing UEFI modules encode the **wrong architecture** per the §0
corrections and should NOT be lifted into PblPkg:

- `AntiTheftAgent.c` header comment claims it "survives OS reinstalls, disk
  wipes, and CMOS clears" via SPI flash — exactly the false requirement §0.1
  forbids.
- Lock state lives in UEFI NVRAM (`nvram.c`) only — no TPM NV index, no PCR
  sealing, no BitLocker binding. A CMOS clear / NVRAM reset defeats it.
- Network check-in is plaintext HTTP with a DNS-tunnel fallback (`network.c`,
  `dns_tunnel.c`) — no TLS, no COSE-signed verdict, no nonce, no replay
  protection. The DNS tunnel is an attack surface, not a feature.
- `lockdown.c` enforcement is `while (TRUE) gBS->Stall(1000000);` — a hard
  halt with no recovery route. This is the brick behavior §0.2 forbids.
- No Secure Boot policy checks, no dbx/db verification, no SPI protection
  checks, no measured boot, no policy blob, no anti-rollback, no SBAT, no
  signing pipeline.

A few pieces have **reference value** (not direct code reuse) and should be
**preserved** by moving them out of the deletion path:

| Keep | Reason |
|------|--------|
| `firmware/windows-test/UefiVarTest.c` + `.ps1` | Windows-side UEFI variable R/W tooling — useful for Agent E negative tests and Agent D Windows-side provisioning |
| `firmware/windows-test/ModifyNvram.ps1`, `ParseNvram.ps1` | Windows-side NVRAM tooling — useful for E |
| `firmware/windows-test/CapsuleUpdater.c` + `.ps1` | Capsule staging reference for D/A update path |
| `firmware/windows-test/TEST-PLAN.md` | Reference for E's test plan structure |
| `firmware/tpm-test/tpm-seal-test.sh` | TPM sealing reference for D |
| `firmware/build-uefi.sh` | EDK II build orchestration reference (PblPkg needs a fresh reproducible build, but the env-setup lessons apply) |

### Recommendation

**Delete the `AntiTheft*` UEFI modules and `SimpleLoader`/`SetLockdown`/`dns-tunnel`/`AntiTheftNet*`/`AntiTheftNtfs`/`AntiTheftHttp`/`AntiTheftHello`/`AntiTheftCapsule` modules. Preserve `windows-test/`, `tpm-test/`, and `build-uefi.sh` by relocating them to `firmware/legacy-tools/`. Build PblPkg fresh under `firmware/PblPkg/`.**

Rationale: the existing UEFI code is a non-conforming prototype that
demonstrates the architecture the §0 corrections explicitly retract. Keeping
it in place risks agents copying its patterns (NVRAM-only lock state,
hard-halt enforcement, plaintext HTTP). The Windows-side tooling has
independent value for testing and provisioning and is not part of the
boot-time trust chain, so it stays as reference tooling.

**This deletion is destructive and requires explicit user confirmation
before execution. It is not performed in this plan-only session.**

---

## 2. Agent boundaries and dependency graph

```
                    Day 0: freeze C1–C4 + design docs (orchestrator)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  Agent C (Lock Server)       Agent D (TPM/Sealing)       Agent E (Tamper)
  independent, staging-first  owns C2 doc + simulator     writes tests Day 0
        │                           │                           │
        ▼                           ▼                           │
  Agent B (HTTPS client)       Agent A (UEFI app)              │
  codes vs C1 OpenAPI + mock   codes vs C2 doc + C3 stub       │
        │                           │                           │
        └──────────┬────────────────┘                           │
                   ▼                                            │
            A+B+D integrate (needs C staging)                   │
                   │                                            │
                   └────────────────────────────────────────────►
                                                              E signs off
                                                           (chain audit last)
```

**Dependency rule (replaces "D before A"):** Agent A depends only on the
**C2 document**, not on D's finished code. The only true blocking edges are
(a) C's staging deployment before any end-to-end test, and (b) E's final
chain audit after A+B+D integrate.

| Agent | Owns | Delivers first |
|-------|------|----------------|
| A | UEFI app (EDK II PblPkg) | Compiling shell + platform-state collection |
| B | Pre-boot HTTPS client | `PblHttpsPost` against C's mock |
| C | Lock server backend | OpenAPI 3.1 (C1) + staging mock on Day 3 |
| D | TPM binding & sealing | C2 document + swtpm simulator on Day 3 |
| E | Tamper & bypass audit | Negative-test suite from Day 0 |

---

## 3. Day 0 contracts (FROZEN 2026-09-05)

The four contracts are frozen and authored as separate files in `docs/adr/`:

| Contract | File | Status |
|----------|------|--------|
| C1 — LockVerdict wire format | `docs/adr/PBL-C1-LockVerdict.md` | FROZEN |
| C2 — TPM contract | `docs/adr/PBL-C2-TPM-Contract.md` | FROZEN |
| C3 — Network client API | `docs/adr/PBL-C3-Network-Client.md` | FROZEN |
| C4 — Policy blob schema | `docs/adr/PBL-C4-Policy-Blob.md` | FROZEN |

All 14 REQs (REQ-01…REQ-14) are covered across the four contracts. Cross-
references verified: PCR usage (C2 §4 ↔ C4 §2.5 key 44), nonce flow (C3 §5 →
C1 §2 key 3 → C1 §7 step 6 → C2 §4.1), device_id (C2 §1.3 → C1 §4 → C3 §3.2),
grace (C4 §2.9 → C1 §3.1 → C2 §1.1 → C3 §6.1), cert pins (C4 §2.8 → C1 §5,
C3 §4), anti-rollback (C2 §1.2 ↔ C4 §4 ↔ C1 §7 step 7).

Changes to a frozen contract require orchestrator approval and a version
bump. The contracts are the single source of truth for agents A, B, C, D, E.

### C1 — LockVerdict wire format
- Format: CBOR or COSE_Sign1.
- Fields: `device_id, nonce, verdict (LOCKED|UNLOCKED|WIPE_PENDING),
  policy_version, issued_at, grace_until, reason, sig`.
- Signed by the lock-service key; verified in PBL against a certificate
  pinned in the policy blob (C4), not the platform TLS store.
- Owner: Agent C. Consumers: Agent A (verify), Agent B (transport).

### C2 — TPM contract
- Exact command sequence and NV index layout Agent D guarantees.
- NV index for lock state: policy-write, `TPMA_NV_POLICY_DELETE` cleared
  (cannot be casually deleted).
- NV monotonic counter for policy version (anti-rollback).
- PCR set for sealing (7 + 11 default; 12 + 13 in high-assurance tiers).
- Session flags required by REQ-05 (HMAC, parameter encryption,
  salted/bound, `TPMA_SESSION.decrypt/encrypt`).
- `TPM2_PolicyAuthorize`-based policy so PBL can be updated without
  re-provisioning.
- Ship a host-side simulator (swtpm / tpm2-simulator) + tpm2-tools
  reference script on Day 3.
- Owner: Agent D. Consumers: Agent A (executes commands), Agent E (tests).

### C3 — Network client API
- `EFI_STATUS PblHttpsPost(const CHAR8 *uri, const UINT8 *body, UINTN len,
  UINT8 **resp, UINTN *resp_len)`.
- Explicit timeout, retry, and `EFI_TIMEOUT` / `EFI_NO_MEDIA` semantics.
- No allocation after `ExitBootServices` (PBL never reaches that point, but
  the constraint keeps the code auditable).
- Owner: Agent B. Consumer: Agent A.

### C4 — Policy blob schema
- Versioned, signed. Carries: OEM PK allowlist, PKfail denylist, dbx/db
  expectations, SVN floors, firmware version floors per SMBIOS Type 0
  vendor/product, winre.wim/BCD hashes, TLS CA pin, lock-service cert pin,
  verdict-cache grace period.
- Policy is data: a new CVE becomes a policy push, never a code change.
- Owner: Orchestrator (schema) + Agent C (serving). Consumer: Agent A.

---

## 4. REQ-01 … REQ-14 → agent / files / tests / dependencies

PCR facts (binding): BitLocker binds PCR 7 + 11 under Secure Boot (legacy
profile 0/2/4/11). PCR 4 = boot manager/loader code; PCR 5 = GPT +
BootOrder + ExitBootServices; PCR 7 = Secure Boot policy incl. authorising
db entry; PCR 11 = BitLocker access control; PCR 12 = boot data/events;
PCR 13 = boot module details; PCR 14 = boot authorities. PCR 10 is not used
by BitLocker. **PBL writes only to PCR 12/13.**

| REQ | Check | Owner | Files | Test (E) | Depends on |
|-----|-------|-------|-------|----------|------------|
| REQ-01 | SetupMode=0, DeployedMode=1; PK in OEM allowlist, not in PKfail denylist | A | `PlatformState.c` (GetVariable PK/KEK/SetupMode/DeployedMode), `Policy.c` (allowlist/denylist from C4) | Enroll AMI test PK → BLOCK | C4 |
| REQ-02 | dbx has MS 2011 prod CA revocation + BootHole hashes; db has Windows UEFI CA 2023; bootmgr SVN ≥ floor | A | `PlatformState.c` (GetVariable db/dbx), `Svn.c` (read PE/COFF SVN from bootmgr) | Roll dbx back to pre-BootHole → BLOCK | C4 |
| REQ-03 | SPI protections: BIOSWE=0, BLE=1, SMM_BWP=1, PRRs cover BIOS region, descriptor not CPU-writable | A | `SpiProtections.c` (per-OEM protocol matrix; mark unknown if no protocol) | Clear BIOSWE on lab board → verdict | per-OEM matrix doc |
| REQ-04 | Firmware version ≥ OEM floor (LogoFAIL, Binarly SMM, ME); AMT de-provisioned unless allowlisted; USB DCI disabled | A | `PlatformState.c` (SMBIOS Type 0/1/2/4), `AmtCheck.c`, `DciCheck.c` | Downgrade firmware below LogoFAIL floor → DEGRADED | C4 |
| REQ-05 | Every TPM auth uses HMAC session + parameter encryption (salted/bound, decrypt/encrypt); TPM+PIN mandatory where dTPM present | D (design), A (execute) | `TpmClient.c` (session setup per C2), D: `tpm_session.py` | Force plaintext TPM session → refuse | C2 |
| REQ-06 | TPM firmware ≥ vendor floor (TPM-Fail: Intel fTPM, STMicro); AMD Zen 2/3 fTPM (faulTPM) flagged → TPM+PIN forced | D (matrix), A (read caps) | `TpmClient.c` (TPM caps), D: `ftpm_matrix.py` | Flag faulTPM SKU → PIN forced | C4, C2 |
| REQ-07 | S3 disabled (S4/Modern Standby only); Kernel DMA Protection on; MOR bit requested | A | `PlatformState.c` (ACPI FADT S3), `DmaProtection.c`, `Mor.c` (TPM2_PolicyMOR) | — | C2 |
| REQ-08 | Network boot entries absent from BootOrder, or pinned to HTTPS with CA in TlsCaCertificate | A | `PlatformState.c` (GetVariable BootOrder/Boot####/TlsCaCertificate) | Add PXE + HTTP-boot entry → BLOCK | C4 |
| REQ-09 | BCD, recoverysequence target, winre.wim hashes match policy; OS volume BitLocker-protected with escrowed recovery key | A (BCD/winre hash), D (BitLocker escrow) | `PlatformState.c` (read BCD, hash winre.wim from ESP), D: `bitlocker_seal.py` | Replace winre.wim, edit BCD recoverysequence → BLOCK | C4, D |
| REQ-10 | Platform firmware recovery capability recorded (dual-image / Intel PFR / none); none → DEGRADED, never BLOCK | A | `PlatformState.c` (SMBIOS/ACPI detect) | — | C4 |
| REQ-11 | Policy blob signature valid; policy version monotonic vs TPM NV counter (anti-rollback); PBL refuses older policy | A (verify), D (NV counter) | `Policy.c` (sig verify + version check), `TpmClient.c` (read NV counter per C2) | Replay old signed policy → BLOCK | C2, C4 |
| REQ-12 | All inputs + policy version + final verdict extended into PCR 12/13; emitted to attestation; TCG log parsed for PCR 4/7/11–14 | A (extend + parse), B (emit), C (attest endpoint) | `TpmClient.c` (HashLogExtendEvent), `TcgLog.c` (parse), `AttestEmit.c` | Skip PBL by reordering BootOrder → PCR 12/13 mismatch → BitLocker recovery + attestation alert | C2, C1 |
| REQ-13 | Lock verdict is signed, nonce-bound, replay-resistant server statement; cached verdict honoured only within grace_until | B (fetch), A (verify COSE + nonce + grace), C (sign), D (TPM NV cache) | `Verdict.c` (C1 parse), `HttpsClient.c` (C3), D: `nv_cache.py` | Replay stale/other-device verdict, cert-mismatch TLS, offline past grace_until → BLOCK | C1, C2, C3 |
| REQ-14 | Signed admin override path (offline challenge/response), rate-limited; no static/global unlock secret anywhere | A (UI + verify), C (override endpoints) | `Override.c`, `LockScreen.c` (challenge display + response input), C: `pblOverride.js` | — | C1 |

---

## 5. File layout (target, not created this session)

### Agent A — `firmware/PblPkg/` (EDK II package)
```
firmware/PblPkg/
  PblPkg.dec                       # package declarations (GUIDs, PCDs)
  PblPkg.dsc                       # X64 + AARCH64, GCC5 + VS2019
  PblPkg.fdf                       # flash description (optional, for ROM image)
  PblApp/
    PblApp.inf                     # UEFI_APPLICATION
    PblApp.c                       # entry point: collect → decide → extend → chain/lock
    PlatformState.c/.h             # REQ-01,02,04,07,08,10 collection
    SpiProtections.c/.h            # REQ-03 (per-OEM matrix)
    Policy.c/.h                    # C4 parse + sig verify + anti-rollback (REQ-11)
    Svn.c/.h                       # PE/COFF SVN read (REQ-02)
    AmtCheck.c/.h, DciCheck.c/.h   # REQ-04
    DmaProtection.c/.h, Mor.c/.h   # REQ-07
    TpmClient.c/.h                 # TPM commands per C2 (REQ-05,06,11,12,13)
    TcgLog.c/.h                    # TCG event log parse (REQ-12)
    HttpsClient.c/.h               # contract C3 (Agent B)
    Verdict.c/.h                   # C1 LockVerdict COSE parse + nonce + grace (REQ-13)
    Decision.c/.h                  # REQ evaluation → PASS/DEGRADED/BLOCK
    LockScreen.c/.h                # GOP + simple text + input ex (REQ-14 UI)
    Override.c/.h                  # REQ-14 offline challenge/response
    ChainLoad.c/.h                 # LoadImage/StartImage bootmgfw.efi
    Cbor.c/.h                      # CBOR/COSE parser (fuzz target)
    Sbat.c/.h                      # SBAT section
  Test/                            # host-side unit tests for parsers
  build-pbl.sh                     # reproducible build script
  sign-pbl.sh                      # sbsign/signtool pipeline
```

### Agent B — lives inside PblPkg (HTTPS client is a library, not a separate binary)
Files: `HttpsClient.c/.h` under `PblApp/`. Agent B owns these files; Agent A
includes them. Per-OEM TLS matrix documented in `firmware/PblPkg/docs/oem-tls-matrix.md`.

### Agent C — `server/` (extends existing Express API)
```
server/pbl-openapi.yaml            # OpenAPI 3.1 (contract C1)
server/src/routes/pblVerdict.js    # POST /v1/verdict
server/src/routes/pblEnroll.js     # POST /v1/enroll
server/src/routes/pblAttest.js     # POST /v1/attest
server/src/routes/pblPolicy.js     # GET /v1/policy/{version}
server/src/routes/pblOverride.js   # /override/challenge + /override/response
server/src/services/verdictSigner.js   # HSM/KMS signing
server/src/services/deviceIdentity.js  # EK/AK verification, TPM2_ActivateCredential
server/src/db/migrations/*-pbl-tables.js
server/test/pbl/*.test.js          # Jest tests
```

### Agent D — `agent/pbl_tpm/` (extends existing Python agent)
```
agent/pbl_tpm/tpm_nv_layout.py     # C2 NV index layout definition
agent/pbl_tpm/provision.py         # enrolment provisioning (create NV indices, counter)
agent/pbl_tpm/bitlocker_seal.py    # Windows-side BitLocker PCR profile set
agent/pbl_tpm/tpm2_reference.sh    # tpm2-tools reference sequence
agent/pbl_tpm/simulator/           # swtpm + tpm2-simulator harness
agent/pbl_tpm/provisioning.psd1    # PowerShell provisioning module
agent/pbl_tpm/intune-templates/    # GPO/Intune templates
agent/tests/pbl_tpm/*.py           # pytest
```

### Agent E — `agent/pbl_tests/` + `firmware/PblPkg/Test/`
```
agent/pbl_tests/negative/          # one test per REQ (REQ-01..REQ-14)
agent/pbl_tests/fuzz/              # libFuzzer/AFL++ harnesses (policy, CBOR, HTTP, var parsers)
agent/pbl_tests/chain_audit.py     # end-to-end Secure Boot chain audit
agent/pbl_tests/safety_review.py   # recovery path enumeration
firmware/PblPkg/Test/              # host-side parser unit tests
```

### CI
```
.github/workflows/pbl-ci.yml       # build PblPkg (X64/AARCH64), swtpm QEMU test,
                                   # fuzz corpus, server PBL tests, agent PBL tests
```

---

## 6. Sequencing

| Day | Milestone | Owner | Unblocks |
|-----|-----------|-------|----------|
| 0 | Freeze C1–C4 + design docs (with §0 statements) | orchestrator | A, B, C, D, E start |
| 0 | E writes negative-test stubs (one per REQ) | E | continuous audit |
| 3 | C deploys staging mock + docker compose mock | C | B integration, e2e tests |
| 3 | D ships swtpm simulator + tpm2-tools reference | D | A TpmClient integration, E TPM tests |
| 5 | B delivers `PblHttpsPost` against C's mock | B | A network path |
| 7 | A delivers platform-state collection + decision engine (cached verdict path) | A | D sealing integration |
| 10 | A+B+D integrate; first e2e on OVMF/QEMU+swtpm | A+B+D | E chain audit |
| 12 | E chain audit + safety review sign-off | E | gate |
| 14+ | Real hardware: ≥3 OEMs × {dTPM,fTPM} × {Intel,AMD} + 1 ARM64 SKU | A+D+E | hardware artifact (graph I3) |

---

## 7. Build / test / verification surface

- **PblPkg build:** `firmware/PblPkg/build-pbl.sh` — X64 + AARCH64, GCC5 +
  VS2019, reproducible (hash-stable). `-Werror`, ECC + cppcheck clean.
- **CI runtime budget:** total PBL runtime ≤ 3 s with network, ≤ 300 ms
  cached. CI asserts these on OVMF.
- **OVMF/QEMU + swtpm:** CI gate for A. Real hardware is the I3 artifact.
- **Server:** `cd server && npm test` extended with `server/test/pbl/*`.
- **Agent:** `cd agent && python3 -m pytest tests/pbl_tpm tests/pbl_tests -q`.
- **Fuzz:** libFuzzer/AFL++ on policy, CBOR/COSE, HTTP response, variable
  parsers — ASan/UBSan on host builds, corpus in CI.
- **Supply chain:** reproducible builds, SPDX SBOM for PblPkg + crypto deps,
  dependency pinning (no floating versions), signing keys in HSM with
  rotation doc, SBAT version bump procedure.
- **Graph:** new enforcement paths (E-PBL-LOCK, E-PBL-SEAL, E-PBL-VERDICT,
  E-PBL-OVERRIDE) added to `GRAPH-SPEC.yaml` with `verified-in-unit-test`
  status until hardware artifacts exist (invariant I3).

---

## 8. Risks and open questions

1. **Per-OEM SPI register access (REQ-03).** No standard UEFI protocol
   exposes BIOSWE/BLE/SMM_BWP/PRR from an application. Where no OEM protocol
   exists, PBL marks REQ-03 `unknown` and server policy decides. The support
   matrix must be documented per OEM; this is a known coverage gap, not
   something to fake with raw MMIO poking (which the spec forbids).
2. **Pre-boot Wi-Fi coverage gap.** Most machines are wired-only pre-boot.
   `EFI_WIRELESS_MAC_CONNECTION_II_PROTOCOL` is OEM-dependent. Surface this
   to the customer; do not fake it.
3. **T3 residual risk.** Out of scope: T3 against a machine with no dTPM bus
   and Kernel DMA Protection on. Document and accept.
4. **BitLocker PCR profile modification.** Setting the platform validation
   profile to include PCR 12/13 requires `manage-bde` / Win32_EncryptableVolume
   and may trigger recovery on existing fleets. D must deliver the Intune/GPO
   rollout plan; staged rollout mandatory.
5. **Anti-hammering.** PIN attempts consume TPM DA counters. D must document
   lockout behaviour and recovery so support does not brand machines as
   bricked.
6. **Deletion of existing `firmware/AntiTheft*`.** Destructive — requires
   explicit user confirmation before execution (see §1).

---

## 9. What this session produced / did not produce

- **Produced:** this plan document. Maps every REQ to owner, files, tests,
  dependencies. Assesses deletion blast radius and reuse value of existing
  firmware code. Defines Day 0 contract scopes without drafting content.
- **Did NOT produce:** the C1–C4 contract content, any PblPkg code, any
  server/agent code, any deletion. Those are the next session's work,
  gated on user confirmation of the §1 deletion decision.
