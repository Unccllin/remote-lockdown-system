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

## Not yet specified

- **Implementation tickets for the chosen capabilities** — graduates when
  NG-Q1 (the capability cut) resolves; each chosen capability gets its own
  T-ticket.
- **Tier-0 fix tickets** — graduate when NG-T1 (F1 verification) and the
  other finding-verification tickets resolve; real bugs become debt items
  + fix tickets, by-design items become documentation.
- **FVE partition-level binding** — needs NG-R1 (blob format) AND NG-T3
  (real BitLocker artifacts); shapes D-120's close criteria.
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
