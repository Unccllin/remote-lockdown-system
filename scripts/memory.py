#!/usr/bin/env python3
"""
Memory Harness — 5-Stage Persistent Agent Memory

File-based memory system for AI agents. All memory is stored as Markdown
files in .devin/memory/. No external services, no databases.

Stages:
  capture      — Extract session learnings into a raw memory file
  consolidate  — Merge raw captures into deduplicated consolidated memories
  retrieve     — Search index for memories relevant to a query
  reconcile    — Update a memory based on new observations
  decay        — Archive stale memories and rebuild index
  index        — Rebuild the master index from consolidated memories
  init         — Initialize the memory directory structure

Usage:
  python3 scripts/memory.py <stage> [options]

Examples:
  python3 scripts/memory.py init
  python3 scripts/memory.py capture --task "Build capsule update" --session-id sess-001
  python3 scripts/memory.py consolidate
  python3 scripts/memory.py retrieve --query "UEFI capsule QEMU"
  python3 scripts/memory.py reconcile --id m-001 --status confirmed
  python3 scripts/memory.py decay
  python3 scripts/memory.py index
"""

import argparse
import math
import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ─── Constants ───────────────────────────────────────────────────────────────

MEMORY_DIR = Path(__file__).resolve().parent.parent / ".devin" / "memory"
RAW_DIR = MEMORY_DIR / "raw"
CONSOLIDATED_DIR = MEMORY_DIR / "consolidated"
DECAYED_DIR = MEMORY_DIR / "decayed"
INDEX_FILE = MEMORY_DIR / "index.md"

DECAY_HALF_LIFE_DAYS = 60  # recency_weight half-life
DECAY_THRESHOLD = 0.1      # effective_score below this → archive
MAX_INDEX_LINES = 200      # index must stay under this
RETRIEVE_DEFAULT_N = 8     # default number of memories to retrieve
CONSOLIDATE_INTERVAL = 5   # consolidate every N sessions
DECAY_INTERVAL = 10        # decay every N sessions
RECONCILE_CONFIRM_BUMP = 0.05
RECONCILE_PARTIAL_WRONG_PENALTY = 0.2
RECONCILE_WRONG_THRESHOLD = 3  # force-decay after this many wrongs


# ─── Utilities ───────────────────────────────────────────────────────────────

def atomic_write(path: Path, content: str) -> None:
    """Write content to a file atomically using temp-file + rename.

    This prevents half-written files if the process is interrupted
    mid-write. The temp file is created in the same directory as the
    target (so the rename is atomic on POSIX filesystems).
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    tmp.rename(path)


def now_iso():
    return datetime.now().strftime("%Y-%m-%d")


def now_iso_full():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def days_since(date_str):
    """Days since a YYYY-MM-DD date string."""
    try:
        d = datetime.strptime(date_str.strip(), "%Y-%m-%d")
        return (datetime.now() - d).days
    except (ValueError, AttributeError):
        return 9999


def recency_weight(last_seen):
    """exp(-days_since / 90) — half-life ~60 days."""
    days = days_since(last_seen)
    return math.exp(-days / 90.0)


def relevance_weight(seen_count):
    """One-off observations fade faster."""
    return 1.0 if seen_count > 3 else 0.5


def effective_score(confidence, last_seen, seen_count):
    """confidence × recency_weight × relevance_weight."""
    return confidence * recency_weight(last_seen) * relevance_weight(seen_count)


def gen_memory_id():
    """Generate a memory ID like m-001, m-002, etc."""
    existing = []
    if CONSOLIDATED_DIR.exists():
        existing = list(CONSOLIDATED_DIR.glob("m-*.md"))
    if DECAYED_DIR.exists():
        existing.extend(DECAYED_DIR.glob("m-*.md"))
    max_num = 0
    for f in existing:
        m = re.match(r"m-(\d+)", f.stem)
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"m-{max_num + 1:03d}"


def gen_session_id():
    """Generate a session ID like sess-001."""
    existing = list(RAW_DIR.glob("sess-*.md")) if RAW_DIR.exists() else []
    max_num = 0
    for f in existing:
        m = re.match(r"sess-(\d+)", f.stem)
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"sess-{max_num + 1:03d}"


def parse_frontmatter(content):
    """Parse a Markdown memory file into (metadata_dict, body_text).

    body_text is the raw text outside the ## Metadata section (includes
    the # Memory header and ## Content section). Use extract_content()
    to get just the clean content text.
    """
    metadata = {}
    lines = content.split("\n")
    in_metadata = False
    body_lines = []
    current_key = None

    for line in lines:
        if line.strip() == "## Metadata":
            in_metadata = True
            continue
        if in_metadata and line.startswith("## ") and line.strip() != "## Metadata":
            in_metadata = False
        if in_metadata:
            # Parse "- key: value" or "- key: [a, b, c]"
            m = re.match(r"^\s*-\s+(\w+):\s*(.*)", line)
            if m:
                key, value = m.group(1), m.group(2).strip()
                if value.startswith("[") and value.endswith("]"):
                    # List value
                    items = [x.strip().strip("'\"") for x in value[1:-1].split(",") if x.strip()]
                    metadata[key] = items
                elif value in ("null", "None", ""):
                    metadata[key] = None
                else:
                    try:
                        metadata[key] = float(value) if "." in value else int(value)
                    except (ValueError, TypeError):
                        metadata[key] = value
                current_key = key
            elif current_key and line.strip().startswith("- ") and not re.match(r"^\s*-\s+\w+:", line):
                # Continuation of a list
                if isinstance(metadata.get(current_key), list):
                    metadata[current_key].append(line.strip().lstrip("- ").strip("'\""))
        else:
            body_lines.append(line)

    return metadata, "\n".join(body_lines)


def extract_content(body):
    """Extract clean content text from a memory body.

    Strips # Memory headers, ## Content headers, and nested duplicates
    that may have been introduced by botched reconcile operations.
    Returns the first non-empty, non-header line as the content.
    """
    # Find all ## Content sections (there may be nested duplicates)
    content_sections = re.findall(r"## Content\s*\n(.*?)(?=\n## |\Z)", body, re.DOTALL)
    for section in content_sections:
        for line in section.strip().split("\n"):
            line = line.strip()
            # Skip nested # Memory headers and empty lines
            if line and not line.startswith("# Memory:"):
                return line
    # Fallback: first non-header, non-empty line in the whole body
    for line in body.split("\n"):
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("##"):
            return line
    return body.strip()


def read_memory(filepath):
    """Read a memory file and return (id, metadata, body).

    body is the raw text outside ## Metadata. Use extract_content(body)
    to get the clean content text for dedup matching.
    """
    content = filepath.read_text()
    metadata, body = parse_frontmatter(content)
    mid = filepath.stem
    return mid, metadata, body


def extract_tags(text):
    """Extract hashtag-like tags from text."""
    tags = set()
    for m in re.finditer(r"#(\w+)", text):
        tags.add(m.group(1).lower())
    return tags


def keyword_match(query, text):
    """Simple keyword overlap score between query and text."""
    query_words = set(re.findall(r"\w+", query.lower()))
    text_words = set(re.findall(r"\w+", text.lower()))
    if not query_words or not text_words:
        return 0.0
    overlap = len(query_words & text_words)
    return overlap / len(query_words)


# ─── Stage 1: CAPTURE ───────────────────────────────────────────────────────

def stage_capture(args):
    """Extract session learnings into a raw memory file."""
    session_id = args.session_id or gen_session_id()
    date = now_iso()

    # If --from-stdin, read the session transcript from stdin
    transcript = ""
    if args.from_stdin and not sys.stdin.isatty():
        transcript = sys.stdin.read()

    # Build the capture file
    capture = f"""# Session Capture — {date} — {session_id}

