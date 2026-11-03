#!/usr/bin/env python3
"""End-to-end proof of the Worker's agent-update path, against local workerd.

Why this exists
---------------
S195 proved the *Express* update path end to end (live server, real agent,
real Ed25519). The Worker — the backend that actually ships for this product —
was only unit-tested, with the signature supplied as a literal like
`'d2luLXNpZw=='` that no key ever produced. So the two properties that decide
whether a fleet can patch in the serverless deployment were asserted, not shown:

  * a signed release is accepted, and an unsigned or untrusted one is refused;
  * the signature served is the one bound to *this* platform's hash (the signed
    message is ``v1:{version}:{sha256}``, so a single top-level signature can
    only be valid for one platform's build).

This suite runs `wrangler dev` (local workerd, local KV, **no Cloudflare
account**), seeds KV the way the release job does, runs the real
`agent/agent.py` as a subprocess, and verifies signatures with the agent's own
`verify_update_signature`.

Running it
----------
It is heavy (~8s to boot workerd, a subprocess per case) and needs `wrangler`
resolvable without a network fetch, so it is **opt-in** — `make test-scripts`
and CI skip it unless asked:

    make test-worker-e2e          # sets LOCKDOWN_WORKER_E2E=1

Without the flag every test skips with that instruction rather than passing
silently, because "green while running nothing" is the failure mode this repo's
harness has paid for twice.
"""

from __future__ import annotations

import contextlib
import http.client
import importlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

# pytest lives in agent/.venv (see scripts/script_test_runner.py), so a static
# import is unresolved for any analyser that does not share that interpreter.
pytest: Any = importlib.import_module("pytest")

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
AGENT_DIR = REPO / "agent"
SERVERLESS = REPO / "serverless"
SIGN_TOOL = SCRIPTS / "sign-release-metadata.py"

# Generated per run: a literal that looks like a credential in source is a
# secret-scanner finding forever, and a fixed local token buys nothing.
ADMIN_TOKEN = f"worker-e2e-admin-{uuid.uuid4().hex}"
RELEASE_VERSION = "9.9.9"
BOOT_TIMEOUT = 60


# ---------------------------------------------------------------------------
# Environment gates
# ---------------------------------------------------------------------------


def _env_flag() -> bool:
    return os.environ.get("LOCKDOWN_WORKER_E2E") == "1"


