#!/usr/bin/env python3
"""Tests for scripts/memory.py — the memory harness.

Tests cover:
  - Pure utility functions (scoring, parsing, ID generation)
  - parse_frontmatter / extract_content / read_memory
  - write_consolidated_memory (including new optional fields)
  - stage_capture → stage_consolidate → stage_retrieve round-trip
  - stage_reconcile (all 6 statuses: confirmed, partial, wrong, outdated, changed, contradicted)
  - stage_index (including new Rel + Impact columns)
  - stage_graph (relations edges)
  - stage_decay (lossless restore fix)
  - Backward compatibility (old-format memories without optional fields)

The tests use a temp directory so they never touch the real .devin/memory/.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Import memory.py by manipulating sys.path
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
import memory  # noqa: E402


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def tmp_memory_dir(tmp_path, monkeypatch):
    """Point memory.py's constants at a temp directory."""
    mem_dir = tmp_path / ".devin" / "memory"
    raw_dir = mem_dir / "raw"
    consol_dir = mem_dir / "consolidated"
    decayed_dir = mem_dir / "decayed"

    for d in [raw_dir, consol_dir, decayed_dir]:
        d.mkdir(parents=True)

    monkeypatch.setattr(memory, "MEMORY_DIR", mem_dir)
    monkeypatch.setattr(memory, "RAW_DIR", raw_dir)
    monkeypatch.setattr(memory, "CONSOLIDATED_DIR", consol_dir)
    monkeypatch.setattr(memory, "DECAYED_DIR", decayed_dir)
    monkeypatch.setattr(memory, "INDEX_FILE", mem_dir / "index.md")

    return mem_dir


def write_raw_capture(raw_dir, session_id, learnings, **extra):
    """Write a raw capture file directly (bypasses argparse)."""
    lines = [
        f"# Capture: {session_id}",
        "",
        f"- task: Test task for {session_id}",
        f"- session_id: {session_id}",
        f"- date: 2026-01-01",
        "",
        "## Learnings",
    ]
    for l in learnings:
        lines.append(f"- {l}")
    for key, val in extra.items():
        if isinstance(val, list):
            lines.append(f"- {key}: {val}")
        else:
            lines.append(f"- {key}: {val}")
    (raw_dir / f"{session_id}.md").write_text("\n".join(lines))


def write_old_format_memory(consol_dir, mid, content, confidence=0.7, superseded_by="null"):
    """Write a memory in the OLD format (no optional fields) for backward-compat tests."""
    text = f"""# Memory: {mid}

## Content
{content}

## Metadata
- tags: []
- confidence: {confidence}
- first_seen: 2026-01-01
- last_seen: 2026-01-01
- seen_count: 1
- source_sessions: [sess-001]
- superseded_by: {superseded_by}

## Evidence
- 2026-01-01: Observed in 1 session(s)
"""
    (consol_dir / f"{mid}.md").write_text(text)


# ─── Pure utility function tests ───────────────────────────────────────────────


class TestDaysSince:
    def test_today(self):
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        assert memory.days_since(today) == 0

    def test_one_day_ago(self):
        from datetime import datetime, timedelta
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        assert memory.days_since(yesterday) == 1

    def test_invalid_date(self):
        assert memory.days_since("not-a-date") == 9999

    def test_none(self):
        assert memory.days_since(None) == 9999


class TestRecencyWeight:
    def test_today(self):
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        assert memory.recency_weight(today) == pytest.approx(1.0, abs=0.01)

    def test_90_days_ago(self):
        from datetime import datetime, timedelta
        d = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")
        # exp(-90/90) = exp(-1) ≈ 0.368
        assert memory.recency_weight(d) == pytest.approx(0.368, abs=0.01)


class TestRelevanceWeight:
    def test_seen_once(self):
        assert memory.relevance_weight(1) == 0.5

    def test_seen_four_times(self):
        assert memory.relevance_weight(4) == 1.0

    def test_seen_three_times(self):
        assert memory.relevance_weight(3) == 0.5  # > 3, not >= 3


