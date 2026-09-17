# Synthesis — Next-Generation Design

> **Purpose:** Combine all sixteen study notes, the four reference books mined
> in-session, the case-study memory corpus, and the current codebase into a
> single design direction for the next generation of this system.
>
> **Status:** Design document — not yet scheduled debt items. Each proposed
> capability names its source and its target component. Feasibility tiers at
> the end sequence the work.

## 0. What this system already is

Three mutually-watching layers:

```
PBL (firmware/PblPkg/PblApp.efi)     — pre-boot sentinel: platform-state digest,
                                       TPM PCRs, signed verdict fetch, chain-load
                                       or lock screen. Runs where the OS can't lie.
agent (agent/agent.py + helpers)     — in-OS enforcer: encrypt, lock, track,
                                       deadman, offline queue, persistence.
server (server/, serverless/)        — authority: enrollment, policy blobs (C4),
                                       verdicts (C1), key escrow, audit, dashboard.
```

Thirteen enforcement paths (E-*), 52/55 debt closed, 4/13 paths verified on
real hardware (Azure VM). Verified claim today: *the machine will not boot
Windows without a fresh signed verdict from our server* — plus OS-level
lockdown once Windows runs.

## 1. The five laws the corpus converges on

Across the books, talks, papers, and case studies, the same five principles
recur. They are the design law for everything below.