## Context
- Task: {args.task or '<not specified>'}
- Environment: {args.environment or '<not specified>'}
- Duration: {args.duration or '<not specified>'}

## Decisions Made
{args.decisions or '- <none recorded>'}

## Actions Taken
{args.actions or '- <none recorded>'}

## Outcomes
- What worked: {args.worked or '<not recorded>'}
- What failed: {args.failed or '<not recorded>'}
- What was unexpected: {args.unexpected or '<not recorded>'}

## Learnings
{args.learnings or '- <none recorded>'}

## Mistakes / Corrections
{args.mistakes or '- <none recorded>'}

## Open Questions
{args.questions or '- <none recorded>'}

## File References
{args.files or '- <none recorded>'}

## Optional Fields (applied to consolidated memories)
- evidence_sources: {", ".join(args.source) if args.source else '<none>'}
- impact: {args.impact or '<none>'}
- response: {args.response or '<none>'}
"""

    # Validate: file references are mandatory
    if not args.files or args.files.strip() == "- <none recorded>":
        print("[WARN] Capture has no file references — this is technically invalid.")
        print("       A capture with zero file paths provides poor context for retrieval.")

    # Write the capture file
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    capture_file = RAW_DIR / f"{session_id}.md"
    atomic_write(capture_file, capture)

    print(f"[OK] Capture written: {capture_file}")
    print(f"     Session ID: {session_id}")
    print(f"     Date: {date}")

    # Check if consolidation should run
    raw_count = len(list(RAW_DIR.glob("sess-*.md")))
    if raw_count % CONSOLIDATE_INTERVAL == 0:
        print(f"\n[INFO] {raw_count} raw captures accumulated — consolidation recommended.")
        print(f"       Run: python3 scripts/memory.py consolidate")

    return session_id


# ─── Stage 2: CONSOLIDATE ───────────────────────────────────────────────────

def stage_consolidate(args):
    """Merge raw captures into deduplicated consolidated memories.

    Only processes raw captures that haven't been consolidated yet (tracked
    via a .consolidated marker file). Uses extract_content() for dedup
    matching so broken titles don't cause false duplicates.
    """
    raw_files = sorted(RAW_DIR.glob("sess-*.md"))
    if not raw_files:
        print("[INFO] No raw captures to consolidate.")
        return

    # Track which sessions have already been consolidated
    consolidated_log = MEMORY_DIR / ".consolidated"
    processed = set()
    if consolidated_log.exists():
        processed = set(consolidated_log.read_text().strip().split("\n"))

    pending_files = [f for f in raw_files if f.stem not in processed]
    if not pending_files:
        print("[INFO] All raw captures already consolidated. Nothing to do.")
        print(f"       (Use 'python3 scripts/memory.py cleanup' to merge duplicates)")
        return

    existing_memories = {}
    for f in CONSOLIDATED_DIR.glob("m-*.md"):
        mid, meta, body = read_memory(f)
        content_text = extract_content(body)
        existing_memories[mid] = {
            "metadata": meta,
            "body": body,
            "content": content_text,
            "file": f,
        }

    # Extract learnings from pending raw captures only
    new_learnings = []
    for raw_file in pending_files:
        content = raw_file.read_text()
        session_id = raw_file.stem

        # Extract optional fields (evidence_sources, impact, response) that
        # apply to all learnings from this session.
        session_optional = {}
        opt_match = re.search(
            r"## Optional Fields.*?\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if opt_match:
            opt_text = opt_match.group(1)
            es_match = re.search(r"- evidence_sources:\s*(.+)", opt_text)
            if es_match and es_match.group(1).strip() != "<none>":
                session_optional["evidence_sources"] = [
                    s.strip() for s in es_match.group(1).split(",") if s.strip()
                ]
            imp_match = re.search(r"- impact:\s*(.+)", opt_text)
            if imp_match and imp_match.group(1).strip() != "<none>":
                session_optional["impact"] = imp_match.group(1).strip()
            resp_match = re.search(r"- response:\s*(.+)", opt_text)
            if resp_match and resp_match.group(1).strip() != "<none>":
                session_optional["response"] = resp_match.group(1).strip()

        # Extract learnings section
        learnings_match = re.search(
            r"## Learnings\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if learnings_match:
            for line in learnings_match.group(1).strip().split("\n"):
                line = line.strip().lstrip("- ").strip()
                if line and line != "<none recorded>":
                    new_learnings.append({
                        "text": line,
                        "session": session_id,
                        "file": raw_file,
                        "optional": session_optional,
                    })

        # Extract mistakes
        mistakes_match = re.search(
            r"## Mistakes / Corrections\s*\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        if mistakes_match:
            for line in mistakes_match.group(1).strip().split("\n"):
                line = line.strip().lstrip("- ").strip()
                if line and line != "<none recorded>":
                    new_learnings.append({
                        "text": f"MISTAKE: {line}",
                        "session": session_id,
                        "file": raw_file,
                        "optional": session_optional,
                    })

    if not new_learnings:
        print("[INFO] No learnings found in pending raw captures.")
        # Still mark as processed
        for f in pending_files:
            processed.add(f.stem)
        atomic_write(consolidated_log, "\n".join(sorted(processed)))
        return

    # Deduplication: group by first 5 significant words
    def learning_key(text):
        words = re.findall(r"\w+", text.lower())
        return " ".join(words[:5])

    grouped = {}
    for learning in new_learnings:
        key = learning_key(learning["text"])
        if key not in grouped:
            grouped[key] = []
        grouped[key].append(learning)

    # Merge with existing memories — use extract_content() for clean matching
    created = 0
    updated = 0

    for key, group in grouped.items():
        matched = False
        for mid, mem in existing_memories.items():
            # Skip superseded memories — they should not be updated
            sup = mem["metadata"].get("superseded_by")
            if sup and sup != "null":
                continue

            # Use the clean content text for dedup matching
            mem_content = mem.get("content", extract_content(mem["body"]))
            mem_key = learning_key(mem_content)
            if mem_key == key or key in mem_content.lower():
                # Update existing memory
                meta = mem["metadata"]
                meta["seen_count"] = int(meta.get("seen_count", 1)) + len(group)
                meta["last_seen"] = now_iso()
                sources = meta.get("source_sessions", [])
                if not isinstance(sources, list):
                    sources = [sources] if sources else []
                for g in group:
                    if g["session"] not in sources:
                        sources.append(g["session"])
                meta["source_sessions"] = sources

                # Bump confidence
                meta["confidence"] = min(1.0, float(meta.get("confidence", 0.5)) + 0.05)

                # Update the file — use clean content, not the raw body
                write_consolidated_memory(mid, mem_content, meta, mem["file"])
                updated += 1
                matched = True
                break

        if not matched:
            # Create new memory
            mid = gen_memory_id()
            optional = group[0].get("optional", {})
            meta = {
                "tags": list(extract_tags(group[0]["text"])),
                "confidence": 0.5,
                "first_seen": now_iso(),
                "last_seen": now_iso(),
                "seen_count": len(group),
                "source_sessions": [g["session"] for g in group],
                "superseded_by": None,
            }
            # Carry optional fields from the capture onto the new memory
            if optional.get("evidence_sources"):
                meta["evidence_sources"] = optional["evidence_sources"]
            if optional.get("impact"):
                meta["impact"] = optional["impact"]
            if optional.get("response"):
                meta["response"] = optional["response"]
            filepath = CONSOLIDATED_DIR / f"{mid}.md"
            write_consolidated_memory(mid, group[0]["text"], meta, filepath)
            created += 1

    # Mark processed sessions
    for f in pending_files:
        processed.add(f.stem)
    atomic_write(consolidated_log, "\n".join(sorted(processed)))

    print(f"[OK] Consolidation complete:")
    print(f"     Processed {len(pending_files)} new raw captures ({len(raw_files)} total)")
    print(f"     Extracted {len(new_learnings)} learnings")
    print(f"     Created {created} new memories")
    print(f"     Updated {updated} existing memories")

    # Rebuild index
    stage_index(args)


def _list_to_str(value):
    """Normalize a metadata field to a comma-joined string, tolerating None/scalar/list."""
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(str(v) for v in value if v)
    return str(value)


def write_consolidated_memory(mid, content, meta, filepath):
    """Write a consolidated memory file.

    Optional fields (evidence_sources, impact, response, relations,
    correction_lesson) are written only when present so old memories
    stay valid and new fields stay opt-in.
    """
    tags_str = _list_to_str(meta.get("tags", []))
    sources = meta.get("source_sessions", [])
    if not isinstance(sources, list):
        sources = [sources] if sources else []
    sources_str = ", ".join(sources)

    # Optional fields — only emitted when non-empty so old memories
    # don't sprout empty lines and the format stays backward-compatible.
    optional_lines = []
    evidence_sources = meta.get("evidence_sources")
    if evidence_sources:
        optional_lines.append(f"- evidence_sources: [{_list_to_str(evidence_sources)}]")
    impact = meta.get("impact")
    if impact:
        optional_lines.append(f"- impact: {impact}")
    response = meta.get("response")
    if response:
        optional_lines.append(f"- response: {response}")
    relations = meta.get("relations")
    if relations:
        optional_lines.append(f"- relations: [{_list_to_str(relations)}]")
    correction_lesson = meta.get("correction_lesson")
    if correction_lesson:
        optional_lines.append(f"- correction_lesson: {correction_lesson}")
    optional_block = "\n".join(optional_lines)
    if optional_block:
        optional_block = "\n" + optional_block

    file_content = f"""# Memory: {mid}