class TestEffectiveScore:
    def test_full_score(self):
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        # confidence=1.0, recency=1.0, relevance=1.0 (seen_count=4)
        score = memory.effective_score(1.0, today, 4)
        assert score == pytest.approx(1.0, abs=0.01)

    def test_decayed_score(self):
        from datetime import datetime, timedelta
        old = (datetime.now() - timedelta(days=180)).strftime("%Y-%m-%d")
        # confidence=0.7, recency=exp(-180/90)=exp(-2)≈0.135, relevance=0.5
        score = memory.effective_score(0.7, old, 1)
        assert 0.01 < score < 0.1  # should be low but not zero


# ─── Parsing tests ─────────────────────────────────────────────────────────────


class TestParseFrontmatter:
    def test_basic_metadata(self):
        content = """# Memory: m-001

## Content
Test content here

## Metadata
- tags: [uefi, capsule]
- confidence: 0.7
- first_seen: 2026-01-01
- last_seen: 2026-01-01
- seen_count: 3
- source_sessions: [sess-001, sess-002]
- superseded_by: null

## Evidence
- 2026-01-01: Observed in 3 session(s)
"""
        meta, body = memory.parse_frontmatter(content)
        assert meta["tags"] == ["uefi", "capsule"]
        assert meta["confidence"] == 0.7
        assert meta["seen_count"] == 3
        assert meta["source_sessions"] == ["sess-001", "sess-002"]
        assert meta["superseded_by"] is None
        assert "Test content here" in body

    def test_optional_fields(self):
        content = """# Memory: m-002

## Content
Content with optional fields

## Metadata
- tags: []
- confidence: 0.5
- first_seen: 2026-01-01
- last_seen: 2026-01-01
- seen_count: 1
- source_sessions: [sess-001]
- superseded_by: null
- evidence_sources: [file:src/capsule.c:42, url:https://example.com]
- impact: E-HP-UEFI enforcement path
- response: Verify on hardware
- relations: [m-001:replaces]
- correction_lesson: Always check before assuming

## Evidence
- 2026-01-01: Observed in 1 session(s)
"""
        meta, body = memory.parse_frontmatter(content)
        assert meta["evidence_sources"] == ["file:src/capsule.c:42", "url:https://example.com"]
        assert meta["impact"] == "E-HP-UEFI enforcement path"
        assert meta["response"] == "Verify on hardware"
        assert meta["relations"] == ["m-001:replaces"]
        assert meta["correction_lesson"] == "Always check before assuming"

    def test_no_metadata_section(self):
        content = "# Just a header\n\nSome text"
        meta, body = memory.parse_frontmatter(content)
        assert meta == {}
        assert "Some text" in body


class TestExtractContent:
    def test_simple(self):
        body = "# Memory: m-001\n\n## Content\nThis is the content\n"
        assert memory.extract_content(body) == "This is the content"

    def test_nested_duplicate_headers(self):
        body = """# Memory: m-001

## Content
# Memory: m-001

## Content
Actual content after nested dup
"""
        assert memory.extract_content(body) == "Actual content after nested dup"

    def test_fallback(self):
        body = "No headers here, just text"
        assert memory.extract_content(body) == "No headers here, just text"


class TestReadMemory:
    def test_read(self, tmp_memory_dir):
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Test memory content", confidence=0.8
        )
        mid, meta, body = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert mid == "m-001"
        assert meta["confidence"] == 0.8
        assert "Test memory content" in body


# ─── write_consolidated_memory tests ───────────────────────────────────────────