def _wrangler_available() -> bool:
    """`npx --no-install` keeps this from downloading wrangler mid-test.

    A network fetch inside a test suite is a flake generator, and CI without
    wrangler should skip in under a second rather than install ~100 MB.
    """
    try:
        result = subprocess.run(
            ["npx", "--no-install", "wrangler", "--version"],
            cwd=str(SERVERLESS),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _openssl_available() -> bool:
    return shutil.which("openssl") is not None


def _python() -> str:
    venv = AGENT_DIR / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


requires_worker = pytest.mark.skipif(
    not _env_flag(),
    reason="set LOCKDOWN_WORKER_E2E=1 (or run `make test-worker-e2e`) — needs local workerd",
)
requires_tools = pytest.mark.skipif(
    not (_wrangler_available() and _openssl_available()),
    reason="needs `npx --no-install wrangler` and openssl (the local Worker uses no account)",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def _keypair(directory: Path) -> tuple[Path, Path]:
    private = directory / "update_signing.key"
    public = directory / "update_signing.pub"
    _run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(private)], check=True)
    _run(["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)], check=True)
    return private, public


def _kv_put(persist_dir: Path, key: str, payload: Path) -> None:
    """Seed local KV exactly as the release job seeds the real one.

    This runs in a *separate* wrangler process from the dev server; verified to
    be visible to a running `wrangler dev` that shares --persist-to.
    """
    result = _run(
        [
            "npx", "--no-install", "wrangler", "kv", "key", "put", key,
            "--binding=LOCKDOWN_KV",
            "--local",
            f"--persist-to={persist_dir}",
            f"--path={payload}",
        ],
        cwd=str(SERVERLESS),
        timeout=180,
    )
    assert result.returncode == 0, f"kv put {key} failed:\n{result.stdout}\n{result.stderr}"


def _signed_metadata(
    workdir: Path, private_key: Path, artifacts: dict[str, Path], *, signed: bool = True
) -> Path:
    """Build the agent_release record with the real release tool."""
    out = workdir / "agent-release.json"
    cmd = [sys.executable, str(SIGN_TOOL), "--version", RELEASE_VERSION, "--out", str(out)]
    for platform, path in artifacts.items():
        cmd += ["--artifact", f"{platform}={path}"]
    cmd += ["--key", str(private_key)] if signed else ["--unsigned"]
    result = _run(cmd, timeout=120)
    assert result.returncode == 0, f"signing failed:\n{result.stdout}\n{result.stderr}"
    return out


def _write_agent_config(
    path: Path, *, server_url: str, api_key: str, hostname: str, state_dir: Path, pin: str
) -> None:
    lines = [
        "[agent]",
        f"server_url = {server_url}",
        f"agent_key = {api_key}",
        f"hostname = {hostname}",
        "poll_interval = 300",
        f"lockdown_folder = {state_dir}",
        f"lock_sentinel = {state_dir / '.locked'}",
        f"pending_ack_file = {state_dir / '.pending_ack'}",
        f"recovery_key_file = {state_dir / '.recovery_key'}",
        "verify_tls = false",
        "boot_lock_enabled = false",
        "server_supports_ack_dedup = true",
        f"update_public_key = {pin or ''}",
    ]
    path.write_text("\n".join(lines) + "\n")


def _signed_headers(api_key: str, platform: str, version: str = "1.0.0") -> dict:
    """Headers a real device sends.

    `verifyAgentAuth` in the Worker requires X-Agent-Key, X-Timestamp, X-Nonce AND
    X-Signature; a bare key is a 401 (Express accepts it during its transition,
    which is why this only surfaced against workerd). The signature comes from the
    agent's own sign_headers(), not a reimplementation.
    """
    module = _agent_module()
    assert module is not None, "the agent module is required to sign requests"
    headers = dict(module.sign_headers(api_key, b""))
    headers["X-Agent-Version"] = version
    headers["X-Agent-Platform"] = platform
    return headers


def _clean_agent_env(state_dir: Path) -> dict:
    """An inherited agent var would override the config file (see agentEnv in the jest harness)."""
    env = {k: v for k, v in os.environ.items() if not k.isupper() or not k.startswith("AGENT_")}
    for name in ("DEVICE_API_KEY", "DEVICE_HOSTNAME", "SERVER_URL", "POLL_INTERVAL",
                 "LOCKDOWN_FOLDER", "LOCK_SENTINEL", "RECOVERY_KEY_FILE", "PENDING_ACK_FILE"):
        env.pop(name, None)
    env["LOCKDOWN_STATE_DIR"] = str(state_dir)
    return env


def _run_agent(config_path: Path, state_dir: Path) -> dict:
    """Real agent code: check in, then check for an update. Returns what it did."""
    script = f"""
import json, logging, sys
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
sys.path.insert(0, {str(AGENT_DIR)!r})
import agent

cfg = agent.load_config({str(config_path)!r})
agent.checkin(cfg)
agent.check_for_update(cfg)

pending = agent.UPDATE_PENDING_FILE
downloaded = agent.UPDATE_DOWNLOAD_FILE
signal = json.loads(pending.read_text()) if pending.exists() else None
print("@@RESULT@@" + json.dumps({{
    "mode": agent.update_verification_mode(cfg),
    "pending": signal,
    "download_exists": downloaded.exists(),
}}))
"""
    result = _run(
        [_python(), "-c", script],
        cwd=str(AGENT_DIR),
        env=_clean_agent_env(state_dir),
        timeout=180,
    )
    line = next(
        (ln for ln in (result.stdout or "").splitlines() if ln.startswith("@@RESULT@@")), None
    )
    assert line, f"agent produced no result\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    return json.loads(line[len("@@RESULT@@"):])


class Worker:
    """A local workerd process with its own KV directory."""

    def __init__(self, workdir: Path) -> None:
        self.workdir = workdir
        self.persist = workdir / "kv"
        self.port = _free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self._proc = None

    def start(self) -> Worker:
        log = (self.workdir / "dev.log").open("w")
        self._proc = subprocess.Popen(
            [
                "npx", "--no-install", "wrangler", "dev",
                "--port", str(self.port), "--ip", "127.0.0.1",
                f"--persist-to={self.persist}",
                "--var", f"ADMIN_TOKEN:{ADMIN_TOKEN}",
                "--var", "JWT_SECRET:local-e2e-jwt-secret-at-least-32-chars",
            ],
            cwd=str(SERVERLESS),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # own process group, so stop() can kill the tree
        )
        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            try:
                status, _, _ = self.http("GET", "/api/health")
                if status == 200:
                    return self
            except OSError:
                pass
            if self._proc.poll() is not None:
                raise AssertionError(
                    "wrangler dev exited early:\n" + (self.workdir / "dev.log").read_text()[-2000:]
                )
            time.sleep(0.5)
        raise AssertionError(
            f"worker did not answer on {self.url} within {BOOT_TIMEOUT}s:\n"
            + (self.workdir / "dev.log").read_text()[-2000:]
        )

    def stop(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
        with contextlib.suppress(subprocess.TimeoutExpired):
            self._proc.wait(timeout=15)
        # Still alive after SIGTERM: kill the whole group (wrangler spawns workerd).
        with contextlib.suppress(ProcessLookupError):
            os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)

    def http(
        self, method: str, path: str, body: dict | None = None, headers: dict | None = None
    ) -> tuple[int, dict, bytes]:
        """One request to the local worker.

        `http.client` against a fixed loopback host, rather than urllib on a built
        URL: there is no scheme to validate, and the connection is always this
        process's own workerd.
        """
        payload = json.dumps(body).encode() if body is not None else None
        merged = {"Content-Type": "application/json"} if payload is not None else {}
        merged.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request(method, path, body=payload, headers=merged)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def enroll(self, hostname: str) -> dict:
        status, _, raw = self.http(
            "POST", "/api/enroll",
            {"hostname": hostname, "owner_name": "Worker E2E"},
            {"Authorization": f"Bearer {ADMIN_TOKEN}"},
        )
        # The Worker answers 201 Created (the Express route does the same); accepting
        # only 200 here failed all five tests before they reached their subject.
        assert status in (200, 201), f"enroll failed: {status} {raw[:300]!r}"
        payload = json.loads(raw)
        assert payload.get("api_key"), payload
        return payload

    def device(self, device_id: str) -> dict:
        status, _, raw = self.http(
            "GET", f"/api/devices/{device_id}", headers={"Authorization": f"Bearer {ADMIN_TOKEN}"}
        )
        assert status == 200, f"device read failed: {status} {raw[:300]!r}"
        return json.loads(raw)

    def update(self, api_key: str, platform: str) -> dict:
        status, _, raw = self.http(
            "GET", "/api/agent/update",
            headers=_signed_headers(api_key, platform),
        )
        assert status == 200, f"update failed: {status} {raw[:300]!r}"
        return json.loads(raw)


@pytest.fixture()
def workdir():
    directory = Path(tempfile.mkdtemp(prefix="worker-e2e-"))
    try:
        yield directory
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def _agent_module() -> Any | None:
    """The real agent module, or None when its dependencies are absent.

    Imported through importlib: `agent/` is also a directory name, so a static
    analyser resolves `import agent` to the package directory and sees no
    attributes on it.
    """
    if str(AGENT_DIR) not in sys.path:
        sys.path.insert(0, str(AGENT_DIR))
    try:
        return importlib.import_module("agent")
    except ImportError:
        return None


# ---------------------------------------------------------------------------
# The four cases
# ---------------------------------------------------------------------------


@requires_worker
@requires_tools
def test_signed_release_is_accepted_and_the_mode_is_signature(workdir):
    """The flip E-AUTO-UPDATE needs, on the backend that ships."""
    private, public = _keypair(workdir)
    binary = workdir / "lockdown-agent"
    binary.write_bytes(b"WORKER-E2E-RELEASE-BYTES")

    _kv_put(workdir / "kv", "binary:agent", binary)
    metadata = _signed_metadata(workdir, private, {"linux": binary})
    _kv_put(workdir / "kv", "agent_release", metadata)

    worker = Worker(workdir).start()
    try:
        enrolled = worker.enroll("worker-e2e-signed")
        state_dir = workdir / "state"
        state_dir.mkdir()
        config = workdir / "config.ini"
        _write_agent_config(
            config,
            server_url=worker.url,
            api_key=enrolled["api_key"],
            hostname="worker-e2e-signed",
            state_dir=state_dir,
            pin=str(public),
        )

        result = _run_agent(config, state_dir)

        assert result["mode"] == "signature"
        assert result["pending"] is not None, "a correctly signed release must be applied"
        assert result["pending"]["signature_verified"] is True
        assert result["pending"]["version"] == RELEASE_VERSION
        # The Worker recorded how this device verifies updates.
        assert worker.device(enrolled["device"]["id"])["update_verification"] == "signature"
    finally:
        worker.stop()


@requires_worker
@requires_tools
def test_unsigned_release_is_refused_by_a_pinned_device(workdir):
    private, public = _keypair(workdir)
    binary = workdir / "lockdown-agent"
    binary.write_bytes(b"WORKER-E2E-UNSIGNED")

    _kv_put(workdir / "kv", "binary:agent", binary)
    metadata = _signed_metadata(workdir, private, {"linux": binary}, signed=False)
    _kv_put(workdir / "kv", "agent_release", metadata)

    worker = Worker(workdir).start()
    try:
        enrolled = worker.enroll("worker-e2e-unsigned")
        state_dir = workdir / "state"
        state_dir.mkdir()
        config = workdir / "config.ini"
        _write_agent_config(
            config,
            server_url=worker.url,
            api_key=enrolled["api_key"],
            hostname="worker-e2e-unsigned",
            state_dir=state_dir,
            pin=str(public),
        )

        result = _run_agent(config, state_dir)

        assert result["mode"] == "signature"
        assert result["pending"] is None
        assert result["download_exists"] is False
    finally:
        worker.stop()


@requires_worker
@requires_tools
def test_release_signed_by_an_untrusted_key_is_refused(workdir):
    trusted_private, trusted_public = _keypair(workdir)
    # A second keypair: the release is genuinely signed, just not by this device's key.
    other_dir = workdir / "other"
    other_dir.mkdir()
    other_private, _ = _keypair(other_dir)
    del trusted_private  # unused: the *device* pins acknowledged_public

    binary = workdir / "lockdown-agent"
    binary.write_bytes(b"WORKER-E2E-WRONG-KEY")
    _kv_put(workdir / "kv", "binary:agent", binary)
    metadata = _signed_metadata(workdir, other_private, {"linux": binary})
    _kv_put(workdir / "kv", "agent_release", metadata)

    worker = Worker(workdir).start()
    try:
        enrolled = worker.enroll("worker-e2e-wrong-key")
        state_dir = workdir / "state"
        state_dir.mkdir()
        config = workdir / "config.ini"
        _write_agent_config(
            config,
            server_url=worker.url,
            api_key=enrolled["api_key"],
            hostname="worker-e2e-wrong-key",
            state_dir=state_dir,
            pin=str(trusted_public),
        )

        result = _run_agent(config, state_dir)

        assert result["mode"] == "signature"
        assert result["pending"] is None
        assert result["download_exists"] is False
    finally:
        worker.stop()


@requires_worker
@requires_tools
def test_per_platform_signatures_are_served_and_verify(workdir):
    """One signature binds one hash, so each platform must get its own.

    This is the property the Worker could get wrong while looking correct: serving
    the *top-level* signature alongside a per-platform hash means every platform
    but one computes a different signed payload and silently refuses the update.
    """
    agent_module = _agent_module()
    if agent_module is None:
        pytest.skip("agent module not importable here (needs cryptography)")

    private, public = _keypair(workdir)
    win_binary = workdir / "lockdown-agent-windows.exe"
    linux_binary = workdir / "lockdown-agent-linux"
    win_binary.write_bytes(b"WORKER-E2E-WIN-BUILD")
    linux_binary.write_bytes(b"WORKER-E2E-LINUX-BUILD")

    _kv_put(workdir / "kv", "binary:agent", linux_binary)
    metadata = _signed_metadata(workdir, private, {"win": win_binary, "linux": linux_binary})
    _kv_put(workdir / "kv", "agent_release", metadata)

    worker = Worker(workdir).start()
    try:
        enrolled = worker.enroll("worker-e2e-platforms")
        api_key = enrolled["api_key"]
        cfg = {"update_public_key": str(public)}

        win = worker.update(api_key, "win")
        linux = worker.update(api_key, "linux")

        # Each platform sees its own hash…
        assert win["sha256"] != linux["sha256"]
        assert win["sha256"] == __import__("hashlib").sha256(
            b"WORKER-E2E-WIN-BUILD"
        ).hexdigest()
        # …and its own signature, which verifies against exactly that payload.
        assert win["signature"] and linux["signature"]
        assert win["signature"] != linux["signature"]
        assert agent_module.verify_update_signature(
            cfg, win["signature"], win["latest_version"], win["sha256"]
        )
        assert agent_module.verify_update_signature(
            cfg, linux["signature"], linux["latest_version"], linux["sha256"]
        )
        # Cross-platform confusion must fail: win's signature is not valid for linux.
        assert not agent_module.verify_update_signature(
            cfg, win["signature"], linux["latest_version"], linux["sha256"]
        )
    finally:
        worker.stop()


@requires_worker
@requires_tools
def test_no_release_published_reports_no_update(workdir):
    """Empty KV is a normal state: the agent must be told, not confused."""
    worker = Worker(workdir).start()
    try:
        enrolled = worker.enroll("worker-e2e-empty")
        payload = worker.update(enrolled["api_key"], "linux")
        assert payload["update_available"] is False
        assert payload["reason"] == "no_release_published"
    finally:
        worker.stop()


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