1. **Indicators, not roots.** Everything a UEFI app can read — variables, PCI
   config, TCG protocol replies, even PCR reads — can be lied to by earlier
   DXE/SMM code (Platform-Embedded-Security: "BIOS is outside the engine's
   trust boundary"; R&B: SMM can falsify software SPI reads via FSMIE). The
   only anchors are (a) TPM-sealed/measured state the attacker can't unextend,
   (b) server-side verdicts, (c) cross-layer disagreement.
2. **Fail-secure is the product.** Intel AT's rendezvous timer, Boot Guard's
   fused failure policies, Intune's "no compliance policy → Not Compliant,"
   our deadman switch — the same pattern at four different layers. Every new
   check should answer "what does absence look like?" before "what does
   violation look like?"
3. **A user-mode agent cannot beat an admin — it can only detect, delay,
   re-assert.** MOS ch. 9.9.5's rootkit ladder read as a defender's
   push-down hierarchy; PRE ch. 3's whole adversary toolkit. The agent's
   power comes from being one of three watchers, not from hiding.
4. **Persistence is the attacker's game and the defender's too.**
   Computrace/LoJack is the legal precedent: DXE driver reinstalling an OS
   agent, SMM services, cloud C2, surviving OS reinstall. We are building the
   legitimate version — and must also *detect* the illegitimate one.
5. **Time without a wall clock is hard.** ME anchors elapsed-time to OCSP;
   BDS arms a 5-minute watchdog; deadman currently trusts `time.time()`.
   Every timer needs an attacker-independent anchor (monotonic counter, TPM
   clock, server timestamps).

## 2. Critical correctness findings (fix-first, before any new feature)

These aren't enhancements — they're latent bugs the research exposed.

| # | Finding | Source | Where |
|---|---------|--------|-------|
| F1 | **Boot#### return semantics are inverted vs. intuition.** A boot option returning `EFI_SUCCESS` *stops* processing and drops to a boot menu; error return *advances* to the next BootOrder entry. If PBL's BLOCK path returns an error, control hands to the next boot option — a bypass. BLOCK must hold the console (lock UI) or `ResetSystem()`, never propagate an error. | Beyond BIOS p.186 | `PblApp.c`, `Decision.c`, `LockScreen.c` |
| F2 | **PBL's variables are unauthenticated and shell-writable.** `PblMarkerTest`, `PblBootmgrSvn`, `MemoryOverwriteRequestControl` writes via plain `gRT->SetVariable` — `setvar`/`dmpstore -d` can spoof or erase them from any reachable shell. | UEFI Shell note; `MarkerTest.c`, `Svn.c`, `Mor.c` | Variable-hardening pass |
| F3 | **`check_deadman` trusts the wall clock.** `now < last_seen` (clock rollback) is currently *not* treated as tamper. | OS-internals note | `agent/agent.py` |
| F4 | **E-AUTO-UPDATE verifies a channel-delivered SHA-256**, not a detached signature with a pinned key — the channel is the trust root. | OS-internals note | `agent/agent.py` update path |
| F5 | **Fast-boot firmware may never connect the NIC** (no `BdsConnectAll`) — `HttpsClient.c` may find no network. Top D-129 landmine. | Beyond BIOS p.248–249 | `HttpsClient.c` |
| F6 | **S3 resume bypasses PBL entirely** (resume vector + save-table replay). PBL never runs; protections rest on PCR-sealed BitLocker + FLOCKDN. Must be documented, and resume-vs-cold-boot should be attested. | Beyond BIOS p.197–201; R&B items 5,7 | `Mor.c`, docs, server policy |
| F7 | **A signed UEFI shell is a signed bypass.** `mm`→NULL `gSecurity2`, `bcfg`→delete PBL's Boot####, `startup.nsh`→autorun. If a shell is reachable in BootOrder/BootNext or on the ESP, PBL is soft-deleted. BombShell/VU#718077 prove this is field-deployed. | UEFI Shell note | `PlatformState.c`, `Decision.c`, deployment docs |

## 3. The capability set — organized by layer

Source column: BB = Beyond BIOS delta, RB = Rootkits&Bootkits delta,
PE = Platform Embedded Security, SH = UEFI Shell, RE = Practical RE delta,
OS = OS-internals hardening, MDM = MDM delta, plus existing notes by number.

### 3.1 Firmware layer (PBL)

| Capability | Source | Target |
|---|---|---|
| **Boot-path classification in the digest** — flag Boot#### entries ending in shell images, CSM/legacy paths, network-boot subtypes; shell-in-BootOrder ⇒ DEGRADED signal | SH, RB#1 | `PlatformState.c` `PblCollectBootOrderState` |
| **Disk boot-structure baseline** — hash LBA-0 protective MBR, GPT headers (primary+backup), ESP/OS VBRs, NTFS BPB `HiddenSectors`, gap-sector counts. Catches Olmasco/Gapz-class infections no file hash sees. Reuses `Fve.c` DiskIo plumbing. | RB#2 | new `BootStructure.c` or extend `PlatformState.c` |
| **Authenticated/boot-state variable hardening** — move integrity-relevant PBL vars to authenticated variables or make them advisory-only | SH | `MarkerTest.c`, `Svn.c`, `Mor.c` |
| **Monotonic-counter freshness** — bind `GetNextHighMonotonicCount()` into verdict/policy freshness; rollback-resistant without trusting RTC | BB | `Verdict.c`, `Policy.c` |
| **ConnectController self-heal** — walk SNP/PciIo handles and connect the NIC before HTTPS | BB | `HttpsClient.c` |
| **UEFI error-record logging** — write `PBL_LOCK` records (creator GUID) so OS-side tooling reads *why* a machine is locked | BB | new logging path |
| **HII keyword probing** — `ExtractConfig`/`x-UEFI-ns` to read vendor setup state (chassis intrusion, mfg mode, setup-password presence) into the digest | BB | `PlatformState.c` |
| **HECI/MEI client** — wire-level: PCI B0:D22:F0, circular-buffer msgs ≤12KB, unencrypted (treat as advisory). Unlocks real AMT provisioning state (D-127), PTT-vs-dTPM discrimination, ME firmware SVN | PE | new `HeciClient.c` |
| **Boot-structure / PCR-5 cross-check** — PBL reads PCR 5 already; new part is the *server-side* golden baseline | RB#3 | `server/` + digest |
| **S3-resume provenance** — cold-boot vs resume indicator in the digest; policy can require cold boot for LOCKED→UNLOCKED transitions | BB, RB#5 | `PlatformState.c`, server policy |
| **Option-ROM / device-path image classification** — bucket `LoadedImageDigest` entries by device-path type (PCI=OptionROM, FV=firmware, media=ESP); `option_rom_policy` C4 key | RB#4 | `PlatformState.c`, C4 |
| **VMK lock-state proof** — TPM-side unseal of a PCR-bound blob proves BitLocker's TPM protector is live, not just that FVE metadata exists | existing D-120 residual | `Fve.c`, `TpmClient.c` |
| **Partition-level FVE binding** — BCD `osdevice` device-blob parse → partition-GUID match (needs blob-format RE) | existing D-120 residual | `Bcd.c`, `Fve.c` |
| **Physical-presence & UID-based override** — UEFI User Identification / credential-provider drivers as a standards-based local override factor | BB | `Override.c` |

### 3.2 Agent layer

| Capability | Source | Target |
|---|---|---|
| **Kernel-integrity telemetry** — report (not judge): callback-array sizes, `PsLoadedModuleList` vs `PsActiveProcessHead` cross-walk, SSDT entry ranges, IDT/MSR state, boot-start driver list, HVCI/VBS state. The `ch3_*` exercise drivers are ready-made enumeration blueprints; offsets are version-specific — enumerate, never patch | RB#6, RE#1 | `agent/` + new optional driver; server diffs |
| **Raw-disk-access guard** — tripwire on `\\.\PhysicalDrive*` opens/writes, MFT-region anomalies, VSS deletion (Petya signature). Advisory only — user-mode bypassable | RB#7 | `tamper_protection.py` |
| **Self-integrity check** — hash own code/bytecode (or `.text` in a frozen exe); catches 0xCC patches. Hardware breakpoints/debuggers that only read stay invisible — pair with heartbeat anomalies | RE#2 | `tamper_protection.py` upgrade from stub |
| **VM/snapshot detection** — CPUID hypervisor bit + vendor leaf + MAC OUI as telemetry; snapshot-rollback makes heartbeat-file age regress → deadman-safe signal | OS#3 | `agent/agent.py` checkin |
| **Clock-rollback tamper in deadman** — `now < last_seen` ⇒ tamper flag (fix F3) | OS#1 | `agent/agent.py` |
| **Detached-signature updates** — pinned public key, sign releases out-of-band (fix F4) | OS#4 | `agent/agent.py`, release tooling |
| **Watchdog as a service contract** — systemd `WatchdogSec=`/`Restart=always`, launchd `KeepAlive`, Windows `SERVICE_FAILURE_ACTIONS` — replace pgrep babysitter | OS#5 | `service_installer.py`, `watchdog.py` |
| **Vulnerable-signed-driver inventory** — LOLDrivers-class list diffed server-side; BYOVD countermeasure BCD flags can't provide | RB#10 | agent report + server diff |
| **Packed-binary sweep signals** — entry point outside sections, synthetic IAT, missing cert table, high-entropy sections | RE#5 | agent filesystem sweep |

### 3.3 Server layer

| Capability | Source | Target |
|---|---|---|
| **Attestation enrichment** — surface `FveProtectionMask`, `FveOnBootDisk`, `LoadedImageDigest`, PCR-5 vs golden, boot-path classification as *discrete* fields instead of opaque digest | queued residual | `server/src/routes/pbl.js` |
| **Attested enrollment (Autopilot-style)** — hardware-hash pre-registration + TPM attestation handshake at enroll; enrollment restrictions (block personal, quotas); expiring bulk tokens | MDM#3–6 | `/v1/enroll`, `devices.js` |
| **Command lifecycle states** — `conforms`/`not_applicable`/`pending`/`conflict` per command, not just ACK/fail; capability-absence ≠ noncompliance | MDM#9 | `agent.js` ACK path |
| **Escrow-before-arm** — refuse lockdown arm until recovery key is provably escrowed (Intune's BitLocker gate pattern) | MDM#19 | `devices.js`, agent ACK |
| **Role-scoped key reads + self-service** — device owner reads own recovery key; role-scoped admin reads; audit every read | MDM#20 | `devices.js` `pba-credentials`, dashboard |
| **Cross-layer disagreement alarms** — agent-healthy + digest-drift = louder alarm than silence alone; silence+drift is the composite signal | RB#14 | server verdict logic |
| **Compliance-as-code graduated response** — mark noncompliant → notify → graduated action ladder (mirrors MDM); fail-closed "no policy = not compliant" | MDM#11–12 | policy/verdict pipeline |
| **Device-record GC** — auto-clean devices absent 90–270 days | MDM#14 | `devices.js` |
| **Update rings** — channel + deferral + rollback window, not single-channel | MDM#22 | `agent.js` update routes |
| **Verified lock-screen provenance** — server-issued device-bound marker (signed token/QR) rendered on the lock screen so victims distinguish our lockdown from Petya-class fake screens | RB#8 | `LockScreen.c` + `agent/lock_screen.py` + server token |
| **Forensic acquisition runbook** — hardware SPI clip → offline disk image → hidden-sector carve → per-family hidden-FS parse; live reads are falsifiable | RB#12 | `docs/`, `offline_recovery.py` |

### 3.4 Cross-layer / architectural

| Capability | Source | Notes |
|---|---|---|
| **Computrace-class detection & coexistence policy** — detect third-party firmware agents (Absolute and friends); policy decides whether a rival persistence layer is acceptable on a locked-down device | RB#11 | firmware-scan server-side + digest classification |
| **Management-plane posture** — ME/CSME version, AMT disabled/unprovisioned/provisioned, model-level BMC risk factor — standing risk, not per-boot bool | RB#13, PE | `AmtCheck.c` + HECI client |
| **Boot Guard-style graduated enforcement is already our model** — PASS/DEGRADED/BLOCK mirrors fused failure policies; formalize the mapping in docs | PE | `Decision.c` docs |
| **Digest-drift baseline engine** — server keeps per-device golden state; every boot's digest compared; drift taxonomy (benign churn vs structural change) is the core intellectual asset | RB#3,14; academic note | `server/` — this is the moat |

## 4. What makes it "not heard of"

The individual techniques all exist somewhere. The *combination* does not:

1. **Attestation-gated boot as a product feature.** TXT/DRTM is an enterprise
   lab curiosity; Intel AT died with vPro-specificity. We do the same
   enforcement with commodity UEFI+TPM — no vPro tax, no silicon dependency.
2. **Firmware↔agent mutual attestation.** Each layer continuously proves the
   other ran. Shell-deleted PBL ⇒ agent notices missed boot evidence;
   killed agent ⇒ deadman; patched boot path ⇒ digest drift. No single
   kill-switch below the silicon.
3. **One threat model for evil-maid AND theft.** Anti-maid systems don't
   track; anti-theft systems don't verify boot chains. Same digest, two
   verdicts.
4. **Graduated enforcement instead of brick-or-boot.** Boot Guard's fused
   policies done in software: PASS/DEGRADED/BLOCK with per-policy severity —
   the anti-support-call design Intel recommended and nobody shipped.
5. **The digest-drift corpus.** Per-device boot-structure + image +
   partition baselines, diffed every boot across a fleet — nobody has this
   dataset or this detector.

## 5. Sequencing — feasibility tiers

**Tier 0 — correctness fixes first (no new capability):** F1 (BLOCK return
semantics — verify current code path, this may already be a live bypass),
F2 (variable hardening), F3 (clock-rollback), F5 (NIC connect), F7
(shell-in-BootOrder detection).

**Tier 1 — buildable now in QEMU/emulation:** attestation enrichment
(discrete fields), VMK seal/unseal proof, disk boot-structure baseline,
Boot#### classification, monotonic-counter freshness, agent kernel-integrity
reporting, clock-rollback deadman, escrow-before-arm, command lifecycle
states, lock-screen provenance marker, PCR-5 golden baseline.

**Tier 2 — needs software + real media:** FVE partition-GUID binding (needs
a real BitLocker disk to reverse the blob), packed-binary sweep, BYOVD
inventory (needs LOLDrivers list feed).

**Tier 3 — hardware window (batch with D-129):** HECI client (needs real ME),
HII keyword probing (vendor-specific), S3-resume provenance, Option-ROM
classification on real boards, shell-threat tests on HP target, all 9
unverified E-paths.

**Tier 4 — decisions/procurement:** D-130 signing cert; UID-based override
(needs smartcard/biometric hardware); Computrace coexistence policy.

## 6. Standing warnings the corpus keeps repeating

- **Every timer needs a non-RTC anchor** — monotonic counter, TPM clock, or
  server timestamp; never bare `time.time()`.
- **The shell is the most under-rated bypass.** Signed, scriptable, capable
  of erasing our Boot#### and spoofing our variables. Detection + deployment
  guidance is cheap; skipping it is fatal.
- **"Wipe protected" thinking cuts both ways.** The more unremovable the
  enforcement, the more catastrophic a key compromise — the C4/C1 signing
  keys are the crown jewels; domain separation (PE note) is non-negotiable.
- **A firmware agent that survives reimaging is indistinguishable from
  Computrace to an auditor.** The provenance marker, documented consent
  model, and transparent unlock path aren't niceties — they're what
  separates a security product from a rootkit in the incident-review meeting.

---

*Sources: STUDY-INDEX.md notes 1–16; `.devin/memory/` case-study corpus;
docs/adr/PBL-*.md contracts; verified against `firmware/PblPkg/PblApp/`,
`agent/`, `server/src/routes/` at time of writing.*
