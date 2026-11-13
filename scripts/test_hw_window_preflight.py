"""Tests for scripts/hw-window-preflight.py.

The tool exists because a hardware window fails at its edges: the target is unreachable and
nobody checks until the machine is open, and — after the run — the citation string is written by
hand and rejected by I3, or worse, *accepted* while the artifact records FAIL (runbook §2). Both
edges are testable offline, so neither should need a hardware window to discover.

What is pinned here:
  * `--artifact` cites only paths whose own test id records PASS, in all three artifact schemas
    this repo has produced, and never cites a path whose test SKIPped;
  * the exit code distinguishes "produced evidence" (0) from "produced nothing usable" (1) from
    "unreadable input" (2), because a printed table nobody reads is not a gate;
  * `--check` refuses a non-http scheme before opening anything, and reports an unreachable target
    with the port-proxy hint rather than a bare traceback.
"""

import importlib
import importlib.util
import json
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

# pytest lives in agent/.venv, not on this interpreter's path, so a top-level import is
# unresolvable to a static analyser (same reason scripts/test_cross_surface_contract.py does this).
pytest: Any = importlib.import_module("pytest")

SCRIPT = Path(__file__).resolve().parent / "hw-window-preflight.py"
REPO_ROOT = SCRIPT.parent.parent

# User-Agents the local test server actually received. Module-level rather than a class attribute so
# the handler keeps no mutable class state; the fixture clears it between tests.
RECORDED_USER_AGENTS: list[str] = []