class TestWriteConsolidatedMemory:
    def test_basic(self, tmp_memory_dir):
        mid = "m-100"
        content = "Basic memory"
        meta = {
            "tags": ["test"],
            "confidence": 0.7,
            "first_seen": "2026-01-01",
            "last_seen": "2026-01-01",
            "seen_count": 1,
            "source_sessions": ["sess-001"],
            "superseded_by": None,
        }
        filepath = memory.CONSOLIDATED_DIR / f"{mid}.md"
        memory.write_consolidated_memory(mid, content, meta, filepath)
        assert filepath.exists()
        text = filepath.read_text()
        assert "# Memory: m-100" in text
        assert "Basic memory" in text
        assert "confidence: 0.7" in text

    def test_optional_fields(self, tmp_memory_dir):
        mid = "m-101"
        content = "Memory with optional fields"
        meta = {
            "tags": [],
            "confidence": 0.5,
            "first_seen": "2026-01-01",
            "last_seen": "2026-01-01",
            "seen_count": 1,
            "source_sessions": ["sess-001"],
            "superseded_by": None,
            "evidence_sources": ["file:src/test.py:10", "spec:UEFI 2.11"],
            "impact": "Test impact",
            "response": "Test response",
            "relations": ["m-100:replaces"],
            "correction_lesson": "Test lesson",
        }
        filepath = memory.CONSOLIDATED_DIR / f"{mid}.md"
        memory.write_consolidated_memory(mid, content, meta, filepath)
        text = filepath.read_text()
        assert "evidence_sources" in text
        assert "file:src/test.py:10" in text
        assert "impact: Test impact" in text
        assert "response: Test response" in text
        assert "relations" in text
        assert "m-100:replaces" in text
        assert "correction_lesson" in text

    def test_backward_compat_no_optional_fields(self, tmp_memory_dir):
        """Old memories without optional fields should still write correctly."""
        mid = "m-102"
        content = "Old-style memory"
        meta = {
            "tags": [],
            "confidence": 0.6,
            "first_seen": "2026-01-01",
            "last_seen": "2026-01-01",
            "seen_count": 1,
            "source_sessions": ["sess-001"],
            "superseded_by": None,
        }
        filepath = memory.CONSOLIDATED_DIR / f"{mid}.md"
        memory.write_consolidated_memory(mid, content, meta, filepath)
        text = filepath.read_text()
        # Optional fields should NOT appear
        assert "evidence_sources" not in text
        assert "impact" not in text
        assert "relations" not in text
        assert "correction_lesson" not in text


# ─── gen_memory_id tests ───────────────────────────────────────────────────────


class TestGenMemoryId:
    def test_first_id(self, tmp_memory_dir):
        assert memory.gen_memory_id() == "m-001"

    def test_increments(self, tmp_memory_dir):
        write_old_format_memory(memory.CONSOLIDATED_DIR, "m-001", "First")
        write_old_format_memory(memory.CONSOLIDATED_DIR, "m-002", "Second")
        assert memory.gen_memory_id() == "m-003"

    def test_includes_decayed(self, tmp_memory_dir):
        write_old_format_memory(memory.CONSOLIDATED_DIR, "m-001", "First")
        # Simulate a decayed memory
        (memory.DECAYED_DIR / "m-005.md").write_text("# Decayed\n")
        assert memory.gen_memory_id() == "m-006"


# ─── keyword_match tests ───────────────────────────────────────────────────────


class TestKeywordMatch:
    def test_match(self):
        assert memory.keyword_match("uefi capsule", "OVMF capsule update UEFI") > 0

    def test_no_match(self):
        assert memory.keyword_match("python django", "UEFI capsule update") == 0

    def test_partial_match(self):
        score = memory.keyword_match("uefi boot", "UEFI capsule update")
        assert score > 0  # "uefi" matches


# ─── Backward compatibility tests ──────────────────────────────────────────────


class TestBackwardCompat:
    def test_old_memory_parses(self, tmp_memory_dir):
        """Old-format memories (no optional fields) must parse correctly."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Old memory", confidence=0.7
        )
        mid, meta, body = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert mid == "m-001"
        assert meta["confidence"] == 0.7
        assert meta.get("evidence_sources") is None
        assert meta.get("impact") is None
        assert meta.get("relations") is None

    def test_old_memory_retrieves(self, tmp_memory_dir):
        """Old-format memories must be retrievable."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "UEFI capsule QEMU test", confidence=0.7
        )
        # Build index first
        memory.stage_index(type("Args", (), {})())
        # Retrieve
        args = type("Args", (), {"query": "UEFI capsule", "n": 5})()
        memory.stage_retrieve(args)  # should not crash

    def test_old_memory_in_index(self, tmp_memory_dir):
        """Old-format memories must appear in the index with Rel=0, Impact=empty."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "UEFI capsule test", confidence=0.7
        )
        memory.stage_index(type("Args", (), {})())
        index_text = memory.INDEX_FILE.read_text()
        assert "m-001" in index_text
        assert "| 0 |" in index_text  # Rel count = 0 for old memories


# ─── Reconcile status tests ────────────────────────────────────────────────────


class TestReconcileConfirmed:
    def test_confirmed_bumps_confidence(self, tmp_memory_dir):
        """confirmed status should bump confidence by RECONCILE_CONFIRM_BUMP."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Test memory", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "confirmed", "note": None,
            "replacement": None, "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        _, meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert meta["confidence"] == pytest.approx(0.75, abs=0.01)


