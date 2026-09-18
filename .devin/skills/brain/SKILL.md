---
name: brain
description: Evidence-tagged belief layer — the project's semantic memory. Use at session start (retrieve before asserting) and whenever verifying, refuting, or establishing facts.
---

# Brain — Evidence-Tagged Belief Layer

The brain stores what the system *believes is true* — atomic claims with
evidence levels, provenance, and supersession history. It complements:

- **memory** (`.devin/memory/`) — episodic: what *happened* in sessions
- **graph** (`.devin/graph/`) — work: what *must be done* and its evidence gates
- **brain** (`.devin/brain/`) — semantic: what is *believed true* and why

## Why it exists

Two confirmed bugs (the D-220 BLOCK bypass, the MOR GUID no-op) survived green
harnesses because "verified" knowledge lived as untagged prose. The brain makes
every claim carry *how it is known* — so emulation is never confused with
hardware proof, and refuted knowledge is remembered as refuted instead of
silently re-derived.

## Store

- `.devin/brain/beliefs.yaml` — the records (edit via CLI, not by hand)
- `.devin/brain/BELIEFS.md` — GENERATED view (`brain.py gen-view`); never edit

## Belief record

```yaml
- id: B-012
  statement: <one atomic claim>
  domain: firmware/mor            # hierarchical tag
  status: confirmed               # proposed | confirmed | refuted | decayed
  evidence_level: spec-checked    # see ladder below
  provenance: 'MemoryOverwriteControl.h:17-29 vs Mor.c:18-21'
  source: refutes B-011
  asserted: '2026-09-18'
  last_verified: '2026-09-18'
  commit_ref: 6cd33f4
  supersedes: B-011               # this belief replaces
  superseded_by: null             # replaced by (set on refuted beliefs)
  dependents: [B-023]             # beliefs relying on this — flagged on refute
  notes: 'Fix ticket NG-T4.'
```

## Evidence ladder (ordinal strength)

```
assumed < code-read < spec-checked < emulated < real-media < hardware
```

- `assumed` — asserted, never verified
- `code-read` — verified by reading source
- `spec-checked` — verified against authoritative spec/header in tree
- `emulated` — verified in QEMU/swtpm/unit harness
- `real-media` — verified on real artifacts (BCD hive, BitLocker disk)
- `hardware` — verified on physical target hardware

**Never cite a belief above its evidence level.** Emulated is not hardware.

## Commands

```bash
python3 scripts/brain.py init                                    # create store
python3 scripts/brain.py retrieve --query "MOR GUID"             # search (session start!)
python3 scripts/brain.py list [--status confirmed] [--domain firmware/mor]
python3 scripts/brain.py assert --statement "..." --domain X --source Y
python3 scripts/brain.py confirm --id B-001 \
    --evidence-level emulated --provenance "file:line + artifact" --commit abc123
python3 scripts/brain.py refute --id B-007 \
    --replacement "what is actually true" --evidence "file:line"
python3 scripts/brain.py stale      # provenance files newer than last_verified
python3 scripts/brain.py check      # integrity: confirmed ⇒ evidence+provenance
python3 scripts/brain.py gen-view   # regenerate BELIEFS.md
```

## Session protocol

**At session start** — before asserting or building on any non-trivial claim:

```bash
python3 scripts/brain.py retrieve --query "<keywords from the task>"
```

Retrieval returns refuted beliefs *with* their corrections — check for KILLED
tags. If a claim you need isn't in the store, it is `assumed` until verified.

**During work:**
- New finding → `assert` (proposed/assumed)
- Verified → `confirm` (CLI *requires* evidence level + provenance)
- Found to be wrong → `refute` (CLI *requires* a replacement — a killed belief
  must leave behind what is actually true; dependents are auto-demoted)

**At session end** — `gen-view` if beliefs changed; run `check`.

## The core rules

1. **Refuted is kept, not deleted.** A wrong belief remembered prevents
   re-deriving it wrong. Every refute links to its replacement.
2. **Evidence is mandatory for confirmation.** `confirm` refuses without
   `--evidence-level` and `--provenance`.
3. **Dependents propagate.** Refuting a belief demotes everything that relied
   on it back to `proposed` — corrections ripple, they don't stall.
4. **BELIEFS.md is generated.** Like `current-state.md` — regenerate, don't edit.