def load_module():
    spec = importlib.util.spec_from_file_location("hw_window_preflight", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = load_module()


def ctrf(*tests) -> dict:
    """A harness v2.0 CTRF artifact: {'results': {'tests': [{'name', 'status'}]}}."""
    return {"results": {"tests": [{"name": name, "status": status} for name, status in tests]}}


def write_artifact(tmp_path: Path, payload: dict, name: str = "artifact.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def run_main(argv) -> int:
    """Run the CLI with argv, returning its exit code instead of raising SystemExit."""
    import sys

    saved = sys.argv
    sys.argv = ["hw-window-preflight.py", *argv]
    try:
        return mod.main()
    finally:
        sys.argv = saved


def ready_device(**overrides) -> dict:
    """A device record that passes every precondition, so a test can fail exactly one of them."""
    payload = {
        "id": "d3",
        "hostname": "FRANKENSTEIN",
        "status": "active",
        # Fresh, so the check-in age is never the reason a test fails.
        "last_checkin": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "agent_version": "1.0.0",
        "agent_version_stale": False,
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# --artifact: citations must be the ones I3 accepts
# ---------------------------------------------------------------------------


class TestArtifactCitations:
    def test_cites_a_path_whose_test_passed(self, tmp_path, capsys):
        artifact = write_artifact(tmp_path, ctrf(("E-TRACK-01", "PASS"), ("E-ACK-01", "PASS")))
        code = run_main(["--artifact", str(artifact)])
        out = capsys.readouterr().out

        assert code == 0, out
        assert "E-TRACK" in out and "E-ACK" in out
        # The paste-ready pair is the point of the mode.
        assert 'hardware_artifact_ref: "' in out
        assert "#E-TRACK-01" in out

    def test_never_cites_a_path_that_skipped(self, tmp_path, capsys):
        # A SKIP is real information and must not become a hardware claim.
        artifact = write_artifact(tmp_path, ctrf(("E-HP-UEFI-01", "SKIP"), ("E-TRACK-01", "PASS")))
        code = run_main(["--artifact", str(artifact)])
        out = capsys.readouterr().out

        assert code == 0
        citations = [line for line in out.splitlines() if "#E-HP-UEFI" in line]
        assert citations == [], out

    def test_a_passing_run_with_no_graph_test_fails_the_gate(self, tmp_path, capsys):
        # E-TPM / E-HWID / E-ENROLL are real coverage but not graph nodes; passing them moves no
        # status, and the tool must say so rather than print an encouraging table.
        artifact = write_artifact(tmp_path, ctrf(("E-TPM-01", "PASS"), ("E-HWID-01", "PASS")))
        code = run_main(["--artifact", str(artifact)])
        out = capsys.readouterr().out

        assert code == 1, out
        assert "evidences no enforcement path" in out

    def test_all_fail_artifact_fails_the_gate(self, tmp_path, capsys):
        artifact = write_artifact(tmp_path, ctrf(("E-TRACK-01", "FAIL"), ("E-ACK-01", "FAIL")))
        code = run_main(["--artifact", str(artifact)])
        assert code == 1
        assert "evidences no enforcement path" in capsys.readouterr().out

    def test_reads_the_legacy_v1_schema(self, tmp_path, capsys):
        artifact = write_artifact(
            tmp_path,
            {"results": [{"test_id": "E-RECOVERY-01", "status": "PASS"}]},
            name="legacy.json",
        )
        code = run_main(["--artifact", str(artifact)])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "E-RECOVERY" in out

    def test_reads_the_live_agent_schema(self, tmp_path, capsys):
        artifact = write_artifact(
            tmp_path,
            {"enforcement_paths": {"E-DEADMAN": {"status": "PASS"}}},
            name="live.json",
        )
        code = run_main(["--artifact", str(artifact)])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "E-DEADMAN" in out

    def test_unreadable_artifact_is_a_usage_error(self, tmp_path, capsys):
        bad = tmp_path / "broken.json"
        bad.write_text("{not json", encoding="utf-8")
        code = run_main(["--artifact", str(bad)])
        assert code == 2
        assert "cannot read artifact" in capsys.readouterr().err

    def test_a_relative_argument_still_resolves(self, tmp_path, capsys):
        """The ref must be the path I3 resolves, i.e. repo-relative.

        This was a real bug: a relative argument is not `is_relative_to(<absolute repo root>)`,
        so the naive check reduced it to a bare filename, `artifact_supports_claim` could not
        find that file, and every citation silently "failed" — the tool reported "no enforcement
        path" for an artifact with three PASSes.
        """
        repo_artifact = REPO_ROOT / "agent" / "hw_test_artifact_azure_bitlocker.json"
        assert repo_artifact.exists(), "fixture artifact missing from the repo"
        code = run_main(["--artifact", "agent/hw_test_artifact_azure_bitlocker.json"])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "agent/hw_test_artifact_azure_bitlocker.json#E-ENCRYPT-01" in out


# ---------------------------------------------------------------------------
# --check: refuse what cannot work, and name the next action
# ---------------------------------------------------------------------------


class TestCheckMode:
    def test_refuses_a_non_http_scheme(self, capsys):
        code = run_main(["--check", "--server-url", "file:///etc/passwd"])
        out = capsys.readouterr().out
        assert code == 1
        assert "refusing file scheme" in out

    def test_unreachable_target_names_the_port_proxy(self, capsys):
        # Port 1 is not a service; the important part is the hint, not the error text.
        code = run_main(["--check", "--server-url", "http://127.0.0.1:1"])
        out = capsys.readouterr().out
        assert code == 1
        assert "UNREACHABLE" in out
        assert "port-proxy" in out

    def test_requires_a_server_url(self):
        with pytest.raises(SystemExit) as excinfo:
            run_main(["--check"])
        assert excinfo.value.code == 2

    def test_ready_when_the_server_answers(self, live_server, capsys):
        code = run_main(["--check", "--server-url", live_server])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "[OK] reachable" in out

    def test_sends_a_user_agent_cloudflare_accepts(self, live_server, capsys):
        """Pins the 403/1010 defect: urllib's default signature is banned by Cloudflare.

        The serverless deployment answers `Python-urllib/<ver>` with HTTP 403 + error code 1010, so
        --check called the Worker UNREACHABLE and printed the Windows port-proxy hint — a wrong
        diagnosis for a target where no port-proxy exists. Asserted on the header the local server
        actually received, because the failure mode is invisible in our own source.
        """
        RECORDED_USER_AGENTS.clear()
        code = run_main(["--check", "--server-url", live_server])
        capsys.readouterr()
        assert code == 0
        assert RECORDED_USER_AGENTS, "the check made no request at all"
        for sent in RECORDED_USER_AGENTS:
            assert not sent.startswith("Python-urllib"), f"default urllib UA would 403 → {sent!r}"
            assert sent == mod.USER_AGENT

    def test_reports_a_device_that_never_checked_in(self, live_server_with_devices, capsys):
        code = run_main(
            ["--check", "--server-url", live_server_with_devices, "--admin-token", "tkn"]
        )
        out = capsys.readouterr().out
        assert code == 1
        assert "never checked in" in out

    def test_reports_a_stale_agent_version(self, live_server_with_devices, capsys):
        code = run_main(
            [
                "--check",
                "--server-url",
                live_server_with_devices,
                "--admin-token",
                "tkn",
                "--hostname",
                "STALE-01",
            ]
        )
        out = capsys.readouterr().out
        assert code == 1
        assert "stale agent version" in out

    def test_ready_device_must_be_active(self, live_server, set_devices, capsys):
        """Everything the preflight measured has to be green for the window to open."""
        set_devices([ready_device(status="active")])
        code = run_main(["--check", "--server-url", live_server, "--admin-token", "tkn"])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "status=active" in out
        assert "the window is ready" in out

    def test_refuses_a_device_in_tracking_mode(self, live_server, set_devices, capsys):
        """The S268 lockout, pinned: covert tracking disables the operator's own account.

        In tracking mode the agent disables the real Windows account, creates the `GuestUser`
        decoy and EFS-encrypts that profile. S268 opened the machine in that state and lost
        access to it, while this check called the machine ready — it only measured health,
        freshness and version. The remedy has to be named, because the operator cannot look it up
        from the login screen they can no longer get past.
        """
        set_devices([ready_device(status="tracking")])
        code = run_main(["--check", "--server-url", live_server, "--admin-token", "tkn"])
        out = capsys.readouterr().out
        assert code == 1, out
        assert "status=tracking" in out
        assert "locks the operator out" in out
        assert "stop-track" in out

    def test_refuses_a_locked_device(self, live_server, set_devices, capsys):
        set_devices([ready_device(status="locked")])
        code = run_main(["--check", "--server-url", live_server, "--admin-token", "tkn"])
        out = capsys.readouterr().out
        assert code == 1, out
        assert "locked mode" in out

    def test_a_server_that_omits_status_is_not_a_failure(self, live_server, set_devices, capsys):
        """Absent is not dangerous: only a reported non-active mode blocks the window."""
        device = ready_device()
        del device["status"]
        set_devices([device])
        code = run_main(["--check", "--server-url", live_server, "--admin-token", "tkn"])
        out = capsys.readouterr().out
        assert code == 0, out
        assert "status=unknown" in out


# ---------------------------------------------------------------------------
# A tiny local server, so --check is exercised for real rather than mocked
# ---------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    devices = [
        {
            "id": "d1",
            "hostname": "NEVER-01",
            "last_checkin": None,
            "agent_version": None,
            "agent_version_stale": False,
        },
        {
            "id": "d2",
            "hostname": "STALE-01",
            "last_checkin": "2026-11-05T12:00:00Z",
            "agent_version": "1.0.0",
            "agent_version_stale": True,
        },
    ]

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        # Recorded so a test can assert the tool's own User-Agent rather than trusting the source:
        # the header is invisible on the wire unless a server writes it down (Cloudflare's 1010
        # shows why). Module-level list, so the handler keeps no mutable class state.
        RECORDED_USER_AGENTS.append(self.headers.get("User-Agent", ""))
        if self.path.startswith("/api/health"):
            body = json.dumps({"status": "ok"}).encode()
        elif self.path.startswith("/api/devices"):
            body = json.dumps(self.devices).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - matches BaseHTTPRequestHandler's signature
        """Silence the server's per-request logging in test output."""
        return


@pytest.fixture()
def live_server():
    RECORDED_USER_AGENTS.clear()
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    thread.join(timeout=2)


@pytest.fixture()
def live_server_with_devices(live_server):
    return live_server


@pytest.fixture()
def set_devices():
    """Swap the local server's device list for one test, then restore the shared fixture list."""
    saved = _Handler.devices

    def apply(devices: list[dict]) -> None:
        _Handler.devices = devices

    yield apply
    _Handler.devices = saved


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
