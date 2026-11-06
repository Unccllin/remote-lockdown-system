#!/usr/bin/env python3
"""hw-window-preflight.py — is a hardware window ready to start, and did it produce evidence?

The D-129 hardware window has two failure modes that cost whole sessions, both of them
undetectable from inside the harness:

  *Before* the window: the target is unreachable, or the device is enrolled but not
  checking in, and the operator finds that out on the machine rather than before opening
  the laptop. AGENTS.md records the specific trap — the lab server is reachable only
  through a Windows port-proxy (`0.0.0.0:3001 → <WSL address>:3001`) that must be
  re-created after a WSL restart, and a reset connection from the lab address is what that
  looks like.

  *After* the window: the harness writes a CTRF artifact, and then someone has to write a
  `hardware_artifact_ref` string into GRAPH-SPEC.yaml by hand. I3 verifies that string
  (`artifact_supports_claim()`), so a guess is rejected — and the runbook's own §2 records
  how an artifact recording **FAIL** once got cited for a path marked `verified-on-hardware`.

So this tool answers both questions with the graph's own logic rather than a copy of it:

    python3 scripts/hw-window-preflight.py --check --server-url http://192.168.1.43:3001
    python3 scripts/hw-window-preflight.py --check --server-url ... --admin-token "$TOKEN"
    python3 scripts/hw-window-preflight.py --artifact agent/hw_test_artifact_frankenstein.json

`--artifact` mode calls `graph_assert._artifact_result_map()` and
`graph_assert.artifact_supports_claim()`, so any citation it prints is one I3 already
accepts; it prints nothing it has not verified.

Exit: 0 ready / evidence available, 1 not ready or nothing supportable, 2 usage or I/O error.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
GRAPH_DIR = REPO_ROOT / ".devin" / "graph"

# Long enough for a LAN hop, short enough that "unreachable" is a fast answer rather than a hang.
HEALTH_TIMEOUT_SECONDS = 5

PORT_PROXY_HINT = (
    "A reset or refused connection to the lab address is usually the Windows port-proxy that "
    "forwards 0.0.0.0:3001 to the WSL address: it does not survive a WSL restart and has to be "
    "re-created (see AGENTS.md, 'First production device — FRANKENSTEIN')."
)


def _load_graph_module() -> Any:
    """Import `.devin/graph/graph_assert.py` so this tool and I3 share one implementation."""
    sys.path.insert(0, str(GRAPH_DIR))
    spec = importlib.util.spec_from_file_location("graph_assert", GRAPH_DIR / "graph_assert.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit(f"cannot load {GRAPH_DIR / 'graph_assert.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_graph_loader() -> Any:
    sys.path.insert(0, str(GRAPH_DIR))
    spec = importlib.util.spec_from_file_location("graph_loader", GRAPH_DIR / "graph_loader.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise SystemExit(f"cannot load {GRAPH_DIR / 'graph_loader.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# --artifact: which paths does this run actually evidence?
# ---------------------------------------------------------------------------


def citations_for(artifact_path: Path, graph: dict, graph_assert: Any) -> list[dict]:
    """Every enforcement path this artifact can support, with the exact ref I3 accepts.

    A path is only listed when `artifact_supports_claim()` says yes, so the output cannot
    claim more than the graph will.
    """
    # The ref has to be the path `artifact_supports_claim()` will resolve — relative to the repo
    # root. Resolving first matters: a relative argument like `agent/x.json` is NOT
    # `is_relative_to(<absolute repo root>)`, so the naive check produced a bare filename and every
    # citation then "failed" because the file appeared not to exist (caught by running the tool on
    # a real artifact, not by the unit tests that came after).
    abs_path = artifact_path if artifact_path.is_absolute() else (Path.cwd() / artifact_path)
    abs_path = abs_path.resolve()
    try:
        rel = str(abs_path.relative_to(REPO_ROOT))
    except ValueError:
        rel = str(abs_path)
    supported: list[dict] = []
    for path in graph_assert.get_enforcement_paths(graph):
        path_id = path["id"]
        # Candidate test ids, most specific first. The harness names its tests `<PATH>-01`;
        # the live-agent artifact keys them by the bare path id.
        candidates = [f"{path_id}-01", path_id]
        for test_id in candidates:
            ref = f"{rel}#{test_id}"
            ok, _reason = graph_assert.artifact_supports_claim(path_id, ref, REPO_ROOT)
            if ok:
                supported.append(
                    {
                        "path_id": path_id,
                        "name": path.get("name", ""),
                        "test_id": test_id,
                        "ref": ref,
                        "current_status": path.get("status", ""),
                    }
                )
                break
    return supported


def artifact_mode(artifact_path: Path) -> int:
    graph_assert = _load_graph_module()
    graph_loader = _load_graph_loader()
    graph = graph_loader.load_graph()

    try:
        artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[FAIL] cannot read artifact {artifact_path}: {exc}", file=sys.stderr)
        return 2

    results = graph_assert._artifact_result_map(artifact)
    print(f"Artifact: {artifact_path}")
    if not results:
        print(
            "  No test results found. Readable schemas are harness v1.0 "
            "({'results': [{'test_id', 'status'}]}), harness v2.0 CTRF "
            "({'results': {'tests': [...]}}) and the live-agent form "
            "({'enforcement_paths': {ID: {...}}})."
        )
    for test_id in sorted(results):
        print(f"  {test_id:22} {results[test_id]}")

    supported = citations_for(artifact_path, graph, graph_assert)
    print()
    if not supported:
        print(
            "[FAIL] this artifact evidences no enforcement path. A passing run must include at "
            "least one of the graph's test ids (E-ENCRYPT-01, E-TRACK-01, …) at PASS; extra tests "
            "such as E-TPM or E-HWID are real coverage but are not graph nodes, so passing them "
            "moves no status."
        )
        return 1

    print("Citations I3 will accept (each verified with artifact_supports_claim):")
    for item in supported:
        marker = " (already claimed)" if item["current_status"] == "verified-on-hardware" else ""
        print(f"  {item['path_id']:16} {item['ref']}{marker}")

    print()
    print("Paste into .devin/graph/GRAPH-SPEC.yaml (status + ref, per path):")
    for item in supported:
        print(f"  - id: {item['path_id']}")
        print("    status: verified-on-hardware")
        print(f'    hardware_artifact_ref: "{item["ref"]}"')

    unchanged = [
        item["path_id"]
        for item in supported
        if item["current_status"] == "verified-on-hardware"
    ]
    if unchanged:
        print()
        print(
            "Note: these are already verified-on-hardware, so citing them again changes nothing "
            f"— {', '.join(unchanged)}. A window is only worth running for paths still at "
            "verified-in-unit-test or unverified."
        )
    return 0


# ---------------------------------------------------------------------------
# --check: can the window start at all?
# ---------------------------------------------------------------------------


ALLOWED_SCHEMES = ("http", "https")


def fetch_json(url: str, admin_token: str | None = None) -> tuple[Any, str | None]:
    """GET a URL and decode JSON. Returns (payload, error).

    The URL is an operator argument, so its scheme is audited before any request is built:
    `urllib` will happily open `file://` (and custom schemes), and "point the preflight at a
    file" is a surprising way for a readiness check to behave. Only http(s) is accepted, which
    also covers the plain-HTTP lab deployment AGENTS.md documents.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        return None, f"refusing {scheme or 'absent'} scheme — this tool only fetches http(s)"

    request = urllib.request.Request(url)
    if admin_token:
        request.add_header("Authorization", f"Bearer {admin_token}")
    try:
        with urllib.request.urlopen(request, timeout=HEALTH_TIMEOUT_SECONDS) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8")), None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code} from {url}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, f"{type(exc).__name__}: {exc}"


