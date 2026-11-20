"""Offline WiFi-scan queue (S271).

A device that cannot reach the network also cannot resolve access points to coordinates — the
lookup needs the internet. But the *scan* is local (`netsh wlan show networks mode=bssid`), so
throwing it away loses the only evidence of where the machine was. These tests pin the queue:
a scan is kept when no fix can be obtained, kept bounded, resolved on reconnect, and posted
with the time it was taken rather than the time it could be sent.
"""

import sqlite3
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent  # noqa: E402

SCAN = [
    {"ssid": "lab-net", "bssid": "aa:bb:cc:dd:ee:01"},
    {"ssid": "guest", "bssid": "aa:bb:cc:dd:ee:02"},
]


def _queue(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, "OFFLINE_QUEUE_DB", tmp_path / ".offline_queue.db")


def _rows(tmp_path, endpoint=agent.WIFI_SCAN_QUEUE_ENDPOINT):
    conn = sqlite3.connect(str(tmp_path / ".offline_queue.db"))
    try:
        return conn.execute(
            "SELECT id, payload FROM offline_queue WHERE endpoint = ? ORDER BY id ASC", (endpoint,)
        ).fetchall()
    finally:
        conn.close()


def test_a_scan_is_kept_when_no_fix_can_be_obtained(tmp_path, monkeypatch):
    """The scan is the evidence; without it an offline stretch leaves nothing to resolve."""
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)

    agent._queue_wifi_scan_for_later()

    rows = _rows(tmp_path)
    assert len(rows) == 1
    payload = rows[0][1]
    assert "aa:bb:cc:dd:ee:01" in payload
    assert "scanned_at" in payload


def test_queue_stays_bounded(tmp_path, monkeypatch):
    """A long offline stretch must not fill the disk with evidence nobody will read."""
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)

    for _ in range(agent.WIFI_SCAN_QUEUE_MAX + 5):
        agent._queue_wifi_scan_for_later()

    assert len(_rows(tmp_path)) == agent.WIFI_SCAN_QUEUE_MAX


def test_report_location_queues_the_scan_when_it_has_no_fix(tmp_path, monkeypatch):
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "get_geolocation", lambda cfg: None)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)

    assert agent.report_location({"hostname": "MOLE"}) is None
    assert len(_rows(tmp_path)) == 1


def test_a_queued_scan_is_resolved_and_posted_on_reconnect(tmp_path, monkeypatch):
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    agent._queue_wifi_scan_for_later()

    posted = {}

    def fake_post(endpoint, cfg, payload, **kwargs):
        posted["endpoint"] = endpoint
        posted["payload"] = payload
        return MagicMock(raise_for_status=lambda: None)

    monkeypatch.setattr(agent, "_post_with_fallback", fake_post)
    monkeypatch.setattr(
        agent,
        "_resolve_wifi_scan",
        lambda key, points: {"latitude": -0.48, "longitude": 37.12, "source": "wifi"},
    )

    assert agent.resolve_pending_wifi_scans({"hostname": "MOLE", "verify_tls": False}) == 1
    assert _rows(tmp_path) == [], "a resolved scan is consumed"
    assert posted["endpoint"] == "/api/agent/location"
    assert posted["payload"]["observed_at"], "the scan time must travel, not the upload time"
    assert posted["payload"]["location"]["latitude"] == -0.48


def test_an_unresolvable_scan_is_kept_for_later(tmp_path, monkeypatch):
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    agent._queue_wifi_scan_for_later()

    monkeypatch.setattr(agent, "_resolve_wifi_scan", lambda key, points: None)

    assert agent.resolve_pending_wifi_scans({"hostname": "MOLE", "verify_tls": False}) == 0
    rows = _rows(tmp_path)
    assert len(rows) == 1, "the evidence survives until it can be read"
    conn = sqlite3.connect(str(tmp_path / ".offline_queue.db"))
    try:
        assert conn.execute("SELECT attempts FROM offline_queue").fetchone()[0] == 1
    finally:
        conn.close()


def test_nothing_is_resolved_without_a_geolocation_key(tmp_path, monkeypatch):
    """No key means no lookup — and no silent deletion of the queued scans either."""
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    agent._queue_wifi_scan_for_later()

    assert agent.resolve_pending_wifi_scans({"hostname": "MOLE", "verify_tls": False}) == 0
    assert len(_rows(tmp_path)) == 1


def test_the_drain_loop_does_not_post_the_sentinel_endpoint(tmp_path, monkeypatch):
    """A queued scan is not an HTTP endpoint; the drain must leave it to the resolver."""
    _queue(tmp_path, monkeypatch)
    monkeypatch.setattr(agent, "scan_wifi_networks", lambda: SCAN)
    agent._queue_wifi_scan_for_later()

    calls = []
    monkeypatch.setattr(
        agent, "_post_with_fallback", lambda *a, **k: calls.append(a) or MagicMock()
    )

    agent.drain_offline_queue({"hostname": "MOLE", "verify_tls": False})

    assert [c[0] for c in calls] == [], "the sentinel is never posted"
    assert len(_rows(tmp_path)) == 1
