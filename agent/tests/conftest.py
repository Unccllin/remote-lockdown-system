"""Shared pytest fixtures for the lockdown agent test suite.

This conftest.py provides the common fixtures (tmp_folder, tmp_sentinel, cfg,
cleanup_guardian) that were previously duplicated across test_agent.py,
test_hardening.py, and test_tamper_integration.py.

Individual test files can still override these fixtures if they need
different behavior — pytest's fixture resolution will prefer the
local definition over the conftest one.
"""

import shutil
import tempfile
from pathlib import Path

import pytest

import agent


@pytest.fixture
def tmp_folder():
    """Create a temporary folder with some test files for encryption tests."""
    d = Path(tempfile.mkdtemp())
    (d / "file1.txt").write_text("hello world")
    (d / "file2.txt").write_text("secret data")
    (d / "subdir").mkdir()
    (d / "subdir" / "nested.txt").write_text("nested content")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_sentinel():
    """Create a temporary sentinel file path that doesn't exist."""
    f = Path(tempfile.mktemp())
    if f.exists():
        f.unlink()
    yield f
    if f.exists():
        f.unlink()


@pytest.fixture
def cfg(tmp_folder, tmp_sentinel):
    """A standard test config dict matching the agent's expected format."""
    return {
        "server_url": "https://test-server.example.com",
        "agent_key": "test-key",
        "hostname": "TEST-DEV-001",
        "poll_interval": 1,
        "lockdown_folder": tmp_folder,
        "lock_sentinel": tmp_sentinel,
        "verify_tls": True,
        "pending_ack_file": Path(tempfile.mktemp()),
        "recovery_key_file": Path(tempfile.mktemp()),
        "recovery_public_key": "",  # Empty = recovery feature disabled in tests
        "server_supports_ack_dedup": False,
    }


@pytest.fixture(autouse=True)
def cleanup_guardian():
    """Ensure lock guardian is stopped and temp files cleaned up after each test.

    This is autouse=True so it runs for every test in the suite automatically.
    Individual test files that need more specific cleanup can define their own
    autouse fixture — it will run in addition to this one.
    """
    yield
    agent.stop_lock_guardian()
    for f in [agent.PENDING_ACK_FILE, agent.RECOVERY_KEY_FILE]:
        if f.exists():
            f.unlink()
