"""The build identity — two binaries must never both be "just 1.0.0".

S286: a stale agent and a freshly built one both reported `lockdown-agent 1.0.0`, so working
out what was actually running on MOLE took a hand-run sha256 against the device. `AGENT_VERSION`
stays numeric because the server compares it arithmetically
(`compareVersions` splits on '.', server/src/routes/agent.js:1037); the identity of the build
lives in `agent/_buildinfo.py` and is reported by `--version` and the startup log.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import agent

# `<8-digit UTC date>.<12 hex chars>`, or the committed placeholder pair.
BUILD_PATTERN = re.compile(r"^(?:\d{8}|unknown)\.(?:[0-9a-f]{12}|unknown)$")


def test_build_id_has_a_shape_a_person_can_read():
    assert BUILD_PATTERN.match(agent.AGENT_BUILD), (
        f"AGENT_BUILD={agent.AGENT_BUILD!r} is neither a stamped build nor the placeholder; "
        "build.ps1 writes it, so a malformed value means the stamping changed shape"
    )


def test_version_string_carries_both_identities():
    version = agent.version_string()
    assert version.startswith(f"lockdown-agent {agent.AGENT_VERSION} ")
    assert f"build={agent.AGENT_BUILD}" in version
    assert f"frozen={agent._is_frozen()}" in version


def test_the_committed_default_stays_a_placeholder():
    """A stamped build must not be committed.

    `build.ps1` rewrites this file in a build tree, so running a local build leaves it stamped.
    Restore it (git checkout -- agent/_buildinfo.py) — the committed value describes a source
    checkout, and a release that claims a build identity it did not build is worse than 'unknown'.
    """
    text = (Path(agent.__file__).resolve().parent / "_buildinfo.py").read_text(encoding="utf-8")
    assert 'BUILD_COMMIT = "unknown"' in text, (
        "agent/_buildinfo.py carries a stamped build id; restore it before committing "
        "(git checkout -- agent/_buildinfo.py)"
    )
    assert 'BUILD_DATE = "unknown"' in text, (
        "agent/_buildinfo.py carries a stamped build date; restore it before committing "
        "(git checkout -- agent/_buildinfo.py)"
    )


def test_version_stays_numeric_for_the_update_comparison():
    """Build metadata must never ride on AGENT_VERSION: compareVersions parses it as numbers."""
    assert re.fullmatch(r"\d+(\.\d+)*", agent.AGENT_VERSION), (
        f"AGENT_VERSION={agent.AGENT_VERSION!r} must stay numeric — the server compares it with "
        "Number() and any suffix becomes NaN, which silently makes every update comparison equal"
    )
