#!/usr/bin/env python3
"""Tests for scripts/win_installer_check.py.

The check exists because the 1.0.5 MSI was built `perMachine: false` and nothing in the build said so —
a per-user MSI installed as SYSTEM lands in the SYSTEM profile, invisible to the user who needs it. These
tests pin the two things that make the check worth running: it fails on that config, and it fails on a
checksum that does not match the published file.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import win_installer_check as check  # noqa: E402


def write_package_json(path: Path, msi: dict, nsis: dict | None = None) -> Path:
    path.write_text(
        json.dumps({"build": {"msi": msi, "nsis": nsis or {}}}),
        encoding="utf-8",
    )
    return path


def test_per_user_msi_fails(tmp_path: Path) -> None:
    """The 1.0.5 configuration: device-context deployment is impossible, so this must fail."""
    pkg = write_package_json(tmp_path / "package.json", {"perMachine": False, "runAfterFinish": True})
    assert check.check_packaging_config(pkg) == 1


def test_per_machine_msi_passes(tmp_path: Path) -> None:
    pkg = write_package_json(tmp_path / "package.json", {"perMachine": True}, {"perMachine": True})
    assert check.check_packaging_config(pkg) == 0


def test_missing_artefacts_fail(tmp_path: Path) -> None:
    release = tmp_path / "release"
    release.mkdir()
    (release / "readme.txt").write_text("nothing to install", encoding="utf-8")
    # The helpers return a COUNT of failed requirements, not a boolean — three artefacts are missing.
    assert check.check_release_dir(release, require_signature=False) >= 1


def test_checksum_match_and_mismatch(tmp_path: Path) -> None:
    release = tmp_path / "release"
    release.mkdir()
    msi = release / "remote-lockdown-admin-1.0.5.msi"
    msi.write_bytes(b"msi-bytes")
    exe = release / "remote-lockdown-admin-1.0.5.exe"
    exe.write_bytes(b"exe-bytes")

    # Correct sums for both artefacts: no failures.
    (release / "SHA256SUMS-windows-x64").write_text(
        f"{check.sha256(msi)}  {msi.name}\n{check.sha256(exe)}  {exe.name}\n",
        encoding="utf-8",
    )
    assert check.check_release_dir(release, require_signature=False) == 0

    # A published hash that does not match the file must fail, not warn.
    (release / "SHA256SUMS-windows-x64").write_text(
        f"{'0' * 64}  {msi.name}\n{check.sha256(exe)}  {exe.name}\n",
        encoding="utf-8",
    )
    assert check.check_release_dir(release, require_signature=False) == 1


def test_missing_signing_tool_is_a_failure_only_when_required(tmp_path: Path) -> None:
    """A skip is not a pass — so asking for a signature with no tool must fail, not silently succeed."""
    release = tmp_path / "release"
    release.mkdir()
    (release / "remote-lockdown-admin-1.0.5.msi").write_bytes(b"x")
    (release / "remote-lockdown-admin-1.0.5.exe").write_bytes(b"y")

    original = check.shutil.which
    check.shutil.which = lambda name: None  # simulate a host without osslsigncode
    try:
        assert check.check_release_dir(release, require_signature=False) == 0
        assert check.check_release_dir(release, require_signature=True) == 1
    finally:
        check.shutil.which = original


if __name__ == "__main__":
    # Shared runner; see scripts/script_test_runner.py for why a `__main__` block is mandatory here.
    from script_test_runner import run

    raise SystemExit(run(__file__))
