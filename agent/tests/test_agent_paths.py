"""Tests for the agent's platform directory resolution (S141).

Before this suite, `os.environ.get("PROGRAMDATA", "C:\\\\ProgramData")` was used
directly in seven places. On Linux/macOS that literal made the agent create a
directory *named* `C:\\ProgramData` inside whatever the working directory was —
a test run left one at the repository root, and `.gitignore` only covered
`agent/C:*`. These tests pin the resolver so the Windows default cannot leak
back into POSIX runs.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import agent


def test_uses_programdata_when_set(monkeypatch, tmp_path):
    target = tmp_path / "pd"
    monkeypatch.setenv("PROGRAMDATA", str(target))

    assert agent._programdata_dir() == target


def test_programdata_wins_over_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("PROGRAMDATA", str(tmp_path / "pd"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))

    assert agent._programdata_dir() == tmp_path / "pd"


def test_posix_fallback_is_never_a_windows_path(monkeypatch):
    monkeypatch.delenv("PROGRAMDATA", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    resolved = agent._programdata_dir()

    if sys.platform == "win32":
        assert str(resolved) == "C:\\ProgramData"
    else:
        assert resolved.is_absolute(), "fallback must be absolute"
        assert "\\" not in str(resolved), f"POSIX path must not contain a backslash: {resolved}"
        assert not str(resolved).startswith("C:"), (
            f"POSIX path must not be a drive path: {resolved}"
        )
        assert resolved.name != "ProgramData" or resolved.parent.name != "C:"


def test_posix_fallback_uses_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.delenv("PROGRAMDATA", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))

    if sys.platform == "win32":
        return  # Windows ignores XDG entirely

    assert agent._programdata_dir() == tmp_path / "xdg"


def test_posix_fallback_defaults_under_home(monkeypatch):
    monkeypatch.delenv("PROGRAMDATA", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)

    if sys.platform == "win32":
        return

    assert agent._programdata_dir() == Path.home() / ".local" / "share"
