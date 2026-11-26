"""Guards for the Windows artefact build (S227/S228).

`agent/dist/` is gitignored, so the Windows installers only exist if someone builds them.
That makes the build script, the workflow that runs it and the `make` target that
delegates to it into the product's supply path for those binaries -- worth pinning.

The first test is a regression guard with a real history: the script was written with
typographic dashes and no BOM, and Windows PowerShell 5.1 decodes BOM-less files as ANSI,
so a three-byte em dash swallowed a closing quote and the script failed to parse on the
target. ASCII-only is the rule (or a BOM), and ASCII is simpler.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "build-windows-artifacts.ps1"
WORKFLOW = REPO / ".github" / "workflows" / "windows-artifacts.yml"
MAKEFILE = REPO / "Makefile"


def test_build_script_exists():
    assert SCRIPT.exists(), "the Windows build script is the only way to produce agent/dist"


def test_build_script_is_ascii_only():
    """PS 5.1 decodes BOM-less UTF-8 as ANSI, so multi-byte chars can break the parse."""
    raw = SCRIPT.read_bytes()
    assert raw.isascii(), (
        "non-ASCII bytes in a PowerShell script break under Windows PowerShell 5.1 "
        "(BOM-less UTF-8 is read as ANSI)"
    )


def test_build_script_builds_every_spec_it_claims():
    text = SCRIPT.read_text(encoding="ascii")
    for spec in ("agent.spec", "installer.spec", "installer_gui.spec"):
        assert spec in text, f"{spec} is not referenced by the build script"
        assert (REPO / "agent" / spec).exists(), f"{spec} is missing from agent/"


def test_build_script_verifies_what_it_produces():
    """A zero-byte or non-PE output must fail the build, not be reported as success."""
    text = SCRIPT.read_text(encoding="ascii")
    assert "0x4D" in text and "0x5A" in text, "the MZ/PE check is the difference between a build and a claim"
    assert "exit 1" in text


def test_workflow_runs_the_script_on_windows():
    assert WORKFLOW.exists(), "without CI the artefacts only exist on one person's machine"
    text = WORKFLOW.read_text()
    assert "windows-latest" in text
    assert "scripts/build-windows-artifacts.ps1" in text
    assert "actions/upload-artifact" in text
    assert "if-no-files-found: error" in text, (
        "a green job that produced nothing is worse than a red one"
    )


def test_makefile_delegates_instead_of_duplicating():
    text = MAKEFILE.read_text()
    assert "windows-artifacts:" in text
    block = text.split("windows-artifacts:", 1)[1].split("\n\n", 1)[0]
    assert "scripts/build-windows-artifacts.ps1" in block, "the target must delegate to the script"
    # The repo rule: build logic lives in scripts/, the Makefile only calls it.
    assert "pyinstaller" not in block.lower(), "build logic must not be duplicated in the Makefile"
    assert re.search(r"pwsh|powershell", block, re.IGNORECASE), (
        "the target should say what it needs when PowerShell is absent"
    )


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))


def test_the_service_build_refuses_an_environment_without_pywin32():
    """A service built without pywin32 starts and then fails with SCM 1053, logging nothing.

    Measured on MOLE (S298): the frozen exe built fine, `Start-Service` answered 1053, and
    the log had no line at all -- because service_host.py guards the pywin32 imports and
    sets PYWIN32_AVAILABLE=False rather than raising. A build that produces a service which
    cannot start is worse than a build that fails, so the script checks first.
    """
    text = SCRIPT.read_text(encoding="ascii")
    assert "servicemanager" in text, (
        "the build script must verify the SCM modules are importable before building the "
        "service; without pywin32 the result cannot start and says nothing"
    )
    # The check has to run before PyInstaller, not after the artefact exists.
    assert text.index("servicemanager") < text.index("-m PyInstaller"), (
        "the pywin32 check must run before the build, not after it"
    )


def test_windows_only_dependency_is_pinned_with_a_platform_marker():
    """pywin32 must be in requirements.txt AND marked Windows-only."""
    reqs = (REPO / "agent" / "requirements.txt").read_text(encoding="utf-8")
    line = next((ln for ln in reqs.splitlines() if ln.startswith("pywin32")), "")
    assert line, "pywin32 is missing from agent/requirements.txt (the service needs it)"
    assert "sys_platform" in line and "win32" in line, (
        f"pywin32 must carry a win32 marker so Linux installs are unaffected, got: {line!r}"
    )

STAMP = REPO / "scripts" / "stamp-buildinfo.ps1"
BUILD_PS1 = REPO / "agent" / "build.ps1"


def test_both_build_entry_points_share_one_stamp_implementation():
    """The identity must be stamped on the path that ships, and by one implementation.

    `agent/build.ps1` stamped from the start; `scripts/build-windows-artifacts.ps1` -- what CI
    runs on a v* tag, and what produced the published binaries -- did not, so every CI-built
    release reported `build=unknown.unknown`. Two builds of one AGENT_VERSION were then
    indistinguishable on a device, which is the defect S286 fixed (S359). Using `&` rather than
    `pwsh` matters: `pwsh` is absent on a plain Windows 10/11 host.
    """
    assert STAMP.exists(), "the shared stamping script is the single implementation"
    artifacts = SCRIPT.read_text(encoding="ascii")
    builder = BUILD_PS1.read_text(encoding="utf-8")

    for name, text in (("scripts/build-windows-artifacts.ps1", artifacts), ("agent/build.ps1", builder)):
        assert "stamp-buildinfo.ps1" in text, f"{name} does not stamp the build identity"
        assert "& " in text, f"{name} must invoke the stamp script in-process, not via pwsh"

    # The stamp has to happen before PyInstaller reads the sources, or the binary ships unstamped.
    assert artifacts.index("stamp-buildinfo.ps1") < artifacts.index("-m PyInstaller"), (
        "the stamp must run before the first PyInstaller invocation"
    )

    # …and the implementation may only exist once: the caller must not keep a private copy.
    assert "ComputeHash" not in builder, (
        "agent/build.ps1 still computes the source hash itself - that is the duplicate the "
        "shared script exists to remove"
    )


def test_the_build_fails_when_the_identity_does_not_reach_the_binary():
    """A stamp that stops reaching the exe must fail the build, not be discovered on a device."""
    text = SCRIPT.read_text(encoding="ascii")

    assert "--version" in text, "the build must ask the binary what identity it carries"
    assert "unknown" in text, "the check must reject the placeholder explicitly"
    assert text.index("--version") < text.index("if ($failed) { exit 1 }"), (
        "the identity check must run before the failure exit, or it can never fail the build"
    )


def test_the_stamp_script_is_ascii_only():
    """Same rule as the build script: PS 5.1 reads BOM-less UTF-8 as ANSI."""
    assert STAMP.read_bytes().isascii(), (
        "non-ASCII bytes in a PowerShell script break under Windows PowerShell 5.1"
    )
