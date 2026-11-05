"""Tamper detection must not fire on a healthy device (S225).

Two false positives made every healthy install look tampered:

* `.locked` was a "critical file" although it exists only *while the device is locked*,
  so every unlocked device reported a missing file — which fed the relock loop in S222;
* the service and the scheduled task were treated as cumulative, but the service replaced
  the task (S220), so the missing task alone flagged tampering forever.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import tamper_protection as tp  # noqa: E402


def _run(monkeypatch, *, service_returncode=0, task_returncode=1):
    def fake_run(args, **kwargs):
        # Exact match: "sc" is a substring of "schtasks".
        if args[0] in ("sc", "sc.exe"):
            return MagicMock(returncode=service_returncode)
        return MagicMock(returncode=task_returncode)

    monkeypatch.setattr(tp, "_is_windows", lambda: True)
    monkeypatch.setattr(tp.subprocess, "run", fake_run)


def test_unlocked_device_with_service_is_not_tampered(monkeypatch, tmp_path):
    """.locked is absent by design on an unlocked device."""
    (tmp_path / "config.json").write_text("{}")
    _run(monkeypatch, service_returncode=0, task_returncode=1)

    result = tp.check_tamper(tmp_path)

    assert result["files_missing"] == []
    assert result["service_missing"] is False
    assert result["task_missing"] is True  # still reported, for the record
    assert result["persistence_missing"] is False
    assert result["tampered"] is False, "a service install without a task is healthy"


def test_task_install_without_service_is_not_tampered(monkeypatch, tmp_path):
    (tmp_path / "config.json").write_text("{}")
    _run(monkeypatch, service_returncode=1, task_returncode=0)

    result = tp.check_tamper(tmp_path)

    assert result["persistence_missing"] is False
    assert result["tampered"] is False


def test_missing_persistence_both_ways_is_tampering(monkeypatch, tmp_path):
    (tmp_path / "config.json").write_text("{}")
    _run(monkeypatch, service_returncode=1, task_returncode=1)

    result = tp.check_tamper(tmp_path)

    assert result["persistence_missing"] is True
    assert result["tampered"] is True


def test_deleted_config_is_tampering(monkeypatch, tmp_path):
    _run(monkeypatch, service_returncode=0, task_returncode=0)

    result = tp.check_tamper(tmp_path)

    assert "config.json" in result["files_missing"]
    assert result["tampered"] is True


def test_locked_and_deadman_are_state_not_assets(monkeypatch, tmp_path):
    """Their absence must not be reported as tampering."""
    (tmp_path / "config.json").write_text("{}")
    _run(monkeypatch, service_returncode=0, task_returncode=0)

    result = tp.check_tamper(tmp_path)

    assert ".locked" not in result["files_missing"]
    assert ".deadman" not in result["files_missing"]
    assert result["tampered"] is False
