#!/usr/bin/env python3
"""Prove the TLS floor at the terminator, and that the floor is stated, not implied.

Why this exists
---------------
D-116 / C3 §4 require TLS >= 1.2 for the verdict fetch. The *device* cannot enforce
it: PBL holds only EFI_HTTP_PROTOCOL, HttpDxe sets ConnectionEnd/VerifyMethod/
VerifyHost/SessionState and exposes no version, and EDK2's TlsDxe creates its
context as TLS 1.0 (NetworkPkg/TlsDxe/TlsDriver.c:263 -> TlsCtxNew(TLS10...)), with
only SSLv3 disabled. So the floor is enforced where we terminate TLS — Caddy for the
self-hosted deployment, Cloudflare's zone setting for the Worker — and the client
simply offers what it offers.

Two things are therefore worth asserting, and this file does both:

  1. the repo's Caddyfile *states* the protocol range (a default is not a decision —
     an auditor should be able to read the floor, not infer it), and
  2. a Caddy carrying that same line actually refuses TLS 1.0 and 1.1 and accepts
     1.2/1.3.

The vacuity trap this test is built around
------------------------------------------
OpenSSL 3 at its default security level refuses to even *offer* TLS 1.0
(`ssl_setup_handshake:no protocols available`). A naive `openssl s_client -tls1`
test therefore "passes" without the server being involved at all. This test forces
the offer with `-cipher DEFAULT@SECLEVEL=0` and treats `no protocols available` as a
**failure** — otherwise the check would assert nothing.

Skipped (loudly) when docker or openssl is unavailable: the behaviour needs a real
terminator, and faking it would be the thing this test exists to prevent.

Run:
    scripts/test_tls_floor.py
    make test-scripts         # auto-discovered
"""

from __future__ import annotations

import importlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

# pytest lives in agent/.venv (see scripts/script_test_runner.py).
pytest: Any = importlib.import_module("pytest")

REPO = Path(__file__).resolve().parent.parent
CADDYFILE = REPO / "Caddyfile"

CADDY_IMAGE = "caddy:2"
BOOT_TIMEOUT = 60

requires_terminator = pytest.mark.skipif(
    not (shutil.which("docker") and shutil.which("openssl")),
    reason="needs docker (a real TLS terminator) and openssl; neither is faked here",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _stated_floor() -> tuple[str, str]:
    """The protocol range the repo Caddyfile declares, as (min, max)."""
    text = CADDYFILE.read_text()
    match = re.search(r"protocols\s+(\S+)(?:\s+(\S+))?", text)
    assert match, (
        "Caddyfile does not state a TLS protocol range — the floor must be "
        "readable, not inferred from a default"
    )
    return match.group(1), match.group(2) or match.group(1)


def _handshake(port: int, version_flag: str, *, force_offer: bool = False) -> str:
    """One s_client attempt; returns stdout+stderr as text."""
    cmd = [
        "openssl", "s_client",
        "-connect", f"127.0.0.1:{port}",
        version_flag,
        "-noservername",
    ]
    if force_offer:
        # Without this, OpenSSL 3 refuses to offer TLS < 1.2 at its default
        # security level and the server is never consulted.
        cmd += ["-cipher", "DEFAULT@SECLEVEL=0"]
    result = subprocess.run(cmd, input="", capture_output=True, text=True, timeout=30)
    return (result.stdout or "") + (result.stderr or "")


def _negotiated(output: str) -> str | None:
    match = re.search(r"Protocol\s*:\s*(TLSv[\d.]+)", output)
    return match.group(1) if match else None


def _server_refused(output: str) -> bool:
    """True when the *server* rejected the protocol, not the client its own offer."""
    lowered = output.lower()
    return "alert protocol version" in lowered or "alert number 70" in lowered


class Terminator:
    """A Caddy container carrying the repo's declared protocol range."""

    def __init__(self, min_version: str, max_version: str) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="tls-floor-"))
        self.port = _free_port()
        self.name = f"tls-floor-{uuid.uuid4().hex[:8]}"
        (self.dir / "Caddyfile").write_text(
            f":8443 {{\n"
            f"\ttls internal {{\n"
            f"\t\tprotocols {min_version} {max_version}\n"
            f"\t}}\n"
            f'\trespond "ok"\n'
            f"}}\n"
        )

    def start(self) -> "Terminator":
        subprocess.run(
            ["docker", "rm", "-f", self.name],
            capture_output=True, text=True, timeout=60,
        )
        run = subprocess.run(
            [
                "docker", "run", "-d", "--rm", "--name", self.name,
                "-p", f"127.0.0.1:{self.port}:8443",
                "-v", f"{self.dir}:/w", "-w", "/w",
                CADDY_IMAGE,
                "caddy", "run", "--config", "/w/Caddyfile", "--adapter", "caddyfile",
            ],
            capture_output=True, text=True, timeout=300,
        )
        assert run.returncode == 0, f"caddy did not start: {run.stderr[-500:]}"

        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            if _negotiated(_handshake(self.port, "-tls1_2")):
                return self
            time.sleep(0.5)
        logs = subprocess.run(
            ["docker", "logs", self.name], capture_output=True, text=True, timeout=60
        )
        raise AssertionError(f"caddy never completed a TLS 1.2 handshake:\n{logs.stderr[-1500:]}")

    def stop(self) -> None:
        subprocess.run(
            ["docker", "rm", "-f", self.name], capture_output=True, text=True, timeout=60
        )
        shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# The two assertions
# ---------------------------------------------------------------------------


def test_the_caddyfile_states_the_floor():
    """A default is not a decision: the range must be readable in the config."""
    minimum, maximum = _stated_floor()
    assert minimum == "tls1.2", f"Caddyfile floor is {minimum}, C3 §4 requires tls1.2+"
    assert maximum in ("tls1.2", "tls1.3"), f"unexpected maximum {maximum}"


@requires_terminator
def test_a_terminator_with_that_floor_refuses_tls1_0_and_1_1():
    minimum, maximum = _stated_floor()
    terminator = Terminator(minimum, maximum).start()
    try:
        # --- accepted: 1.2 and 1.3 -------------------------------------------
        tls12 = _handshake(terminator.port, "-tls1_2")
        assert _negotiated(tls12) == "TLSv1.2", f"TLS 1.2 was not negotiated:\n{tls12[-400:]}"

        tls13 = _handshake(terminator.port, "-tls1_3")
        assert _negotiated(tls13) == "TLSv1.3", f"TLS 1.3 was not negotiated:\n{tls13[-400:]}"

        for flag, label in (("-tls1", "TLS 1.0"), ("-tls1_1", "TLS 1.1")):
            output = _handshake(terminator.port, flag, force_offer=True)

            # The vacuity guard, first: if OpenSSL refused to offer, the server was
            # never asked and this test proves nothing.
            assert "no protocols available" not in output.lower(), (
                f"{label}: the client refused to offer it, so the server was never "
                f"consulted — the check would be vacuous:\n{output[-400:]}"
            )
            # The assertion: the terminator rejected the protocol itself.
            assert _server_refused(output), (
                f"{label} was not refused by the server (C3 §4 floor):\n{output[-600:]}"
            )
    finally:
        terminator.stop()


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