## Content
{content}

## Metadata
- tags: [{tags_str}]
- confidence: {round(float(meta.get("confidence", 0.5)), 2)}
- first_seen: {meta.get("first_seen", now_iso())}
- last_seen: {meta.get("last_seen", now_iso())}
- seen_count: {meta.get("seen_count", 1)}
- source_sessions: [{sources_str}]
- superseded_by: {meta.get("superseded_by") or "null"}{optional_block}

## Evidence
- {meta.get("last_seen", now_iso())}: Observed in {meta.get("seen_count", 1)} session(s)
"""
    atomic_write(filepath, file_content)


# ─── Stage 3: RETRIEVE ──────────────────────────────────────────────────────

def stage_retrieve(args):
    """Search index for memories relevant to a query."""
    if not INDEX_FILE.exists():
        print("[INFO] No index file — no memories to retrieve.")
        return []

    index_content = INDEX_FILE.read_text()

    # Parse the index table
    memories = []
    in_table = False
    for line in index_content.split("\n"):
        if line.startswith("| ID |") or line.startswith("|---|"):
            in_table = True
            continue
        if in_table and line.startswith("|") and line.strip():
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 7:
                mid, title, tags, conf, last_seen, score = parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
                try:
                    score = float(score)
                    conf = float(conf)
                except ValueError:
                    continue
                memories.append({
                    "id": mid,
                    "title": title,
                    "tags": tags,
                    "confidence": conf,
                    "last_seen": last_seen,
                    "score": score,
                })
        elif in_table and not line.startswith("|"):
            in_table = False

    if not memories:
        print("[INFO] No memories in index.")
        return []

    # Score by keyword match against query + tags + title
    query = args.query or ""
    n = args.n or RETRIEVE_DEFAULT_N

    for mem in memories:
        # Read the full memory file for better matching
        mem_file = CONSOLIDATED_DIR / f"{mem['id']}.md"
        full_text = ""
        if mem_file.exists():
            full_text = mem_file.read_text()
        match_score = keyword_match(query, mem["title"] + " " + mem["tags"] + " " + full_text)
        mem["retrieve_score"] = match_score * mem["score"]

    # Sort by retrieve score
    memories.sort(key=lambda m: m["retrieve_score"], reverse=True)

    # Take top N
    top = memories[:n]

    if not top or top[0]["retrieve_score"] == 0:
        print("[INFO] No memories match the query.")
        return []

    # Output
    print("## Relevant Memories (auto-loaded)")
    print()
    for i, mem in enumerate(top, 1):
        print(f"{i}. [confidence {mem['confidence']:.2f}] {mem['title']}")
        print(f"   — score: {mem['retrieve_score']:.3f}, last seen: {mem['last_seen']}")
    print()

    return top


# ─── Stage 4: RECONCILE ────────────────────────────────────────────────────

def _append_relation(meta, relation_str):
    """Append a typed edge 'm-NNN:kind' to meta['relations'], preserving existing."""
    relations = meta.get("relations", [])
    if not isinstance(relations, list):
        relations = [relations] if relations else []
    if relation_str and relation_str not in relations:
        relations.append(relation_str)
    meta["relations"] = relations


def _apply_optional_fields(meta, args):
    """Apply optional fields (source/impact/response/relate/correction_lesson)
    from argparse args onto a metadata dict. Used by reconcile."""
    if getattr(args, "source", None):
        sources = meta.get("evidence_sources", [])
        if not isinstance(sources, list):
            sources = [sources] if sources else []
        for s in args.source:
            if s and s not in sources:
                sources.append(s)
        meta["evidence_sources"] = sources
    if getattr(args, "impact", None):
        meta["impact"] = args.impact
    if getattr(args, "response", None):
        meta["response"] = args.response
    if getattr(args, "relate", None):
        for edge in args.relate:
            _append_relation(meta, edge)
    if getattr(args, "correction_lesson", None):
        meta["correction_lesson"] = args.correction_lesson


def stage_reconcile(args):
    """Update a memory based on new observations.

    Statuses (the article's five buckets, minus 'new' which is capture's job):
      confirmed   — fresh evidence supports the existing view (bump confidence)
      partial     — partly wrong (reduce confidence)
      wrong       — false; zero confidence, supersede, force-decay after 3
      outdated    — code/world moved on (drop confidence to 0.3)
      changed     — was true at the time, but stronger/newer evidence replaces
                    it. Old confidence is KEPT (it's history, not falsehood);
                    old is marked superseded_by the new replacement memory.
      contradicted — credible sources disagree. Creates a competing memory,
                    links both with 'contradicts' edges, reduces both
                    confidences. No winner is picked.
    """
    mid = args.id
    if not mid:
        print("[ERROR] --id is required for reconcile.")
        return

    mem_file = CONSOLIDATED_DIR / f"{mid}.md"
    if not mem_file.exists():
        print(f"[ERROR] Memory {mid} not found.")
        return

    mid_val, meta, body = read_memory(mem_file)
    content_text = extract_content(body)
    status = args.status

    if status == "confirmed":
        meta["confidence"] = min(1.0, float(meta.get("confidence", 0.5)) + RECONCILE_CONFIRM_BUMP)
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)
        print(f"[OK] Memory {mid} confirmed. Confidence bumped to {meta['confidence']:.2f}")

    elif status == "partial":
        old_conf = float(meta.get("confidence", 0.5))
        meta["confidence"] = max(0.0, old_conf - RECONCILE_PARTIAL_WRONG_PENALTY)
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)
        if args.note:
            print(f"     Note: {args.note}")
        print(f"[OK] Memory {mid} partially wrong. Confidence reduced to {meta['confidence']:.2f}")

    elif status == "wrong":
        meta["confidence"] = 0.0
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)

        # Create replacement memory if --replacement provided
        if args.replacement:
            new_id = gen_memory_id()
            new_meta = {
                "tags": meta.get("tags", []),
                "confidence": 0.5,
                "first_seen": now_iso(),
                "last_seen": now_iso(),
                "seen_count": 1,
                "source_sessions": [gen_session_id()],
                "superseded_by": None,
            }
            # Carry the correction lesson onto the replacement
            if meta.get("correction_lesson"):
                new_meta["correction_lesson"] = meta["correction_lesson"]
            new_file = CONSOLIDATED_DIR / f"{new_id}.md"
            write_consolidated_memory(new_id, args.replacement, new_meta, new_file)
            meta["superseded_by"] = new_id
            print(f"[OK] Memory {mid} marked wrong. Replacement: {new_id}")

        # Check force-decay threshold
        wrong_count = int(meta.get("wrong_count", 0)) + 1
        meta["wrong_count"] = wrong_count
        if wrong_count >= RECONCILE_WRONG_THRESHOLD:
            print(f"[WARN] Memory {mid} has been wrong {wrong_count} times — force-decay recommended.")
            print(f"       Run: python3 scripts/memory.py decay")

    elif status == "outdated":
        meta["confidence"] = 0.3
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)
        if args.note:
            print(f"     Note: {args.note}")
        print(f"[OK] Memory {mid} marked outdated. Confidence set to 0.3")

    elif status == "changed":
        # Stronger/newer evidence replaces the current view. The old fact
        # was TRUE AT THE TIME — keep its confidence (it's history, not false),
        # mark it superseded_by the new replacement, and link both with a
        # 'replaces' edge. Requires --replacement.
        if not args.replacement:
            print("[ERROR] --replacement is required for 'changed' status.")
            print("        Usage: reconcile --id m-NNN --status changed "
                  "--replacement \"new current fact\"")
            return
        old_conf = float(meta.get("confidence", 0.5))
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)

        new_id = gen_memory_id()
        new_meta = {
            "tags": meta.get("tags", []),
            "confidence": max(0.5, old_conf),  # new view inherits at least 0.5
            "first_seen": now_iso(),
            "last_seen": now_iso(),
            "seen_count": 1,
            "source_sessions": [gen_session_id()],
            "superseded_by": None,
            "relations": [f"{mid}:replaces"],
        }
        if meta.get("evidence_sources"):
            new_meta["evidence_sources"] = meta["evidence_sources"]
        new_file = CONSOLIDATED_DIR / f"{new_id}.md"
        write_consolidated_memory(new_id, args.replacement, new_meta, new_file)

        # Mark old as superseded but KEEP its confidence (history, not falsehood)
        meta["superseded_by"] = new_id
        _append_relation(meta, f"{new_id}:replaced_by")
        print(f"[OK] Memory {mid} marked changed (kept confidence {old_conf:.2f} as history).")
        print(f"     New current view: {new_id}")

    elif status == "contradicted":
        # Credible sources disagree. Create a competing memory, link BOTH
        # with 'contradicts' edges, reduce both confidences (uncertainty).
        # No winner is picked — both stay visible for human resolution.
        if not args.replacement:
            print("[ERROR] --replacement is required for 'contradicted' status.")
            print("        Usage: reconcile --id m-NNN --status contradicted "
                  "--replacement \"competing claim\"")
            return
        old_conf = float(meta.get("confidence", 0.5))
        # Reduce both — uncertainty
        meta["confidence"] = max(0.1, old_conf - RECONCILE_PARTIAL_WRONG_PENALTY)
        meta["last_seen"] = now_iso()
        _apply_optional_fields(meta, args)

        new_id = gen_memory_id()
        new_meta = {
            "tags": meta.get("tags", []),
            "confidence": 0.4,  # competing claim starts lower
            "first_seen": now_iso(),
            "last_seen": now_iso(),
            "seen_count": 1,
            "source_sessions": [gen_session_id()],
            "superseded_by": None,
            "relations": [f"{mid}:contradicts"],
        }
        new_file = CONSOLIDATED_DIR / f"{new_id}.md"
        write_consolidated_memory(new_id, args.replacement, new_meta, new_file)

        _append_relation(meta, f"{new_id}:contradicted_by")
        print(f"[OK] Memory {mid} contradicted by new claim {new_id}.")
        print(f"     Both kept visible. Old confidence {old_conf:.2f} -> {meta['confidence']:.2f}.")
        print(f"     Resolve with: reconcile --id m-NNN --status confirmed|wrong|changed")

    else:
        print(f"[ERROR] Unknown status: {status}.")
        print("        Use: confirmed, partial, wrong, outdated, changed, contradicted")
        return

    write_consolidated_memory(mid, content_text, meta, mem_file)
    stage_index(args)


# ─── Stage 5: DECAY ─────────────────────────────────────────────────────────

def stage_decay(args):
    """Archive stale memories and rebuild index."""
    mem_files = list(CONSOLIDATED_DIR.glob("m-*.md"))
    if not mem_files:
        print("[INFO] No memories to decay.")
        return

    # Find which memories are referenced by others
    referenced = set()
    for f in mem_files:
        content = f.read_text()
        for m in re.finditer(r"m-\d{3}", content):
            referenced.add(m.group(0))

    archived = 0
    for f in mem_files:
        mid, meta, body = read_memory(f)
        conf = float(meta.get("confidence", 0.5))
        last_seen = meta.get("last_seen", "2020-01-01")
        seen_count = int(meta.get("seen_count", 1))
        superseded = meta.get("superseded_by")

        score = effective_score(conf, last_seen, seen_count)

        # Boost if referenced by other memories
        if mid in referenced:
            score += 0.2

        # Check decay conditions
        should_decay = False
        reason = ""

        if score < DECAY_THRESHOLD:
            should_decay = True
            reason = f"effective_score {score:.3f} < {DECAY_THRESHOLD}"
        elif conf == 0.0 and superseded and superseded != "null":
            should_decay = True
            reason = "superseded and confidence is 0"

        if should_decay:
            # Archive to decayed/ — preserve the FULL original file content
            # (including ## Metadata) so it can be restored losslessly.
            DECAYED_DIR.mkdir(parents=True, exist_ok=True)
            decayed_file = DECAYED_DIR / f.name

            decayed_content = f"""# Decayed Memory: {mid}

## Original Content
{f.read_text()}

## Decay Reason
- last_seen: {last_seen} ({days_since(last_seen)} days ago)
- confidence: {conf}
- effective_score: {score:.3f}
- reason: "{reason}"

## Archived
- date: {now_iso()}
- can_be_restored: true (move back to consolidated/ if needed)
"""
            atomic_write(decayed_file, decayed_content)
            f.unlink()
            archived += 1
            print(f"  [DECAYED] {mid}: {reason}")

    print(f"\n[OK] Decay complete: archived {archived} of {len(mem_files)} memories")

    # Rebuild index
    stage_index(args)


# ─── Cleanup (merge duplicates) ─────────────────────────────────────────────

def stage_cleanup(args):
    """Merge duplicate memories and fix broken titles.

    Groups all consolidated memories by their content (using learning_key
    on extract_content). For each group with >1 memory, keeps the one with
    the highest confidence, merges source_sessions and seen_count, and
    marks the rest as superseded. Also fixes any broken nested # Memory
    headers by rewriting all memories with clean content.
    """
    mem_files = list(CONSOLIDATED_DIR.glob("m-*.md"))
    if not mem_files:
        print("[INFO] No memories to clean up.")
        return

    # Read all memories and extract clean content
    # Only process active (non-superseded) memories for duplicate detection
    memories = {}
    active_mids = []
    for f in mem_files:
        mid, meta, body = read_memory(f)
        content = extract_content(body)
        memories[mid] = {
            "metadata": meta,
            "body": body,
            "content": content,
            "file": f,
        }
        sup = meta.get("superseded_by")
        if not sup or sup == "null":
            active_mids.append(mid)

    # Group active memories by learning_key (first 5 significant words)
    def learning_key(text):
        words = re.findall(r"\w+", text.lower())
        return " ".join(words[:5])

    groups = {}
    for mid in active_mids:
        key = learning_key(memories[mid]["content"])
        if key not in groups:
            groups[key] = []
        groups[key].append(mid)

    # Find duplicates (groups with >1 active memory)
    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}

    merged = 0
    superseded = 0
    fixed_titles = 0

    # First: fix all broken titles by rewriting with clean content
    for mid in active_mids:
        mem = memories[mid]
        old_body = mem["body"]
        clean_content = mem["content"]
        # Check if the body has a nested # Memory header (broken title)
        content_sections = re.findall(r"## Content\s*\n(.*?)(?=\n## |\Z)", old_body, re.DOTALL)
        is_broken = False
        for section in content_sections:
            for line in section.strip().split("\n"):
                line = line.strip()
                if line.startswith("# Memory:"):
                    is_broken = True
                    break
            if is_broken:
                break

        if is_broken:
            # Rewrite with clean content
            write_consolidated_memory(mid, clean_content, mem["metadata"], mem["file"])
            fixed_titles += 1

    # Then: merge duplicates
    for key, mids in dup_groups.items():
        # Sort by confidence (highest first), then seen_count
        mids_sorted = sorted(mids, key=lambda m: (
            float(memories[m]["metadata"].get("confidence", 0.5)),
            int(memories[m]["metadata"].get("seen_count", 1))
        ), reverse=True)

        keeper = mids_sorted[0]
        dups = mids_sorted[1:]

        # Merge metadata from dups into keeper
        keeper_meta = memories[keeper]["metadata"]
        keeper_sources = keeper_meta.get("source_sessions", [])
        if not isinstance(keeper_sources, list):
            keeper_sources = [keeper_sources] if keeper_sources else []

        keeper_seen = int(keeper_meta.get("seen_count", 1))
        keeper_conf = float(keeper_meta.get("confidence", 0.5))

        for dup in dups:
            dup_meta = memories[dup]["metadata"]
            dup_sources = dup_meta.get("source_sessions", [])
            if not isinstance(dup_sources, list):
                dup_sources = [dup_sources] if dup_sources else []

            # Merge source sessions
            for s in dup_sources:
                if s not in keeper_sources:
                    keeper_sources.append(s)

            # Add seen count
            keeper_seen += int(dup_meta.get("seen_count", 1))

            # Take max confidence
            keeper_conf = max(keeper_conf, float(dup_meta.get("confidence", 0.5)))

            # Mark dup as superseded by keeper
            dup_meta["superseded_by"] = keeper
            dup_meta["confidence"] = 0.0
            write_consolidated_memory(dup, memories[dup]["content"], dup_meta, memories[dup]["file"])
            superseded += 1

        # Write updated keeper
        keeper_meta["source_sessions"] = keeper_sources
        keeper_meta["seen_count"] = keeper_seen
        keeper_meta["confidence"] = min(1.0, keeper_conf)
        keeper_meta["last_seen"] = now_iso()
        write_consolidated_memory(keeper, memories[keeper]["content"], keeper_meta, memories[keeper]["file"])
        merged += 1

    print(f"[OK] Cleanup complete:")
    print(f"     Total memories: {len(memories)}")
    print(f"     Duplicate groups merged: {merged}")
    print(f"     Memories superseded: {superseded}")
    print(f"     Broken titles fixed: {fixed_titles}")

    # Rebuild index
    stage_index(args)


# ─── Index Management ───────────────────────────────────────────────────────

def stage_index(args):
    """Rebuild the master index from consolidated memories."""
    mem_files = list(CONSOLIDATED_DIR.glob("m-*.md"))
    decayed_files = list(DECAYED_DIR.glob("m-*.md"))

    entries = []
    superseded = []
    decayed = []

    for f in mem_files:
        mid, meta, body = read_memory(f)
        conf = float(meta.get("confidence", 0.5))
        last_seen = meta.get("last_seen", "2020-01-01")
        seen_count = int(meta.get("seen_count", 1))
        score = effective_score(conf, last_seen, seen_count)

        # Extract title using extract_content() — handles broken nested headers
        title = extract_content(body)[:60]

        # Get tags
        tags = meta.get("tags", [])
        if isinstance(tags, list):
            tags_str = ", ".join(tags)
        else:
            tags_str = str(tags)

        # Relations count (context graph edges) + impact
        relations = meta.get("relations", [])
        if not isinstance(relations, list):
            relations = [relations] if relations else []
        rel_count = len(relations)
        # superseded_by counts as an implicit edge
        sup_field = meta.get("superseded_by")
        if sup_field and sup_field != "null" and not any(
            str(r).startswith(f"{sup_field}:") for r in relations
        ):
            rel_count += 1
        impact = meta.get("impact") or ""

        sup = meta.get("superseded_by")
        if sup and sup != "null":
            superseded.append({"id": mid, "title": title, "superseded_by": sup, "date": last_seen})
        else:
            entries.append({
                "id": mid,
                "title": title,
                "tags": tags_str,
                "confidence": conf,
                "last_seen": last_seen,
                "score": score,
                "rel_count": rel_count,
                "impact": impact,
            })

    # Parse decayed memories
    for f in decayed_files:
        mid = f.stem
        content = f.read_text()
        title_match = re.search(r"^# Decayed Memory:\s*(.+)$", content, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else mid
        date_match = re.search(r"- date:\s*(\d{4}-\d{2}-\d{2})", content)
        reason_match = re.search(r'- reason:\s*"(.*?)"', content)
        decayed.append({
            "id": mid,
            "title": title,
            "date": date_match.group(1) if date_match else "",
            "reason": reason_match.group(1) if reason_match else "",
        })

    # Sort active by score
    entries.sort(key=lambda e: e["score"], reverse=True)

    # Build index
    lines = []
    lines.append("# Memory Index")
    lines.append("")
    lines.append(f"Last rebuilt: {now_iso_full()}")
    lines.append(f"Active memories: {len(entries)} | Superseded: {len(superseded)} | Decayed: {len(decayed)}")
    lines.append("")

    if entries:
        lines.append("## Active Memories (sorted by effective_score)")
        lines.append("")
        lines.append("| ID | Title | Tags | Conf | Last Seen | Score | Rel | Impact |")
        lines.append("|----|-------|------|------|-----------|-------|-----|--------|")
        for e in entries:
            lines.append(
                f"| {e['id']} | {e['title'][:50]} | {e['tags'][:18]} | "
                f"{e['confidence']:.2f} | {e['last_seen']} | {e['score']:.3f} | "
                f"{e['rel_count']} | {e['impact'][:30]} |"
            )
        lines.append("")

    if superseded:
        lines.append("## Superseded Memories")
        lines.append("")
        lines.append("| ID | Title | Superseded By | Date |")
        lines.append("|----|-------|---------------|------|")
        for s in superseded:
            lines.append(f"| {s['id']} | {s['title'][:50]} | {s['superseded_by']} | {s['date']} |")
        lines.append("")

    if decayed:
        lines.append("## Decayed Memories (archived)")
        lines.append("")
        lines.append("| ID | Title | Decayed On | Reason |")
        lines.append("|----|-------|------------|--------|")
        for d in decayed:
            lines.append(f"| {d['id']} | {d['title'][:50]} | {d['date']} | {d['reason'][:40]} |")
        lines.append("")

    # Check line count
    content = "\n".join(lines)
    line_count = len(lines)
    if line_count > MAX_INDEX_LINES:
        print(f"[WARN] Index has {line_count} lines (max {MAX_INDEX_LINES}). Consider running decay.")

    atomic_write(INDEX_FILE, content)
    print(f"[OK] Index rebuilt: {len(entries)} active, {len(superseded)} superseded, {len(decayed)} decayed")


# ─── Init ────────────────────────────────────────────────────────────────────

def stage_init(args):
    """Initialize the memory directory structure."""
    for d in [RAW_DIR, CONSOLIDATED_DIR, DECAYED_DIR]:
        d.mkdir(parents=True, exist_ok=True)
        print(f"  [OK] {d}")

    if not INDEX_FILE.exists():
        atomic_write(INDEX_FILE, "# Memory Index\n\nNo memories yet.\n")
        print(f"  [OK] {INDEX_FILE} (initialized)")

    print("\n[OK] Memory harness initialized.")
    print(f"     Memory dir: {MEMORY_DIR}")
    print(f"     Stages: capture, consolidate, retrieve, reconcile, decay, index")


# ─── Graph (context graph — the article's central idea) ─────────────────────

def _parse_relations(meta):
    """Parse the relations field into a list of (target_mid, kind) tuples."""
    relations = meta.get("relations", [])
    if not isinstance(relations, list):
        relations = [relations] if relations else []
    edges = []
    for r in relations:
        if not r or ":" not in str(r):
            continue
        target, kind = str(r).split(":", 1)
        edges.append((target.strip(), kind.strip()))
    return edges


def stage_graph(args):
    """Print the context graph of typed relations between memories.

    Edges come from the 'relations' metadata field (m-NNN:kind) plus the
    'superseded_by' field (rendered as a 'replaced_by' edge). This is the
    article's 'context graph': competitor -> changed -> price, claim ->
    supported by -> source, old finding -> replaced by -> current finding.
    """
    mem_files = list(CONSOLIDATED_DIR.glob("m-*.md"))
    if not mem_files:
        print("[INFO] No memories to graph.")
        return

    memories = {}
    for f in mem_files:
        mid, meta, body = read_memory(f)
        memories[mid] = {
            "meta": meta,
            "title": extract_content(body)[:70],
        }

    # Collect edges: (source_mid, kind, target_mid)
    edges = []
    for mid, mem in memories.items():
        for target, kind in _parse_relations(mem["meta"]):
            edges.append((mid, kind, target))
        # superseded_by is an implicit replaced_by edge
        sup = mem["meta"].get("superseded_by")
        if sup and sup != "null" and not any(
            e[0] == mid and e[2] == sup for e in edges
        ):
            edges.append((mid, "replaced_by (superseded)", sup))

    # Filter
    if getattr(args, "kind", None):
        edges = [e for e in edges if args.kind in e[1]]
    if getattr(args, "id", None):
        root = args.id
        keep_ids = {root}
        for s, k, t in edges:
            if s == root:
                keep_ids.add(t)
            if t == root:
                keep_ids.add(s)
        edges = [e for e in edges if e[0] in keep_ids or e[2] in keep_ids]
        memories = {m: v for m, v in memories.items() if m in keep_ids}

    if not edges:
        if getattr(args, "id", None) or getattr(args, "kind", None):
            print("[INFO] No edges match the filter.")
        else:
            print("[INFO] No relations recorded yet.")
            print("       Add edges with: reconcile --id m-NNN --relate m-MMM:supports")
            print("       Or via changed/contradicted statuses, which auto-create edges.")
        return

    # Group edges by source for readable output
    by_source = {}
    for s, k, t in edges:
        by_source.setdefault(s, []).append((k, t))

    print("# Memory Context Graph")
    print()
    print(f"Nodes: {len(memories)} memories | Edges: {len(edges)} relations")
    print()
    for source in sorted(by_source.keys()):
        mem = memories.get(source)
        src_title = mem["title"] if mem else source
        print(f"{source} — {src_title}")
        for kind, target in sorted(by_source[source]):
            tgt_mem = memories.get(target)
            tgt_title = tgt_mem["title"] if tgt_mem else "(missing)"
            print(f"  -[{kind}]-> {target} — {tgt_title}")
        print()


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Memory Harness — 5-Stage Persistent Agent Memory",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="stage", help="Memory stage to run")

    # init
    sub_init = subparsers.add_parser("init", help="Initialize memory directory structure")

    # capture
    sub_capture = subparsers.add_parser("capture", help="Stage 1: Extract session learnings")
    sub_capture.add_argument("--task", help="What was the agent asked to do")
    sub_capture.add_argument("--environment", help="Repo, branch, key files")
    sub_capture.add_argument("--duration", help="Approximate session duration")
    sub_capture.add_argument("--decisions", help="Decisions made (one per line)")
    sub_capture.add_argument("--actions", help="Actions taken (one per line)")
    sub_capture.add_argument("--worked", help="What worked")
    sub_capture.add_argument("--failed", help="What failed")
    sub_capture.add_argument("--unexpected", help="What was unexpected")
    sub_capture.add_argument("--learnings", help="Learnings (one per line)")
    sub_capture.add_argument("--mistakes", help="Mistakes/corrections (one per line)")
    sub_capture.add_argument("--questions", help="Open questions (one per line)")
    sub_capture.add_argument("--files", help="File paths touched (mandatory)")
    sub_capture.add_argument("--session-id", help="Session ID (auto-generated if omitted)")
    sub_capture.add_argument("--from-stdin", action="store_true", help="Read transcript from stdin")
    sub_capture.add_argument("--source", action="append", default=[], metavar="EVIDENCE",
                             help="Evidence source for learnings (repeatable): "
                                  "'file:path:lines', 'url:https://...', 'spec:UEFI 2.11 §13.3'. "
                                  "Stored on consolidated memories as evidence_sources.")
    sub_capture.add_argument("--impact", help="Why this matters — which decision, enforcement "
                                              "path, debt item, or phase this affects")
    sub_capture.add_argument("--response", help="What the relevant team/agent should consider next")

    # consolidate
    sub_consolidate = subparsers.add_parser("consolidate", help="Stage 2: Merge raw captures")

    # retrieve
    sub_retrieve = subparsers.add_parser("retrieve", help="Stage 3: Search for relevant memories")
    sub_retrieve.add_argument("--query", help="Search query")
    sub_retrieve.add_argument("-n", type=int, help=f"Number of memories (default {RETRIEVE_DEFAULT_N})")

    # reconcile
    sub_reconcile = subparsers.add_parser("reconcile", help="Stage 4: Update a memory")
    sub_reconcile.add_argument("--id", help="Memory ID (e.g., m-001)")
    sub_reconcile.add_argument("--status",
                               choices=["confirmed", "partial", "wrong", "outdated",
                                        "changed", "contradicted"],
                               help="Reconciliation status (changed/contradicted need --replacement)")
    sub_reconcile.add_argument("--note", help="Note about what changed")
    sub_reconcile.add_argument("--replacement", help="Replacement text for wrong/changed/contradicted")
    sub_reconcile.add_argument("--source", action="append", default=[], metavar="EVIDENCE",
                               help="Add an evidence source to this memory (repeatable)")
    sub_reconcile.add_argument("--impact", help="Set/update the 'why it matters' field")
    sub_reconcile.add_argument("--response", help="Set/update the 'what to consider next' field")
    sub_reconcile.add_argument("--relate", action="append", default=[], metavar="m-NNN:KIND",
                               help="Add a typed relation edge (repeatable). "
                                    "KINDs: replaces, replaced_by, contradicts, contradicted_by, "
                                    "supports, supported_by, related_to")
    sub_reconcile.add_argument("--correction-lesson", metavar="LESSON",
                               help="Rule-level fix for wrong/outdated/contradicted: what rule, "
                                    "source, or checking rhythm should change so the next capture "
                                    "avoids this error (not just the corrected fact)")

    # decay
    sub_decay = subparsers.add_parser("decay", help="Stage 5: Archive stale memories")

    # cleanup
    sub_cleanup = subparsers.add_parser("cleanup", help="Merge duplicate memories and fix broken titles")

    # index
    sub_index = subparsers.add_parser("index", help="Rebuild the master index")

    # graph — the context graph (article's central idea)
    sub_graph = subparsers.add_parser("graph", help="Print the context graph of relations between memories")
    sub_graph.add_argument("--id", help="Show only the subgraph rooted at one memory (e.g., m-002)")
    sub_graph.add_argument("--kind", help="Filter edges by kind (replaces, contradicts, supports, ...)")

    args = parser.parse_args()

    if args.stage == "init":
        stage_init(args)
    elif args.stage == "capture":
        stage_capture(args)
    elif args.stage == "consolidate":
        stage_consolidate(args)
    elif args.stage == "retrieve":
        stage_retrieve(args)
    elif args.stage == "reconcile":
        stage_reconcile(args)
    elif args.stage == "decay":
        stage_decay(args)
    elif args.stage == "cleanup":
        stage_cleanup(args)
    elif args.stage == "index":
        stage_index(args)
    elif args.stage == "graph":
        stage_graph(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
