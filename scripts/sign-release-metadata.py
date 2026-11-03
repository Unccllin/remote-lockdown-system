#!/usr/bin/env python3
"""Build the signed ``agent_release`` metadata the update endpoints serve.

Why this exists
---------------
Both backends serve update metadata out of one record: the Express server signs it
in-process from ``UPDATE_SIGNING_KEY``, and the Worker reads an ``agent_release`` KV
key that nothing in this repository produced. `serverless/README.md` therefore told
the operator to hand-write ``sha256`` and ``signature`` into a heredoc — the exact
shape that goes wrong silently: a hand-copied hash, a signature over a *different*
hash, or a per-platform hash with a single top-level signature. An agent with a
pinned key refuses all three, and the failure is a fleet that quietly stops updating.

The message the agent verifies is ``v1:{version}:{sha256}``, so a signature is
bound to one hash. **A single top-level signature cannot cover two platforms whose
builds differ** — signing per platform is the only shape that can be correct when
``platforms.win.sha256 != platforms.linux.sha256``.

Usage:
    scripts/sign-release-metadata.py \\
        --version 1.1.0 \\
        --key secrets/update_signing.key \\
        --artifact win=agent/staging/lockdown-agent-windows-x64.exe \\
        --artifact linux=agent/staging/lockdown-agent-linux-x64 \\
        --out /tmp/agent-release.json

    # No key yet (nothing is pinned, or the fleet is not pinned):
    scripts/sign-release-metadata.py --version 1.1.0 --unsigned \\
        --artifact win=... --artifact linux=...

Publish the result (the Worker holds no key — it only serves what was signed):

    npx wrangler kv key put --binding=LOCKDOWN_KV agent_release --path /tmp/agent-release.json

Signing uses `openssl pkeyutl -sign -rawin` rather than a Python crypto library so
this runs wherever the release job runs, with the same tool that generated the
keypair (`scripts/generate-update-keys.sh`).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import NoReturn

#: The platform names the agent sends in `X-Agent-Platform` (agent.py: "win" on
#: Windows, "linux" everywhere else). Keys in `platforms` must match these or the
#: Worker will not find a per-platform hash for the requesting device.
ALLOWED_PLATFORMS = ("win", "linux", "darwin")

#: Version/platform text ends up inside a colon-delimited signed message, so a
#: ':' would make "v1:1:2:abc" ambiguous — two different (version, hash) pairs
#: could produce the same signed bytes.
SAFE_TOKEN = re.compile(r"^[0-9A-Za-z._+~-]+$")


def _fail(message: str) -> NoReturn:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(2)


def _warn(message: str) -> None:
    print(f"WARNING: {message}", file=sys.stderr)


def _digest(path: Path) -> tuple[str, int]:
    """SHA-256 (hex) and size of the exact bytes that will be served."""
    sha = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha.update(chunk)
            size += len(chunk)
    return sha.hexdigest(), size


def _signed_payload(version: str, sha256: str) -> bytes:
    """The exact bytes the agent verifies (agent.py verify_update_signature)."""
    return f"v1:{version}:{sha256}".encode()


def _sign(message: bytes, key: Path) -> str:
    """Detached Ed25519 signature, base64 (standard alphabet, padded).

    The agent decodes with base64.b64decode(validate=True), which rejects
    URL-safe alphabets and missing padding — so base64.b64encode is required,
    not urlsafe_b64encode.
    """
    with tempfile.TemporaryDirectory() as tmp:
        msg_path = Path(tmp) / "msg.bin"
        sig_path = Path(tmp) / "sig.bin"
        msg_path.write_bytes(message)
        result = subprocess.run(
            [
                "openssl", "pkeyutl", "-sign", "-rawin",
                "-inkey", str(key), "-in", str(msg_path), "-out", str(sig_path),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            _fail(f"openssl could not sign with {key}: {result.stderr.strip()}")
        return base64.b64encode(sig_path.read_bytes()).decode("ascii")


def _parse_artifact(value: str) -> tuple[str, Path]:
    platform, sep, path = value.partition("=")
    if not sep or not platform or not path:
        _fail(f"--artifact expects PLATFORM=PATH, got {value!r}")
    if platform not in ALLOWED_PLATFORMS:
        _fail(
            f"unknown platform {platform!r} — the agent sends one of "
            f"{', '.join(ALLOWED_PLATFORMS)} in X-Agent-Platform"
        )
    artifact = Path(path)
    if not artifact.is_file():
        _fail(f"artifact not found: {artifact}")
    if artifact.stat().st_size == 0:
        _fail(f"artifact is empty: {artifact}")
    return platform, artifact


def _build_metadata(
    version: str,
    artifacts: dict[str, Path],
    key: Path | None,
    built_at: str | None,
) -> dict:
    if not SAFE_TOKEN.match(version):
        _fail(f"version {version!r} must match {SAFE_TOKEN.pattern} (it is inside the signed message)")

    entries: dict[str, dict] = {}
    for platform, path in artifacts.items():
        sha256, size = _digest(path)
        entry: dict[str, object] = {"sha256": sha256, "size": size}
        if key is not None:
            entry["signature"] = _sign(_signed_payload(version, sha256), key)
            entry["signature_alg"] = "ed25519"
        else:
            entry["signature"] = None
            entry["signature_alg"] = None
        entries[platform] = entry

    if built_at is None:
        newest = max(path.stat().st_mtime for path in artifacts.values())
        built_at = datetime.fromtimestamp(newest, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    metadata: dict[str, object] = {
        "latest_version": version,
        "built_at": built_at,
        "platforms": entries,
    }

    # Mirror a single-platform release at the top level, which is the shape the
    # Worker (and README's older example) reads first. With two or more
    # platforms there is deliberately no top-level signature: it could only bind
    # one of the hashes, so it would be a lie for the others.
    if len(entries) == 1:
        only = next(iter(entries.values()))
        metadata.update(only)

    return metadata


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build signed agent_release metadata for the update endpoints",
    )
    parser.add_argument("--version", required=True, help="release version, e.g. 1.1.0")
    parser.add_argument(
        "--artifact",
        action="append",
        required=True,
        metavar="PLATFORM=PATH",
        help="agent binary to hash and sign; repeat per platform (win, linux, darwin)",
    )
    parser.add_argument(
        "--key",
        type=Path,
        help="Ed25519 private key PEM (scripts/generate-update-keys.sh)",
    )
    parser.add_argument(
        "--unsigned",
        action="store_true",
        help="emit metadata without a signature (pinned agents will refuse it)",
    )
    parser.add_argument("--built-at", help="ISO-8601 timestamp; defaults to the newest artifact's mtime")
    parser.add_argument("--out", type=Path, help="write here instead of stdout")
    args = parser.parse_args(argv)

    if args.unsigned and args.key:
        _fail("--unsigned and --key are mutually exclusive")
    if not args.unsigned and not args.key:
        _fail("--key is required (or pass --unsigned to publish unverifiable metadata)")
    if args.key and not args.key.is_file():
        _fail(f"signing key not found: {args.key}")

    artifacts = dict(_parse_artifact(value) for value in args.artifact)
    if len(artifacts) != len(args.artifact):
        _fail("the same platform was given more than once")

    if args.unsigned:
        _warn(
            "publishing UNSIGNED metadata — agents with a pinned update key will "
            "refuse this release and stay on their current version "
            "(see docs/CODE_SIGNING.md)"
        )

    metadata = _build_metadata(args.version, artifacts, args.key, args.built_at)
    text = json.dumps(metadata, indent=2) + "\n"

    if args.out:
        args.out.write_text(text)
        print(f"Wrote {args.out}")
        for platform, entry in metadata["platforms"].items():
            state = "signed" if entry.get("signature") else "UNSIGNED"
            print(f"  {platform}: {entry['sha256']} ({entry['size']} bytes, {state})")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
