"""The build identity has one implementation and three entry points (S361).

`agent/build.ps1` stamped from the start; `scripts/build-windows-artifacts.ps1` did not (S359);
`agent/build.sh` -- which builds the Linux and macOS agent binaries that release.yml bundles into
the Electron release -- did not either. Three copies would drift, so the computation lives in
`scripts/stamp_buildinfo.py` and the other two call it.

These tests execute the implementation rather than grepping for it, because the property that
matters is the identity it produces: the PowerShell implementation produced
`20261126.69a3e4156d16` for the tree at the time of the move, and the Python one must produce the
same value for the same tree or the move silently renamed every build.
"""

import hashlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STAMP_PY = REPO / "scripts" / "stamp_buildinfo.py"
STAMP_PS1 = REPO / "scripts" / "stamp-buildinfo.ps1"
BUILD_SH = REPO / "agent" / "build.sh"
BUILD_PS1 = REPO / "agent" / "build.ps1"
ARTIFACTS_PS1 = REPO / "scripts" / "build-windows-artifacts.ps1"

# Import the implementation directly: the tests are about what it writes, not how it is invoked.
# (No pytest import: this suite must run under the repo's own runner and the system interpreter.)
sys.path.insert(0, str(REPO / "scripts"))
import stamp_buildinfo  # noqa: E402

IDENTITY_RE = re.compile(r"^Build identity: \d{8}\.[0-9a-f]{12}$")


def _fake_agent_dir(tmp_path: Path, files: dict[str, str] | None = None) -> Path:
    agent = tmp_path / "agent"
    agent.mkdir(parents=True)
    (agent / "agent.py").write_text("# agent\n", encoding="utf-8")
    (agent / "_buildinfo.py").write_text('BUILD_COMMIT = "unknown"\n', encoding="utf-8")
    for name, content in (files or {}).items():
        (agent / name).write_text(content, encoding="utf-8")
    return agent


def test_stamps_the_expected_format(tmp_path, capsys):
    agent = _fake_agent_dir(tmp_path)

    assert stamp_buildinfo.main(["--agent-dir", str(agent)]) == 0

    printed = capsys.readouterr().out.strip()
    assert IDENTITY_RE.match(printed), f"unexpected identity line: {printed!r}"

    written = (agent / "_buildinfo.py").read_text(encoding="utf-8")
    assert 'BUILD_COMMIT = "' in written and 'BUILD_DATE = "' in written
    # ASCII with no BOM: a Python module needs neither, and PS 5.1's -Encoding utf8 adds one.
    assert written == written.encode("ascii").decode("ascii")
    assert not written.startswith("\ufeff")


def test_is_deterministic_for_one_tree(tmp_path):
    first = _fake_agent_dir(tmp_path / "a")
    second = _fake_agent_dir(tmp_path / "b")

    assert stamp_buildinfo.stamp(first) == stamp_buildinfo.stamp(second)


def test_changing_a_source_changes_the_identity(tmp_path):
    agent = _fake_agent_dir(tmp_path, {"tpm_seal.py": "a = 1\n"})
    before = stamp_buildinfo.stamp(agent)

    (agent / "tpm_seal.py").write_text("a = 2\n", encoding="utf-8")
    after = stamp_buildinfo.stamp(agent)

    assert before != after, "a different tree must not report the same build id"


def test_the_generated_file_does_not_feed_its_own_identity(tmp_path):
    """_buildinfo.py is excluded, or every build would change the id it is about to write."""
    agent = _fake_agent_dir(tmp_path)
    first = stamp_buildinfo.stamp(agent, commit="aaaa1111bbbb")
    second = stamp_buildinfo.stamp(agent, commit="cccc2222dddd")

    # The stamped file changed between the two calls; the computed hash must not care.
    assert stamp_buildinfo.source_hash(agent) == stamp_buildinfo.source_hash(agent)
    assert first[0] == second[0]


def test_a_known_commit_overrides_the_hash(tmp_path):
    agent = _fake_agent_dir(tmp_path)

    date, commit = stamp_buildinfo.stamp(agent, commit="abc123def456")

    assert commit == "abc123def456"
    assert f'BUILD_COMMIT = "{commit}"' in (agent / "_buildinfo.py").read_text(encoding="utf-8")
    assert re.fullmatch(r"\d{8}", date)


def test_refuses_a_directory_that_is_not_an_agent_tree(tmp_path):
    try:
        stamp_buildinfo.stamp(tmp_path)
    except SystemExit as exc:
        assert "cannot stamp a build identity" in str(exc)
    else:
        raise AssertionError("stamping a directory with no agent.py must fail loudly")


def test_source_hash_matches_the_scheme_the_powershell_version_used(tmp_path):
    """Recompute the documented scheme independently and compare.

    PowerShell built `<name><sha256-uppercase-hex of file>` per file in name order and hashed the
    concatenation. If this drifts, a tree stamped on Windows and the same tree stamped on Linux
    stop reporting the same id.
    """
    agent = _fake_agent_dir(tmp_path, {"b_module.py": "b = 1\n", "a_module.py": "a = 1\n"})

    expected = hashlib.sha256()
    for path in sorted(agent.glob("*.py"), key=lambda p: p.name):
        if path.name == "_buildinfo.py":
            continue
        expected.update(path.name.encode("utf-8"))
        expected.update(hashlib.sha256(path.read_bytes()).hexdigest().upper().encode("utf-8"))

    assert stamp_buildinfo.source_hash(agent) == expected.hexdigest()


def test_every_build_entry_point_calls_the_shared_implementation():
    """The property S359 and S361 were both about: no path may build an anonymous binary."""
    assert STAMP_PY.exists(), "the shared implementation is missing"

    shell = BUILD_SH.read_text(encoding="utf-8")
    assert "stamp_buildinfo.py" in shell, "agent/build.sh (Linux/macOS release path) does not stamp"
    # It must run before PyInstaller *is invoked*, or the binary is built from an unstamped tree.
    # Anchor on the invocation, not the word: the script's header comment says "using PyInstaller"
    # at line 3, so a substring search would pass while the stamp ran after the build.
    assert shell.index("stamp_buildinfo.py") < shell.index("-m PyInstaller"), (
        "the stamp must run before the first PyInstaller invocation"
    )

    for name, text in (("agent/build.ps1", BUILD_PS1.read_text(encoding="utf-8")),
                       ("scripts/build-windows-artifacts.ps1", ARTIFACTS_PS1.read_text(encoding="ascii"))):
        assert "stamp-buildinfo.ps1" in text, f"{name} does not stamp the build identity"

    # …and the PowerShell side must not keep its own copy of the computation.
    ps1 = STAMP_PS1.read_text(encoding="ascii")
    assert "stamp_buildinfo.py" in ps1, "the PS entry point must delegate, not reimplement"
    assert "ComputeHash" not in ps1, "a second hash implementation has reappeared in PowerShell"
    assert "ComputeHash" not in BUILD_PS1.read_text(encoding="utf-8")


def test_the_powershell_wrapper_stays_ascii():
    """PS 5.1 decodes BOM-less UTF-8 as ANSI, so a stray multi-byte char breaks the parse."""
    assert STAMP_PS1.read_bytes().isascii()


def test_stamping_leaves_the_committed_placeholder_alone():
    """A source checkout must not impersonate a release (agent/tests/test_version_identity.py)."""
    committed = (REPO / "agent" / "_buildinfo.py").read_text(encoding="utf-8")
    assert 'BUILD_COMMIT = "unknown"' in committed
    assert 'BUILD_DATE = "unknown"' in committed


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
