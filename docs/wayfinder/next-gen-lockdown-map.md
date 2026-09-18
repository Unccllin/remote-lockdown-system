# Wayfinder Map: Next-Generation Lockdown System

> **Label:** `wayfinder:map`
> **Tracker:** local-markdown (`docs/wayfinder/`)
> **Created:** 2026-09-18
> **Status:** Active

## Destination

The `SYNTHESIS-NEXT-GEN-DESIGN.md` capability set converted into a locked,
sequenced implementation plan: all 7 fix-first findings (F1–F7) triaged as
real-bug or by-design, the ~40 capability candidates cut to a committed
build list with an agreed order, and the fetch-list sources/artifacts
secured or ruled out. The way is clear when implementation sessions can
run start-to-finish without another product-level decision.

## Origin

Session 115 mined all 7 reference books (4 PDFs on disk + 2 reconstructed
from primary sources + 1 open-access) into 7 new study notes, then
synthesized the full corpus (16 study notes + memory case studies) into
`docs/research/SYNTHESIS-NEXT-GEN-DESIGN.md`: 5 design laws, 7 correctness
findings, ~40 capabilities across 5 feasibility tiers.

## Notes

- **Domain:** firmware (PblApp.efi) + Python agent + Express server +
  React dashboard — a remote-lockdown/anti-theft system.
- **Skills every session should consult:** `.devin/skills/codebase-navigation`,
  the node graph (`GRAPH-SPEC.yaml`), `docs/adr/PBL-DEBT-LEDGER.md`,
  `docs/research/STUDY-INDEX.md` (16 notes — check before designing anything).
- **Execution override:** this effort carries execution into the map —
  resolved decision tickets graduate implementation tickets (per the
  harness-engineering map precedent).
- **Existing debt items stay in the ledger:** D-120 (real-media + VMK),
  D-129 (hardware), D-130 (signing) are tracked in `PBL-DEBT-LEDGER.md`,
  not duplicated here; this map may graduate new debt items into it.
- **Session lifecycle:** every implementation ticket follows
  `SESSION-START → RULE-ZERO → IMPLEMENT → VERIFY → ARTIFACT → CLOSE-DEBT`.
- **Graph invariants:** I3 — nothing marked hardware-verified without a
  real hardware artifact; emulation (QEMU/swtpm) evidence is labeled as such.

## Decisions so far

<!-- one line per closed ticket — gist + link -->

- [NG-R2: Authenticated-variable options](tickets/NG-R2-variable-authentication.md) — per-var table in `NOTE-PBL-VAR-AUTH.md`: TBA-viable but mostly unneeded; MOR can't be authenticated (use `MemoryOverwriteRequestControlLock`); **found latent bug — PBL writes MOR under wrong GUID (no-op decoy)**; graduated NG-T4 fix ticket.
- [NG-R1: BCD `osdevice` device-blob format](tickets/NG-R1-bcd-osdevice-blob.md) — **implementable-now**; full byte layout in `NOTE-BCD-DEVICE-BLOB.md` (PartitionID @0x20, TableType @0x34, DiskID @0x38 — GPT-vs-MBR inverted vs. WMI enum); graduated NG-T5 partition-binding ticket. Real hives (NG-T3) = validation, not blocker.
- [NG-T1: Verify F1](tickets/NG-T1-verify-f1-block-return.md) — **REAL BUG**: `PblApp.c:379` (policy sig fail, RoT-provisioned) and `:444` (anti-rollback) return `EFI_SECURITY_VIOLATION` → BDS advances BootOrder → Windows boots. BLOCK switch path is safe (ResetSystem). Invisible to harnesses (RoT-unprovisioned dev mode skips sig verify). Graduated NG-T6 fix ticket — security-critical, needs human review.
- [NG-T6: Fix F1](tickets/NG-T6-block-return-fix.md) — **implemented + verified**: `PblBlockHalt()` (lock screen → MOR → ResetSystem → CpuDeadLoop) replaced both propagating returns; chain-load return checked at all 3 sites; harnesses 16/0, 15/0, 16/0. Recorded as D-220 (CLOSED, SECURITY). Human review flagged.

## Approved implementation sequence (NG-Q1 ruling, 2026-09-18)

Ruling: **fix-first ordering**; segmented plan S0–S5 approved; TPM restart
counter adopted as the boot-ID anchor; resume verdict = DEGRADED alarm.
Recorded in `.devin/PENDING-RULING.md`.

