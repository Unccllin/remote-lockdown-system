# Memory Harness Skill

## When to Invoke

Invoke this skill at two mandatory moments:

1. **Session start** — before taking any action, run RETRIEVE to load relevant memories
2. **Session end** — before closing, run CAPTURE to record what happened

Also invoke opportunistically:
- **During session** — run RECONCILE when you notice a loaded memory is relevant
- **Every 5 sessions** — run CONSOLIDATE to merge raw captures
- **Every 10 sessions** — run DECAY to archive stale memories

## Mandatory Rules

- **Retrieve is mandatory at session start.** Working without memory is working blind.
- **Capture is mandatory at session end.** A session without a capture is a lost session.
- **File references in capture are mandatory.** A capture with zero file paths is invalid.
- **Memories are never deleted** — only archived or superseded.

## Commands

All commands use `scripts/memory.py`:

### Stage 1: CAPTURE (session end)

```bash
python3 scripts/memory.py capture \
  --task "One sentence describing what was asked" \
  --environment "repo, branch, key files" \
  --duration "approximate" \
  --decisions "- decision 1: why
- decision 2: why" \
  --actions "- action 1: result
- action 2: result" \
  --worked "what worked" \
  --failed "what failed" \
  --unexpected "what was unexpected" \
  --learnings "- learning 1
- learning 2" \
  --mistakes "- mistake: what should have happened" \
  --questions "- open question 1" \
  --files "- path/to/file1
- path/to/file2"
```

Optional fields (applied to all consolidated memories from this capture):

```bash
python3 scripts/memory.py capture \
  --task "..." --learnings "- ..." --files "- ..." \
  --source "file:src/capsule.c:42-58" --source "spec:UEFI 2.11 §8.6" \
  --impact "E-HP-UEFI enforcement path" \
  --response "Verify on real hardware before relying on this"
```

- `--source` (repeatable): the actual evidence source — file path with lines,
  URL, or spec section. Stored as `evidence_sources` on the memory. This is
  distinct from `source_sessions` (which agent session observed it).
- `--impact`: why this matters — which decision, enforcement path, debt item,
  or phase this affects.
- `--response`: what the relevant team/agent should consider next.

### Stage 2: CONSOLIDATE (every 5 sessions)

```bash
python3 scripts/memory.py consolidate
```

### Stage 3: RETRIEVE (session start)

```bash
python3 scripts/memory.py retrieve --query "keywords from user request"
```

### Stage 4: RECONCILE (during session, opportunistic)