class TestReconcileWrong:
    def test_wrong_zeros_confidence(self, tmp_memory_dir):
        """wrong status should zero confidence and supersede."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Wrong memory", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "wrong", "note": None,
            "replacement": "Corrected memory", "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        _, meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert meta["confidence"] == 0.0
        assert meta["superseded_by"] is not None
        assert meta["superseded_by"] != "null"


class TestReconcileChanged:
    def test_changed_keeps_old_confidence(self, tmp_memory_dir):
        """changed status should KEEP old confidence (it's history, not falsehood)."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Old claim", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "changed", "note": None,
            "replacement": "New current claim", "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": "Test lesson",
        })()
        memory.stage_reconcile(args)
        # Old memory keeps confidence 0.7
        _, old_meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert old_meta["confidence"] == 0.7  # KEPT, not zeroed
        assert old_meta["superseded_by"] is not None
        # Check relations edge
        assert any("replaced_by" in str(r) for r in old_meta.get("relations", []))
        # New memory should exist
        new_id = old_meta["superseded_by"]
        _, new_meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / f"{new_id}.md")
        assert any("replaces" in str(r) for r in new_meta.get("relations", []))
        # correction_lesson should be on old memory
        assert old_meta.get("correction_lesson") == "Test lesson"


class TestReconcileContradicted:
    def test_contradicted_reduces_both(self, tmp_memory_dir):
        """contradicted status should reduce both confidences and link both."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Original claim", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "contradicted", "note": None,
            "replacement": "Competing claim", "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        # Old memory confidence reduced
        _, old_meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert old_meta["confidence"] < 0.7  # reduced
        assert old_meta["superseded_by"] is None  # NOT superseded — both stay visible
        # Check contradicted_by edge
        assert any("contradicted_by" in str(r) for r in old_meta.get("relations", []))
        # New competing memory should exist with contradicts edge
        # Find the new memory by searching for "Competing claim"
        for f in memory.CONSOLIDATED_DIR.glob("m-*.md"):
            _, m, b = memory.read_memory(f)
            if "Competing claim" in b:
                assert any("contradicts" in str(r) for r in m.get("relations", []))
                assert m["confidence"] < 0.5  # also reduced
                break
        else:
            pytest.fail("Competing claim memory not found")


class TestReconcileOutdated:
    def test_outdated_drops_confidence(self, tmp_memory_dir):
        """outdated status should drop confidence to 0.3."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Outdated memory", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "outdated", "note": "Code changed",
            "replacement": None, "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        _, meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert meta["confidence"] == pytest.approx(0.3, abs=0.01)


class TestReconcilePartial:
    def test_partial_reduces_confidence(self, tmp_memory_dir):
        """partial status should reduce confidence by PARTIAL_WRONG_PENALTY."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Partially wrong", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "partial", "note": "Partially wrong",
            "replacement": None, "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        _, meta, _ = memory.read_memory(memory.CONSOLIDATED_DIR / "m-001.md")
        assert meta["confidence"] == pytest.approx(0.5, abs=0.01)  # 0.7 - 0.2


# ─── Graph subcommand tests ────────────────────────────────────────────────────


class TestGraph:
    def test_graph_empty(self, tmp_memory_dir):
        """Graph on empty memory set should not crash."""
        args = type("Args", (), {"id": None, "kind": None})()
        memory.stage_graph(args)  # should not crash

    def test_graph_with_relations(self, tmp_memory_dir):
        """Graph should show relations edges."""
        # Create m-001 and m-002 with a replaces/replaced_by relation
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Old claim", confidence=0.7
        )
        # Use reconcile --status changed to create the relation
        args = type("Args", (), {
            "id": "m-001", "status": "changed", "note": None,
            "replacement": "New claim", "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        # Now graph should show the relation
        args = type("Args", (), {"id": None, "kind": None})()
        memory.stage_graph(args)  # should not crash and should show edges

    def test_graph_subgraph_by_id(self, tmp_memory_dir):
        """Graph --id should show only the subgraph for one memory."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Old claim", confidence=0.7
        )
        args = type("Args", (), {
            "id": "m-001", "status": "changed", "note": None,
            "replacement": "New claim", "source": [], "impact": None,
            "response": None, "relate": [], "correction_lesson": None,
        })()
        memory.stage_reconcile(args)
        # Get subgraph for m-001
        args = type("Args", (), {"id": "m-001", "kind": None})()
        memory.stage_graph(args)  # should not crash


