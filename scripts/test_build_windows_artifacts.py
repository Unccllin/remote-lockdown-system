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