def _age_seconds(iso_timestamp: str | None) -> float | None:
    """Seconds since an ISO-8601 UTC timestamp; None when absent or unparsable."""
    if not iso_timestamp:
        return None
    from datetime import datetime, timezone

    raw = str(iso_timestamp).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed).total_seconds()


def check_mode(server_url: str, admin_token: str | None, hostname: str | None) -> int:
    base = server_url.rstrip("/")
    print(f"Target: {base}")
    problems: list[str] = []

    health, error = fetch_json(f"{base}/api/health")
    if error:
        print(f"  health      UNREACHABLE — {error}")
        problems.append(PORT_PROXY_HINT)
        print()
        print("[FAIL] the window cannot start: the server is not reachable from here.")
        for problem in problems:
            print(f"  → {problem}")
        return 1
    status = (health or {}).get("status", "?")
    print(f"  health      {status}")

    if not admin_token:
        print("  fleet       skipped (pass --admin-token to check the device's readiness)")
        print()
        print("[OK] reachable. Re-run with --admin-token to confirm the device is checking in.")
        return 0

    devices, error = fetch_json(f"{base}/api/devices", admin_token)
    if error:
        print(f"  fleet       UNREADABLE — {error}")
        print()
        print("[FAIL] the server is up but the device list could not be read with that token.")
        return 1

    if hostname:
        matches = [d for d in devices if d.get("hostname") == hostname]
    else:
        matches = list(devices)

    if not matches:
        print(f"  fleet       no device named {hostname!r}")
        print()
        print("[FAIL] the window cannot start: that machine is not enrolled on this server.")
        return 1

    print(f"  fleet       {len(matches)} device(s)")
    for device in matches:
        age = _age_seconds(device.get("last_checkin"))
        # Formatted rather than int()-ed: the value is a float from a datetime difference, and
        # "%.0f" cannot raise on any value that function returns.
        age_text = "never" if age is None else f"{age:.0f}s ago"
        version = device.get("agent_version") or "unknown"
        stale = device.get("agent_version_stale")
        marker = "  STALE" if stale else ""
        print(
            f"    {device.get('hostname', '?'):24} last_checkin={age_text:12} "
            f"agent_version={version}{marker}"
        )
        if age is None:
            problems.append(
                f"{device.get('hostname')} has never checked in — the agent is not running or not "
                "enrolled; the window has nothing to test."
            )
        elif age > 900:
            problems.append(
                f"{device.get('hostname')} last checked in {age:.0f}s ago — older than the "
                "maximum poll interval (300 s). Wake or restart the agent before starting."
            )
        if stale:
            problems.append(
                f"{device.get('hostname')} reports a stale agent version — the build it runs does "
                "not send one, so a post-window artifact cannot be tied to a known binary. Update "
                "the agent first (D-222/D-258)."
            )

    print()
    if problems:
        print("[FAIL] the window is not ready:")
        for problem in problems:
            print(f"  → {problem}")
        return 1
    print("[OK] the window is ready: server reachable, device checking in, known agent version.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preflight a hardware window, or produce the citations its artifact supports."
    )
    parser.add_argument("--check", action="store_true", help="is the window ready to start?")
    parser.add_argument("--server-url", help="server base URL for --check, e.g. http://192.168.1.43:3001")
    parser.add_argument("--admin-token", help="admin JWT/ADMIN_TOKEN, to read the fleet state")
    parser.add_argument("--hostname", help="only check this device (default: every device)")
    parser.add_argument("--artifact", type=Path, help="harness artifact to translate into citations")
    args = parser.parse_args()

    if args.artifact and args.check:
        parser.error("choose --check or --artifact, not both")
    if args.artifact:
        return artifact_mode(args.artifact)
    if args.check:
        if not args.server_url:
            parser.error("--check needs --server-url")
        return check_mode(args.server_url, args.admin_token, args.hostname)
    parser.error("nothing to do: pass --check --server-url … or --artifact <file>")


if __name__ == "__main__":
    sys.exit(main())