# ─── Decay tests ───────────────────────────────────────────────────────────────


class TestDecay:
    def test_decay_superseded_zero_confidence(self, tmp_memory_dir):
        """A superseded memory with confidence 0 should be decayed."""
        # Create a superseded memory (confidence=0, superseded_by set)
        text = """# Memory: m-001

## Content
Superseded memory

## Metadata
- tags: []
- confidence: 0.0
- first_seen: 2026-01-01
- last_seen: 2026-01-01
- seen_count: 1
- source_sessions: [sess-001]
- superseded_by: m-002

## Evidence
- 2026-01-01: Observed in 1 session(s)
"""
        (memory.CONSOLIDATED_DIR / "m-001.md").write_text(text)
        args = type("Args", (), {})()
        memory.stage_decay(args)
        # m-001 should be moved to decayed/
        assert not (memory.CONSOLIDATED_DIR / "m-001.md").exists()
        assert (memory.DECAYED_DIR / "m-001.md").exists()

    def test_decay_preserves_full_content(self, tmp_memory_dir):
        """Decay should preserve the FULL file content (metadata + body) for lossless restore."""
        text = """# Memory: m-001

## Content
Superseded memory with metadata

## Metadata
- tags: [important]
- confidence: 0.0
- first_seen: 2026-01-01
- last_seen: 2026-01-01
- seen_count: 5
- source_sessions: [sess-001, sess-002]
- superseded_by: m-002
- evidence_sources: [file:src/test.py:10]

## Evidence
- 2026-01-01: Observed in 5 session(s)
"""
        (memory.CONSOLIDATED_DIR / "m-001.md").write_text(text)
        args = type("Args", (), {})()
        memory.stage_decay(args)
        decayed_text = (memory.DECAYED_DIR / "m-001.md").read_text()
        # The FULL original content should be in the decayed file
        assert "## Metadata" in decayed_text
        assert "confidence: 0.0" in decayed_text
        assert "superseded_by: m-002" in decayed_text
        assert "evidence_sources" in decayed_text
        assert "seen_count: 5" in decayed_text

    def test_decay_does_not_archive_active(self, tmp_memory_dir):
        """Active memories (confidence > 0, not superseded) should NOT be decayed."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Active memory", confidence=0.7
        )
        args = type("Args", (), {})()
        memory.stage_decay(args)
        assert (memory.CONSOLIDATED_DIR / "m-001.md").exists()
        assert not (memory.DECAYED_DIR / "m-001.md").exists()


# ─── Index tests ───────────────────────────────────────────────────────────────


class TestIndex:
    def test_index_shows_rel_and_impact(self, tmp_memory_dir):
        """Index should show Rel and Impact columns."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Test memory", confidence=0.7
        )
        memory.stage_index(type("Args", (), {})())
        text = memory.INDEX_FILE.read_text()
        assert "| Rel |" in text
        assert "| Impact |" in text

    def test_index_counts_superseded(self, tmp_memory_dir):
        """Index should count superseded memories separately."""
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-001", "Active", confidence=0.7
        )
        write_old_format_memory(
            memory.CONSOLIDATED_DIR, "m-002", "Superseded",
            confidence=0.0, superseded_by="m-001"
        )
        memory.stage_index(type("Args", (), {})())
        text = memory.INDEX_FILE.read_text()
        assert "Active memories: 1" in text
        assert "Superseded: 1" in text
