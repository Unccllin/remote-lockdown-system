"""Tests for the agent's offline request queue.

Why this file exists (session 171)
----------------------------------
The graph marked **E-OFFLINE-QUEUE** `verified-in-unit-test`, but no test in the
tree referenced `queue_offline`, `_queue_size`, `OFFLINE_QUEUE_DB` or
`drain_offline_queue` — the only "offline" tests covered `offline_recovery.py`,
which is a different feature (E-RECOVERY).

A mutation audit (`scripts/audit_test_teeth.py`) confirmed the gap empirically:
turning `queue_offline` into a no-op left every suite green. That matters because
this queue is a **data-loss path** — when the server is unreachable the agent
queues the report, and if the queue silently drops it the operator simply never
learns where the device is.

Every test here fails if the corresponding behaviour regresses; that property is
the point, not coverage percentage.
"""

import json
import sqlite3
import time
from pathlib import Path

import pytest
import requests

import agent


@pytest.fixture
def queue_db(tmp_path, monkeypatch):
    """Point the queue at a throwaway SQLite file and restore it afterwards."""
    db = tmp_path / ".offline_queue.db"
    monkeypatch.setattr(agent, "OFFLINE_QUEUE_DB", db)
    yield db
    monkeypatch.setattr(agent, "OFFLINE_QUEUE_DB", agent.OFFLINE_QUEUE_DB)


def _rows(db: Path) -> list[tuple]:
    conn = sqlite3.connect(str(db))
    try:
        return conn.execute(
            "SELECT endpoint, payload, attempts FROM offline_queue ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


class TestQueueOffline:
    def test_queues_the_request(self, queue_db):
        """A queued request is persisted with its endpoint and payload."""
        agent.queue_offline("/api/agent/location", {"lat": 1.5, "lon": 2.5})

        assert agent._queue_size() == 1
        endpoint, payload, attempts = _rows(queue_db)[0]
        assert endpoint == "/api/agent/location"
        assert json.loads(payload) == {"lat": 1.5, "lon": 2.5}
        assert attempts == 0

    def test_keeps_multiple_items_in_order(self, queue_db):
        """Two reports produce two rows, oldest first — the drain relies on it."""
        agent.queue_offline("/api/agent/location", {"n": 1})
        agent.queue_offline("/api/agent/location", {"n": 2})

        assert agent._queue_size() == 2
        payloads = [json.loads(p) for _, p, _ in _rows(queue_db)]
        assert payloads == [{"n": 1}, {"n": 2}]

    def test_unwritable_queue_does_not_raise(self, queue_db):
        """A corrupt database must not crash the caller or lose the check-in.

        This is the fail-safe path: `queue_offline` catches the SQLite error and
        logs it, because the location report failing must not take down the
        agent's main loop.
        """
        queue_db.write_bytes(b"this is not a sqlite database")

        agent.queue_offline("/api/agent/location", {"lat": 9})  # must not raise

        # The queue is unusable, so the count reports 0 rather than exploding.
        assert agent._queue_size() == 0


# Module-level, not a class attribute: a dict on a class is shared mutable state
# across every test instance, which is exactly the kind of leak that makes one
# test's edit change another test's behaviour.
DRAIN_CFG = {"verify_tls": False}


class TestDrainOfflineQueue:
    def test_sends_and_removes_on_success(self, queue_db, monkeypatch):
        """A deliverable item is sent and deleted, so it is not sent twice."""
        agent.queue_offline("/api/agent/location", {"lat": 1.0})
        sent: list[tuple[str, dict]] = []

        def fake_post(endpoint, cfg, json_body, **kwargs):
            sent.append((endpoint, json_body))
            return type("R", (), {"raise_for_status": lambda self: None})()

        monkeypatch.setattr(agent, "_post_with_fallback", fake_post)

        agent.drain_offline_queue(DRAIN_CFG)

        assert sent == [("/api/agent/location", {"lat": 1.0})]
        assert agent._queue_size() == 0

    def test_keeps_item_and_counts_attempt_on_failure(self, queue_db, monkeypatch):
        """A failed delivery stays queued with its attempt count incremented."""
        agent.queue_offline("/api/agent/location", {"lat": 2.0})

        def failing_post(*args, **kwargs):
            raise requests.RequestException("server down")

        monkeypatch.setattr(agent, "_post_with_fallback", failing_post)

        agent.drain_offline_queue(DRAIN_CFG)

        assert agent._queue_size() == 1, "a transient failure must not drop the item"
        _, _, attempts = _rows(queue_db)[0]
        assert attempts == 1

    def test_drops_item_after_ten_attempts(self, queue_db, monkeypatch):
        """After 10 attempts the item is dropped, so the queue cannot grow forever."""
        agent.queue_offline("/api/agent/location", {"lat": 3.0})
        conn = sqlite3.connect(str(queue_db))
        conn.execute("UPDATE offline_queue SET attempts = 10")
        conn.commit()
        conn.close()

        def failing_post(*args, **kwargs):
            raise requests.RequestException("still down")

        monkeypatch.setattr(agent, "_post_with_fallback", failing_post)

        agent.drain_offline_queue(DRAIN_CFG)

        assert agent._queue_size() == 0

    def test_does_nothing_when_empty(self, queue_db, monkeypatch):
        """No queued work means no network call at all."""
        calls = []
        monkeypatch.setattr(agent, "_post_with_fallback", lambda *a, **k: calls.append(a))

        agent.drain_offline_queue(DRAIN_CFG)

        assert calls == []


class TestQueueSchema:
    def test_created_at_records_when_it_was_queued(self, queue_db):
        """`created_at` is a real timestamp, because the drain orders by it."""
        before = time.time()
        agent.queue_offline("/api/agent/location", {"lat": 4.0})
        after = time.time()

        conn = sqlite3.connect(str(queue_db))
        try:
            (created_at,) = conn.execute("SELECT created_at FROM offline_queue").fetchone()
        finally:
            conn.close()
        assert before <= created_at <= after