Six statuses (the five evidence buckets from memory-engineering practice,
minus "new" which is capture's job, plus "outdated" for code drift):

```bash
# Memory confirmed still true
python3 scripts/memory.py reconcile --id m-001 --status confirmed

# Memory partially wrong
python3 scripts/memory.py reconcile --id m-001 --status partial --note "what changed"

# Memory fully wrong — zero confidence, supersede, force-decay after 3 wrongs
python3 scripts/memory.py reconcile --id m-001 --status wrong --replacement "corrected understanding"

# Memory outdated (code changed) — drop confidence to 0.3
python3 scripts/memory.py reconcile --id m-001 --status outdated --note "what changed"

# CHANGED: was true at the time, but stronger/newer evidence replaces it.
# Old confidence is KEPT (it's history, not falsehood); old is marked
# superseded_by the new replacement. Both linked with replaces/replaced_by edges.
python3 scripts/memory.py reconcile --id m-001 --status changed \
  --replacement "new current fact"

# CONTRADICTED: credible sources disagree. Creates a competing memory,
# links both with contradicts/contradicted_by edges, reduces both
# confidences. No winner picked — both stay visible for human resolution.
python3 scripts/memory.py reconcile --id m-001 --status contradicted \
  --replacement "competing claim"
```

Optional fields can be added/updated on any reconcile call:

```bash
# Add evidence sources (repeatable) — the actual file/URL/spec, not just the session
python3 scripts/memory.py reconcile --id m-001 \
  --source "file:src/capsule.c:42-58" --source "spec:UEFI 2.11 §8.6"

# Set why-it-matters (which enforcement path / debt item / phase this affects)
python3 scripts/memory.py reconcile --id m-001 --impact "E-HP-UEFI enforcement path"

# Set what-to-consider-next
python3 scripts/memory.py reconcile --id m-001 --response "Verify on real hardware"

# Add typed relation edges to other memories (repeatable)
python3 scripts/memory.py reconcile --id m-001 \
  --relate "m-005:supports" --relate "m-010:related_to"

# Record the RULE-LEVEL fix (not just the corrected fact) for wrong/outdated/contradicted.
# "Fix the watchlist, source rule, or checking rhythm — not just the final paragraph."
python3 scripts/memory.py reconcile --id m-001 --status wrong \
  --replacement "corrected" \
  --correction-lesson "Always check QueryCapsuleCapabilities before assuming FMP support"
```

Relation edge kinds: `replaces`, `replaced_by`, `contradicts`, `contradicted_by`,
`supports`, `supported_by`, `related_to`. The `changed` and `contradicted`
statuses auto-create the appropriate edges.

### Stage 5: DECAY (every 10 sessions)

```bash
python3 scripts/memory.py decay
```

### CLEANUP (after consolidation, or when duplicates are detected)

```bash
# Merge duplicate memories and fix broken titles
python3 scripts/memory.py cleanup
```

This command groups all consolidated memories by their content (first 5
significant words). For each group with >1 memory, it keeps the one with
the highest confidence, merges source_sessions and seen_count, and marks
the rest as superseded (confidence=0, superseded_by=keeper). It also fixes
any broken nested `# Memory:` headers in the Content section.

### Rebuild index

```bash
python3 scripts/memory.py index
```

### GRAPH — the context graph (opportunistic)

The context graph shows typed relations between memories: which memory
replaces, contradicts, supports, or relates to another. This is the
"connected history" that lets the agent answer a better question tomorrow
instead of rediscovering the argument.

```bash
# Full graph
python3 scripts/memory.py graph

# Subgraph rooted at one memory
python3 scripts/memory.py graph --id m-002

# Filter edges by kind
python3 scripts/memory.py graph --kind contradicts
```

Edges come from the `relations` metadata field (set via `--relate` or
auto-created by `changed`/`contradicted` statuses) plus the `superseded_by`
field (rendered as `replaced_by (superseded)`).

## How to Use Retrieved Memories

When memories are loaded at session start, acknowledge them in your first response:

> "I recall that X — let me verify if it still applies."

Then actively check during the session whether each loaded memory matches
reality. If it does, run RECONCILE with `--status confirmed`. If it
doesn't, run RECONCILE with `--status wrong` or `--status outdated`.

## Storage Layout

```
.devin/memory/
  raw/             # Stage 1 output — session captures
  consolidated/    # Stage 2 output — deduplicated memories
  decayed/         # Stage 5 output — archived memories
  index.md         # Master index (fast path for retrieval)
  .consolidated    # Tracker file — which sessions have been consolidated
```

## Memory File Format (consolidated)

```
# Memory: m-NNN

## Content
<the fact/learning>

## Metadata
- tags: [...]
- confidence: 0.0–1.0
- first_seen: YYYY-MM-DD
- last_seen: YYYY-MM-DD
- seen_count: N
- source_sessions: [sess-001, ...]   # which agent sessions observed it
- superseded_by: m-MMM | null
# Optional (present only when set):
- evidence_sources: [file:path:lines, url:..., spec:...]   # the actual sources
- impact: <which decision/enforcement path/debt item/phase this affects>
- response: <what to consider next>
- relations: [m-MMM:replaces, m-MMM:contradicts, ...]       # context graph edges
- correction_lesson: <rule-level fix for wrong/outdated/contradicted>

## Evidence
- YYYY-MM-DD: Observed in N session(s)
```

All optional fields are backward-compatible: old memories without them
still parse and retrieve correctly.

## Scoring

```
effective_score = confidence × recency_weight × relevance_weight

recency_weight = exp(-days_since_last_seen / 90)   # half-life ~60 days
relevance_weight = 1.0 if seen_count > 3 else 0.5
```

Memories below 0.1 effective_score are archived to `decayed/`.
