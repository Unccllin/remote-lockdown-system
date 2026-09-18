# Pending Ruling — open questions awaiting user decision

> **Mode gate.** While this file contains unchecked `- [ ]` items, the session
> is in DISCUSSION MODE. No code edits. Ambiguous imperatives ("proceed",
> "go", "continue", "do it") mean **continue the ruling** — present the next
> question or answer, never start implementing. When the user answers an item,
> mark it `[x]`. When no `- [ ]` items remain, task mode resumes.
>
> Check: `scripts/check-ruling.sh` (exits 1 while items are open).

## NG-Q1 architecture ruling (opened 2026-09-18)

- [ ] Q1 — Ordering: fix-first vs interleaved (recommended: fix-first)
- [ ] Q2 — Digest-drift engine: full / minimal / deferred (recommended: minimal — storage + raw-diff alarm now, taxonomy later)
- [ ] Q3 — Firmware cut: accept proposed 6-in list (var-auth, shell/BootNext classification, monotonic counter, partition FVE binding, VMK proof, disk boot-structure)
- [ ] Q4 — Agent cut: accept proposed 6-in list (clock-rollback, detached-sig updates, self-integrity, VM/snapshot detect, service watchdog, raw-disk tripwire)
- [ ] Q5 — Server cut: accept proposed 5-in list (attestation enrichment, escrow-before-arm, lifecycle states, cross-layer alarms, role-scoped key reads)
- [ ] Q6 — Provenance marker in, Computrace coexistence deferred (recommended)
- [ ] Q7 — Resume-detection elevation into buildable set, server-side form (recommended: elevate — agent check-in + no PBL digest = resume signal)
- [ ] Q8 — DXE-implant enforcement tier: design ticket or defer
- [ ] Keystone anchor: TPM restart counter as boot-ID — confirmed or alternative?
- [ ] Resume verdict semantics: DEGRADED alarm vs BLOCK-adjacent policy on detected resume