- **S0 — pure repairs** (in under any ruling)
  - S0.1 MOR GUID + lock + advisory SVN — **DONE** (NG-T4, `97f4a6e`; MOR
    functional behavior platform-gated, B-025/B-026)
  - S0.2 remove `http://` from release path — **DONE** (B-016→B-028,
    `f229cc9`; DEBUG-only http retained for QEMU)
  - S0.3 deadman `now < last_seen` tamper + server-timestamp anchor —
    **DONE** (B-005→B-030, `c8b9f96`; 300s rollback tolerance, fail-secure)
  - S0.4 variable advisory treatment (B-003/B-004) — **DONE**
    (B-004→B-032, DMA var spoof closed B-031, `0391bde`; audit: no
    unauthenticated var feeds a decision)
  - S0.5 shell/BootNext classification → digest (B-010/B-017) — **DONE**
    (B-010→B-033, B-017→B-034; shell paths + ESP scan feed digest;
    BootNext read but BDS-consumed before app dispatch — best-effort;
    OVMF unordered-Boot#### wedge anomaly B-035; harness 14/0, regress 15/0)
  - S0.6 detached-signature updates + pinned key + key separation (B-006)
    — **DONE** (B-006→B-036, `131732f`; server Ed25519-signs
    v1:{version}:{sha256} via UPDATE_SIGNING_KEY, agent verifies pinned
    update_public_key, fail-closed when configured; degraded SHA-256-only
    mode warns; key domains compared by material; 14+5 tests)
  - S0.7 DHCP/policy IP config (B-015; hardware-window prep)
- **S1 — loop-closers** (the architecture completing itself)
  - S1.1 TPM restart-counter boot-ID (PBL digest + agent report + server correlate)
  - S1.2 cross-layer absence alarm (check-in with no PBL digest = bypass)
  - S1.3 attestation enrichment (FveProtectionMask, LoadedImageDigest, boot-path class)
  - S1.4 resume detection (wake + no digest + no counter-bump = S3)
- **S2 — firmware**: NG-T5 partition FVE binding; VMK lock-state proof;
  monotonic-counter freshness; disk boot-structure baseline
- **S3 — agent**: self-integrity hash; VM/snapshot detection; watchdog;
  raw-disk tripwire
- **S4 — server**: escrow-before-arm; command lifecycle; role-scoped key
  reads + audit; lock-screen provenance
- **S5 — minimal moat**: digest storage + per-device baseline + raw-diff
  alarm (taxonomy engine = later ticket)
- **Deferred, recorded**: HECI/MEI; HII probing; Option-ROM buckets; S3
  firmware provenance; error-record logging; UID override; kernel-telemetry
  driver; vuln-driver inventory; packed-binary sweep; attested enrollment;
  compliance-as-code; update rings (blocked on S0.6); device GC; forensic
  runbook; full drift taxonomy; Computrace coexistence; **DXE-implant tier —
  needs explicit product decision**

## Not yet specified

- **Per-item tickets** — each S0.x–S5.x item gets a T-ticket as it is
  picked up (S0.1 graduated as NG-T4; remaining tickets graduate on pickup).
- **Tier-0 fix tickets** — graduate when NG-T1 (F1 verification) and the
  other finding-verification tickets resolve; real bugs become debt items
  + fix tickets, by-design items become documentation.
- **FVE partition-level binding** — GRADUATED to NG-T5 (NG-R1 resolved:
  format fully decoded). Multi-boot bind-policy (`{bootmgr}.default` vs.
  first displayorder vs. any-match) folded into the ticket.
- **HeciClient design** — needs Intel AMT Implementation & Reference Guide
  (NG-T2); D-127's real close path.
- **Digest-drift baseline engine** — server-side per-device golden state;
  the largest single piece of new architecture; needs its own design
  grilling before ticketing.
- **Hardware window plan** — D-129 + 9 E-paths + Tier-3 capabilities;
  ticketable once a hardware target exists.
- **Computrace-coexistence + provenance-marker policy** — product/legal
  question folded into NG-Q1 for now; may graduate its own grilling.
- **D-130 signing-cert decision** — procurement question (HITL), waits on
  build-list stability.

## Out of scope

- Hardware procurement and any work requiring physical devices (lives in
  D-129 / the hardware window — the map plans *toward* it, doesn't buy it).
- Production deployment, packaging, marketing/productization.
- Rewrites of working components — this effort adds capabilities and fixes
  findings; it does not re-architect what passes verification.
