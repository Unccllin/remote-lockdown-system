#!/usr/bin/env python3
"""Tests for the generic NSIS installer and the build that produces it.

What is actually being protected here
-------------------------------------
The generic installer exists because a Cloudflare Worker cannot run `makensis`,
so the serverless fleet needs one installer whose config is claimed at install
time. The tempting way to build it is to re-implement enrolment and persistence
in the .nsi script — an earlier draft in this repo did exactly that and shipped
a third mechanism (`sc.exe` services) that nothing else in the product uses,
missing the hardware IDs the backend re-associates on and 9 of the 12 config
keys the agent reads.

So the tests below are mostly about *delegation*: the wrapper must not grow
enrolment, config writing, persistence or ACL logic of its own. Together with a
real `makensis` compile (skipped when NSIS is absent) they pin the contract
between installer/generic/lockdown-installer.nsi, agent/installer.py,
agent/installer.spec and scripts/build-generic-installer.sh.

No pytest import and no fixtures, deliberately: `scripts/` is not on the venv's
import path (pytest lives in agent/.venv), so a top-level `import pytest` is
unresolvable to a static analyser even though `make test-scripts` runs this file
through the venv interpreter — the same reason scripts/script_test_runner.py
imports pytest dynamically. These tests therefore build their own temp dirs and
report skips by printing, and stay runnable under a bare interpreter.

Run directly (make test-scripts) or under pytest.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NSI = REPO / "installer" / "generic" / "lockdown-installer.nsi"
BUILD_SH = REPO / "scripts" / "build-generic-installer.sh"
INSTALLER_PY = REPO / "agent" / "installer.py"
INSTALLER_SPEC = REPO / "agent" / "installer.spec"
BUILD_PS1 = REPO / "agent" / "build.ps1"

# makensis locations this repo already supports (see scripts/verify-environment.sh).
NSIS_CANDIDATES = [
    Path(shutil.which("makensis") or "/nonexistent"),
    Path.home() / ".local" / "nsis" / "usr" / "bin" / "makensis",
]


def _code_lines(path: Path) -> list[str]:
    """Lines of an NSIS script with comments stripped.

    Comments matter here: the .nsi explains *why* it does not use `sc.exe`, so a
    naive grep for `sc.exe` would fail on the documentation of the decision.
    """
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = re.sub(r";.*$", "", raw).strip()
        if line:
            out.append(line)
    return out


def _section(lines: list[str], name: str) -> list[str]:
    """Return the body of `Section "name" ... SectionEnd`."""
    start = None
    for i, line in enumerate(lines):
        if line.lower().startswith(f'section "{name.lower()}"'):
            start = i
            break
    assert start is not None, f'section "{name}" not found'
    body = []
    for line in lines[start + 1 :]:
        if line.lower().startswith("sectionend"):
            return body
        body.append(line)
    raise AssertionError(f'section "{name}" has no SectionEnd')


def _makensis() -> Path | None:
    for candidate in NSIS_CANDIDATES:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _skip(reason: str) -> None:
    print(f"SKIP: {reason}")


@contextlib.contextmanager
def _tmp():
    with tempfile.TemporaryDirectory() as tmp:
        yield Path(tmp)


def _stage_dir(root: Path, *, agent: bool = True, installer: bool = True) -> Path:
    stage = root / "stage"
    stage.mkdir()
    if agent:
        (stage / "lockdown-agent.exe").write_bytes(b"MZ" + b"\x00" * 64)
    if installer:
        (stage / "lockdown-installer.exe").write_bytes(b"MZ" + b"\x00" * 64)
    return stage


# A build needs a server URL by design: installer.py has no default since S213, so the
# script refuses rather than baking one. Tests that expect a successful build pass one
# explicitly; the refusal test passes server_url=None.
TEST_SERVER_URL = "https://lockdown.example.test"


def _run_build(
    stage: Path, out: Path, *extra: str, server_url: str | None = TEST_SERVER_URL
) -> subprocess.CompletedProcess:
    args = ["bash", str(BUILD_SH), "--stage", str(stage), "--out", str(out)]
    if server_url is not None:
        args += ["--server-url", server_url]
    args += list(extra)
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


# ---------------------------------------------------------------------------
# The wrapper must not implement the install itself
# ---------------------------------------------------------------------------


def test_nsi_code_has_no_persistence_of_its_own():
    """No sc.exe / schtasks / reg add / icacls in executable NSIS code.

    The agent is not a Windows service (nothing calls StartServiceCtrlDispatcher),
    and persistence lives in service_installer.install() — a scheduled task, a
    Run key and tamper-protection ACLs. A wrapper that registers its own services
    starts a process the SCM then kills for not reporting status, which looks
    installed and checks in exactly once.
    """
    forbidden = ("sc.exe", "schtasks", "reg add", "icacls", "taskkill")
    offenders = [
        line for line in _code_lines(NSI) if any(token in line.lower() for token in forbidden)
    ]
    assert not offenders, "the .nsi re-implements install mechanics:\n" + "\n".join(offenders)


def _delegation_calls(body: list[str], flag: str) -> list[int]:
    """Indices of lines that invoke the staged CLI installer with *flag*.

    The script references the binary through !define INSTALLER_EXE, so match the
    define as well as the literal filename.
    """
    return [
        i
        for i, line in enumerate(body)
        if flag in line and ("lockdown-installer.exe" in line or "${INSTALLER_EXE}" in line)
    ]


def test_nsi_install_section_delegates_to_the_cli_installer():
    """The install runs lockdown-installer.exe --silent with the token and URL."""
    body = _section(_code_lines(NSI), "Install")
    calls = _delegation_calls(body, "--silent")
    assert calls, "the install section never calls the CLI installer: " + "\n".join(body)
    call = body[calls[0]]
    assert "--token" in call
    assert "--server-url" in call
    # A non-zero exit must abort: installing without a usable config leaves an
    # agent that cannot check in.
    assert "Abort" in "\n".join(body)


def test_nsi_stages_the_installer_it_delegates_to():
    """lockdown-installer.exe is a mandatory staged File, not an optional one."""
    files = [line for line in _code_lines(NSI) if line.lower().startswith("file ")]
    mandatory = [line for line in files if "/nonfatal" not in line.lower()]
    assert any("lockdown-installer.exe" in line for line in mandatory), files
    assert any("lockdown-agent.exe" in line for line in mandatory), files


def test_no_duplicate_enrolment_script_remains():
    """claim-enroll.ps1 was a second copy of enroll_device_with_token(). It is gone."""
    assert not (NSI.parent / "claim-enroll.ps1").exists()
    assert "claim-enroll" not in NSI.read_text(encoding="utf-8")


def test_nsi_does_not_reference_a_variable_nsis_lacks():
    """$COMMONAPPDATA is Inno Setup, not NSIS — using it installs to a literal path.

    The one place the name may appear is the comment that records the mistake.
    """
    uses = [line for line in _code_lines(NSI) if "COMMONAPPDATA" in line]
    assert not uses, uses


def test_install_dir_matches_where_the_agent_keeps_its_state():
    """The wrapper stages into %ProgramData%\\LockdownAgent — the same directory
    installer.py writes config.json to and the agent reads its state from."""
    lines = _code_lines(NSI)
    assert any('InstallDir "$APPDATA\\LockdownAgent"' in line for line in lines), lines
    assert any("SetShellVarContext all" in line for line in lines), (
        "without SetShellVarContext all, $APPDATA is the *user's* AppData"
    )
    installer_py = INSTALLER_PY.read_text(encoding="utf-8")
    assert re.search(r'^INSTALL_DIR = .*/ "LockdownAgent"$', installer_py, re.M), installer_py[:200]


# ---------------------------------------------------------------------------
# Removal must stay server-authorized
# ---------------------------------------------------------------------------


def test_nsi_uninstall_requires_a_backend_token():
    """The uninstaller asks for --uninstall-token and refuses without one.

    An anti-theft agent with an unauthenticated uninstaller has shipped the
    bypass it exists to prevent.
    """
    body = "\n".join(_section(_code_lines(NSI), "Uninstall"))
    assert "--uninstall" in body
    assert "--uninstall-token" in body
    assert "Abort" in body
    assert "uninstall-auth" in NSI.read_text(encoding="utf-8"), (
        "the UI should tell the operator where the token comes from"
    )


def test_nsi_uninstall_deletes_only_after_authorization():
    """No file is deleted before the token-gated installer call succeeds."""
    body = _section(_code_lines(NSI), "Uninstall")
    calls = _delegation_calls(body, "--uninstall ")
    assert calls, "the uninstall section never calls the CLI installer"
    deletes = [i for i, line in enumerate(body) if line.lower().startswith("delete ")]
    assert deletes, "the uninstall section deletes nothing — stale files would remain"
    assert min(deletes) > calls[0], "files are deleted before removal is authorized"


# ---------------------------------------------------------------------------
# The pieces the wrapper depends on
# ---------------------------------------------------------------------------


def test_installer_py_has_the_uninstall_entry_point():
    """--uninstall / --uninstall-token and run_uninstall() exist."""
    text = INSTALLER_PY.read_text(encoding="utf-8")
    assert "def run_uninstall(" in text
    assert '"--uninstall"' in text
    assert '"--uninstall-token"' in text
    assert "service_installer.uninstall(" in text, "removal must reuse the tested path"


def test_cli_installer_spec_bundles_the_lazy_imports():
    """installer.py imports service_installer lazily; a spec without it builds a
    binary that silently skips persistence and cannot authorize removal."""
    text = INSTALLER_SPEC.read_text(encoding="utf-8")
    assert "'service_installer'" in text
    assert "'tamper_protection'" in text
    assert "installer.py" in text


def test_agent_build_ps1_builds_the_cli_installer():
    assert "installer.spec" in BUILD_PS1.read_text(encoding="utf-8"), (
        "the wrapper's delegate is not part of the build"
    )


# ---------------------------------------------------------------------------
# The build script
# ---------------------------------------------------------------------------


def test_build_script_is_executable():
    assert BUILD_SH.stat().st_mode & stat.S_IXUSR, (
        "scripts/build-generic-installer.sh is not executable"
    )


def test_build_script_refuses_without_the_installer_binary():
    with _tmp() as tmp:
        result = _run_build(_stage_dir(tmp, installer=False), tmp / "out")
    assert result.returncode == 1
    assert "lockdown-installer.exe" in result.stderr


def test_build_script_refuses_without_the_agent_binary():
    with _tmp() as tmp:
        result = _run_build(_stage_dir(tmp, agent=False), tmp / "out")
    assert result.returncode == 1
    assert "lockdown-agent.exe" in result.stderr


def test_build_script_reports_optional_companions_as_optional():
    with _tmp() as tmp:
        result = _run_build(_stage_dir(tmp), tmp / "out")
    combined = result.stdout + result.stderr
    assert "optional companion not staged" in combined
    assert "lockdown-watchdog.exe" in combined


def test_build_script_refuses_to_guess_a_server_url():
    """S213 removed the baked default.

    A default that silently pointed at the deployed Worker enrolled devices into the
    wrong server, where their tokens did not exist. The build therefore refuses to
    guess and asks for --server-url.
    """
    with _tmp() as tmp:
        result = _run_build(_stage_dir(tmp), tmp / "out", server_url=None)

    assert result.returncode == 1
    assert "--server-url" in result.stderr


def test_build_script_uses_the_server_url_it_is_given():
    if _makensis() is None:
        _skip("makensis not installed")
        return

    with _tmp() as tmp:
        result = _run_build(_stage_dir(tmp), tmp / "out", server_url=TEST_SERVER_URL)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "server-url: https://lockdown.example.test" in result.stdout


def test_build_script_compiles_a_real_installer():
    """makensis produces a PE executable from the dummy staging dir."""
    if _makensis() is None:
        _skip("makensis not installed")
        return

    with _tmp() as tmp:
        out = tmp / "out"
        result = _run_build(_stage_dir(tmp), out)
        exe = out / "lockdown-installer.exe"
        assert result.returncode == 0, result.stdout + result.stderr
        assert exe.is_file() and exe.stat().st_size > 10_000
        assert exe.read_bytes()[:2] == b"MZ", "output is not a PE executable"

    # Only the two intentional File /nonfatal warnings are acceptable.
    warnings = [
        line
        for line in (result.stdout + result.stderr).splitlines()
        if line.lower().startswith("warning")
    ]
    unexpected = [w for w in warnings if "7010" not in w]
    assert not unexpected, "unexpected makensis warnings:\n" + "\n".join(unexpected)


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
