"""Tests for scripts/sign-release-metadata.py.

The tool exists because the `agent_release` KV record had no producer: the Worker
serves whatever metadata is published, and `serverless/README.md` told the operator
to hand-write `sha256` and `signature` into a heredoc. Three ways that goes wrong
are all silent — a copied hash that drifts from the bytes, a signature over a
different hash, and (the structural one) **one top-level signature with two
per-platform hashes**, which can only ever be valid for one of them. A pinned agent
refuses all three, so the failure is a fleet that quietly stops updating.

So these tests do not re-implement verification. They feed the emitted metadata to
`agent.verify_update_signature` — the function the device actually runs — and require
it to accept what we sign and reject everything else.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

# pytest is imported dynamically: it lives in agent/.venv (see
# scripts/script_test_runner.py, which runs these suites with that interpreter), so
# a static `import pytest` is unresolved for any analyser that does not share it.
pytest: Any = importlib.import_module("pytest")

SCRIPT = Path(__file__).parent / "sign-release-metadata.py"
REPO = Path(__file__).parent.parent
AGENT_DIR = REPO / "agent"


def load_module():
    spec = importlib.util.spec_from_file_location("sign_release_metadata", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_module()

requires_openssl = pytest.mark.skipif(
    shutil.which("openssl") is None, reason="openssl is required to generate/sign keys"
)


@pytest.fixture(scope="module")
def agent_module():
    """The real agent verifier (agent/.venv has the cryptography dependency)."""
    if str(AGENT_DIR) not in sys.path:
        sys.path.insert(0, str(AGENT_DIR))
    loaded = None
    try:
        import agent as loaded
    except ImportError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"agent.py cannot be imported here: {exc}")
    assert loaded is not None
    return loaded


@pytest.fixture(scope="module")
def keypair(tmp_path_factory):
    """A throwaway Ed25519 keypair, made the way the release job makes one."""
    if shutil.which("openssl") is None:  # pragma: no cover - environment guard
        pytest.skip("openssl is required")
    directory = tmp_path_factory.mktemp("keys")
    private = directory / "update_signing.key"
    public = directory / "update_signing.pub"
    subprocess.run(
        ["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(private)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)],
        check=True,
        capture_output=True,
    )
    return private, public


@pytest.fixture()
def artifacts(tmp_path):
    """Two platform builds whose bytes differ, as a real release has."""
    windows = tmp_path / "lockdown-agent-windows-x64.exe"
    linux = tmp_path / "lockdown-agent-linux-x64"
    windows.write_bytes(b"MZ windows build bytes")
    linux.write_bytes(b"\x7fELF linux build bytes")
    return {"win": windows, "linux": linux}


def run_cli(*args: str) -> subprocess.CompletedProcess:
    """Invoke the real CLI, not the imported module — the operator runs this."""
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def emitted_metadata(*args: str) -> dict:
    result = run_cli(*args)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def sign_metadata(version: str, artifacts: dict[str, Path], key: Path, **extra: str) -> dict:
    args = ["--version", version, "--key", str(key)]
    for platform, path in artifacts.items():
        args += ["--artifact", f"{platform}={path}"]
    for flag, value in extra.items():
        args += [f"--{flag.replace('_', '-')}", value]
    return emitted_metadata(*args)


# ---------------------------------------------------------------------------
# The signature the device will check
# ---------------------------------------------------------------------------


@requires_openssl
def test_every_platform_signature_verifies_with_the_real_agent_verifier(
    keypair, artifacts, agent_module
):
    _private, public = keypair
    metadata = sign_metadata("1.1.0", artifacts, _private)

    cfg = {"update_public_key": str(public)}
    for platform, entry in metadata["platforms"].items():
        assert entry["signature_alg"] == "ed25519"
        assert agent_module.verify_update_signature(
            cfg, entry["signature"], metadata["latest_version"], entry["sha256"]
        ), f"{platform} signature was rejected by the agent verifier"


@requires_openssl
def test_a_single_signature_cannot_cover_two_different_platforms(keypair, artifacts, agent_module):
    """The structural bug this tool exists to prevent.

    The signed message is "v1:{version}:{sha256}", so a signature is bound to one
    hash. Serving one top-level signature with different per-platform hashes leaves
    every platform but one unable to verify — silently, as a refused update.
    """
    _private, public = keypair
    metadata = sign_metadata("1.1.0", artifacts, _private)
    win = metadata["platforms"]["win"]
    linux = metadata["platforms"]["linux"]

    assert win["sha256"] != linux["sha256"]
    assert win["signature"] != linux["signature"]

    cfg = {"update_public_key": str(public)}
    # Correct signature, wrong platform's hash → refused.
    assert not agent_module.verify_update_signature(
        cfg, win["signature"], "1.1.0", linux["sha256"]
    )
    # Correct hash, wrong signature → refused.
    assert not agent_module.verify_update_signature(
        cfg, linux["signature"], "1.1.0", win["sha256"]
    )


@requires_openssl
def test_no_top_level_signature_is_emitted_for_a_multi_platform_release(keypair, artifacts):
    """A top-level signature would be a lie for every platform but one."""
    _private, _public = keypair
    metadata = sign_metadata("1.1.0", artifacts, _private)

    assert "signature" not in metadata
    assert "sha256" not in metadata
    assert set(metadata["platforms"]) == {"win", "linux"}


@requires_openssl
def test_a_single_platform_release_also_mirrors_the_top_level_shape(keypair, tmp_path, agent_module):
    """Older readers (and README's documented shape) read sha256/signature up top."""
    _private, public = keypair
    only = tmp_path / "lockdown-agent-windows-x64.exe"
    only.write_bytes(b"MZ only platform")

    metadata = sign_metadata("2.0.0", {"win": only}, _private)

    assert metadata["sha256"] == metadata["platforms"]["win"]["sha256"]
    assert metadata["signature"] == metadata["platforms"]["win"]["signature"]
    assert agent_module.verify_update_signature(
        {"update_public_key": str(public)}, metadata["signature"], "2.0.0", metadata["sha256"]
    )


@requires_openssl
def test_a_version_that_is_not_the_signed_one_is_refused(keypair, artifacts, agent_module):
    _private, public = keypair
    metadata = sign_metadata("1.1.0", artifacts, _private)
    win = metadata["platforms"]["win"]

    assert not agent_module.verify_update_signature(
        {"update_public_key": str(public)}, win["signature"], "1.1.1", win["sha256"]
    )


@requires_openssl
def test_a_different_key_cannot_verify_the_signature(keypair, artifacts, agent_module, tmp_path):
    """Pinning means the *right* key verifies — not just some signature."""
    _private, _public = keypair
    metadata = sign_metadata("1.1.0", artifacts, _private)
    win = metadata["platforms"]["win"]

    other_private = tmp_path / "other.key"
    other_public = tmp_path / "other.pub"
    subprocess.run(
        ["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(other_private)],
        check=True, capture_output=True,
    )
    subprocess.run(
        ["openssl", "pkey", "-in", str(other_private), "-pubout", "-out", str(other_public)],
        check=True, capture_output=True,
    )

    assert not agent_module.verify_update_signature(
        {"update_public_key": str(other_public)}, win["signature"], "1.1.0", win["sha256"]
    )


# ---------------------------------------------------------------------------
# The bytes the signature covers
# ---------------------------------------------------------------------------


@requires_openssl
def test_the_hash_is_of_the_bytes_actually_served(keypair, tmp_path):
    """A hash copied by hand drifts from the file; a computed one cannot."""
    import hashlib

    _private, _public = keypair
    artifact = tmp_path / "lockdown-agent-linux-x64"
    artifact.write_bytes(b"\x7fELF exact bytes")

    metadata = sign_metadata("3.0.0", {"linux": artifact}, _private)
    entry = metadata["platforms"]["linux"]

    assert entry["sha256"] == hashlib.sha256(b"\x7fELF exact bytes").hexdigest()
    assert entry["size"] == len(b"\x7fELF exact bytes")


@requires_openssl
def test_changing_one_byte_invalidates_the_signature(keypair, tmp_path, agent_module):
    """What a truncated or swapped download looks like to the device."""
    _private, public = keypair
    artifact = tmp_path / "lockdown-agent-linux-x64"
    artifact.write_bytes(b"original bytes")
    metadata = sign_metadata("1.1.0", {"linux": artifact}, _private)
    signed = metadata["platforms"]["linux"]["sha256"]

    import hashlib

    tampered = hashlib.sha256(b"tampered bytes").hexdigest()
    assert not agent_module.verify_update_signature(
        {"update_public_key": str(public)}, metadata["platforms"]["linux"]["signature"],
        "1.1.0", tampered,
    )
    assert signed != tampered


# ---------------------------------------------------------------------------
# Deployment shapes
# ---------------------------------------------------------------------------


@requires_openssl
def test_unsigned_metadata_is_emitted_loudly_and_refused_by_a_pinned_agent(
    tmp_path, artifacts, agent_module, keypair
):
    """--unsigned is allowed, but nothing pretends it is verified."""
    result = run_cli(
        "--version", "1.1.0", "--unsigned",
        "--artifact", f"win={artifacts['win']}",
        "--artifact", f"linux={artifacts['linux']}",
    )
    assert result.returncode == 0
    metadata = json.loads(result.stdout)
    assert "UNSIGNED" in result.stderr
    assert all(entry["signature"] is None for entry in metadata["platforms"].values())

    _private, public = keypair
    win = metadata["platforms"]["win"]
    assert not agent_module.verify_update_signature(
        {"update_public_key": str(public)}, "" , "1.1.0", win["sha256"]
    )


def test_signing_requires_a_key_unless_unsigned_is_explicit(tmp_path, artifacts):
    result = run_cli(
        "--version", "1.1.0", "--artifact", f"win={artifacts['win']}"
    )
    assert result.returncode == 2
    assert "--key is required" in result.stderr


@requires_openssl
def test_unsigned_and_key_together_is_rejected(keypair, artifacts):
    _private, _public = keypair
    result = run_cli(
        "--version", "1.1.0", "--unsigned", "--key", str(_private),
        "--artifact", f"win={artifacts['win']}",
    )
    assert result.returncode == 2


def test_built_at_defaults_to_the_newest_artifact(tmp_path, artifacts):
    """The release date is recorded even when CI does not pass one."""
    metadata = emitted_metadata(
        "--version", "1.1.0", "--unsigned",
        "--artifact", f"win={artifacts['win']}",
        "--artifact", f"linux={artifacts['linux']}",
    )

    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z", metadata["built_at"])


@requires_openssl
def test_built_at_is_recorded_when_given(keypair, artifacts):
    _private, _public = keypair
    metadata = sign_metadata(
        "1.1.0", artifacts, _private, built_at="2026-11-03T00:00:00.000Z"
    )
    assert metadata["built_at"] == "2026-11-03T00:00:00.000Z"


def test_a_version_containing_a_colon_is_rejected(tmp_path):
    """'v1:1:2:abc' would make two different (version, hash) pairs sign the same bytes."""
    artifact = tmp_path / "agent.exe"
    artifact.write_bytes(b"bytes")
    result = run_cli(
        "--version", "1:2", "--unsigned", "--artifact", f"win={artifact}"
    )
    assert result.returncode == 2
    assert "must match" in result.stderr


def test_an_unknown_platform_is_rejected(tmp_path):
    """The Worker looks up `platforms[<X-Agent-Platform>]`, so a typo is unfindable."""
    artifact = tmp_path / "agent.exe"
    artifact.write_bytes(b"bytes")
    result = run_cli(
        "--version", "1.1.0", "--unsigned", "--artifact", f"windows={artifact}"
    )
    assert result.returncode == 2
    assert "unknown platform" in result.stderr


def test_a_missing_artifact_is_rejected(tmp_path):
    result = run_cli(
        "--version", "1.1.0", "--unsigned", "--artifact", f"win={tmp_path / 'nope.exe'}"
    )
    assert result.returncode == 2
    assert "not found" in result.stderr


def test_an_empty_artifact_is_rejected(tmp_path):
    """An empty build would publish a valid signature over nothing."""
    artifact = tmp_path / "agent.exe"
    artifact.touch()
    result = run_cli(
        "--version", "1.1.0", "--unsigned", "--artifact", f"win={artifact}"
    )
    assert result.returncode == 2
    assert "empty" in result.stderr


@requires_openssl
def test_out_writes_the_same_document_it_prints(keypair, artifacts, tmp_path):
    _private, _public = keypair
    out = tmp_path / "agent-release.json"
    result = run_cli(
        "--version", "1.1.0", "--key", str(_private),
        "--artifact", f"win={artifacts['win']}",
        "--artifact", f"linux={artifacts['linux']}",
        "--out", str(out),
    )
    assert result.returncode == 0
    written = json.loads(out.read_text())
    assert written["latest_version"] == "1.1.0"
    assert "Wrote" in result.stdout


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
