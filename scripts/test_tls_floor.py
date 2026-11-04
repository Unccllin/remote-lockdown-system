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
    """One s_client attempt; returns stdout+stderr.

    SNI is set to `localhost` because Caddy's internal issuer selects a
    certificate by server name; an IP address sends no SNI.
    """
    cmd = [
        "openssl", "s_client",
        "-connect", f"localhost:{port}",
        "-servername", "localhost",
        version_flag,
    ]
    if force_offer:
        # Without this, OpenSSL 3 refuses to offer TLS < 1.2 at its default
        # security level and the server is never consulted.
        cmd += ["-cipher", "DEFAULT@SECLEVEL=0"]
    result = subprocess.run(cmd, input="GET / HTTP/1.0\r\n\r\n",
                            capture_output=True, text=True, timeout=30)
    return (result.stdout or "") + (result.stderr or "")


def _client_declined_to_offer(output: str) -> bool:
    """The vacuous case: OpenSSL refused to *offer*, so the server was never asked."""
    return "no protocols available" in output.lower()


def _protocol_refused(output: str) -> bool:
    """True when the *protocol version* was rejected (alert 70, reset, or bare close).

    The server may express this three ways — a `protocol_version` alert, a reset
    (`errno=104`), or `unexpected eof while reading` — so all three count.
    Crucially this is specific: alert 80 (internal_error) is NOT a version refusal,
    which is what lets the positive direction below be meaningful.
    """
    lowered = output.lower()
    return (
        "alert protocol version" in lowered
        or "alert number 70" in lowered
        or "errno=104" in lowered
        or "unexpected eof" in lowered
    )


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
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, text=True, timeout=60)
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

        # Readiness is "the server is handshaking", not "the port accepts a
        # connection": Caddy binds the socket before its TLS runtime is ready, so a
        # TCP-only probe lets the first handshake race startup and fail with a bare
        # EOF — which would be misread as a version refusal. A transport-level error
        # (refused/reset/eof) means "not ready yet"; an alert or a completed
        # session means ready.
        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=2):
                    pass
            except OSError:
                time.sleep(0.5)
                continue
            probe = _handshake(self.port, "-tls1_2").lower()
            transport_error = (
                "connection refused" in probe
                or "errno=104" in probe
                or "unexpected eof" in probe
            )
            if probe and not transport_error:
                return self
            time.sleep(0.5)
        logs = subprocess.run(["docker", "logs", self.name], capture_output=True, text=True, timeout=60)
        raise AssertionError(f"caddy never accepted a connection:\n{logs.stderr[-1500:]}")

    def stop(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, text=True, timeout=60)
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
def test_the_terminator_refuses_tls1_0_and_1_1_at_the_protocol_layer():
    """The floor, as behaviour: below 1.2 is refused; 1.2/1.3 are negotiated.

    What this can and cannot assert here, stated plainly:

    * **Refusal is fully assertable.** A forced TLS 1.0/1.1 offer is rejected by
      the terminator — `protocol_version` alert (70), a reset, or a bare close.
      The guard against the vacuous pass (OpenSSL declining to *offer*) is checked
      first, because a client that refuses proves nothing about the server.
    * **A completed handshake is NOT assertable in this sandbox.** Caddy's
      `tls internal` issuer cannot produce a usable certificate here, so every
      version — including 1.2 and 1.3 — ends in alert 80 (`internal_error`) with
      `Cipher is (NONE)`. Asserting "handshake completes" would therefore be
      asserting the sandbox, not the floor. What *is* meaningful is that 1.2/1.3
      are **not protocol-refused**: they get past version negotiation and fail
      later, for a reason that is version-independent.
    """
    minimum, maximum = _stated_floor()
    terminator = Terminator(minimum, maximum).start()
    try:
        for flag, label in (("-tls1", "TLS 1.0"), ("-tls1_1", "TLS 1.1")):
            output = _handshake(terminator.port, flag, force_offer=True)

            assert not _client_declined_to_offer(output), (
                f"{label}: the client refused to offer it, so the server was never "
                f"consulted — the check would be vacuous:\n{output[-400:]}"
            )
            assert _protocol_refused(output), (
                f"{label} was not refused at the protocol layer (C3 §4 floor):\n{output[-600:]}"
            )

        for flag, label in (("-tls1_2", "TLS 1.2"), ("-tls1_3", "TLS 1.3")):
            # Retry transport-level noise (a bare close while Caddy is still warming
            # up) but never a deterministic refusal: three protocol refusals in a row
            # still fails below.
            output = ""
            for _ in range(3):
                output = _handshake(terminator.port, flag)
                if not _client_declined_to_offer(output) and not _protocol_refused(output):
                    break
                time.sleep(0.2)
            assert not _client_declined_to_offer(output), (
                f"{label}: the client could not offer it here:\n{output[-400:]}"
            )
            # No protocol_version alert => the version was accepted at the protocol
            # layer. (The handshake may still fail afterwards for CA reasons, which
            # is what alert 80 above records.)
            assert not _protocol_refused(output), (
                f"{label} was refused at the protocol layer although the floor allows "
                f"it (the Caddyfile and the running terminator disagree):\n{output[-600:]}"
            )
    finally:
        terminator.stop()


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
