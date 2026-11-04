#!/usr/bin/env python3
"""Cross-surface contract: the UI, the server, and the Worker must agree.

Why this exists
---------------
Four consecutive sessions found the same class of defect, each invisible to the
suite that "owned" the piece:

  S204  the dashboard called `/api/v1/...` (a base-URL bug) → 404 for the user.
  S205  the Worker implemented `/api/enroll{,/token,/claim}`; Express had none, so
        token enrolment 404'd on self-hosted deployments.
  S206  the server had a finished integration surface that the UI never referenced,
        so a shipped backend was invisible.
  S207  `/api/rearm` and `/api/agent/efs-cert` are Worker-only capabilities that
        Express lacks entirely (found by this audit while writing it).

Every one of those was a *contract between two surfaces*, and no single surface's
tests can see it. So this test reads all three sources and compares them:

  1. **UI → server.** Every `/api/...` call in `dashboard/src` must resolve to an
     Express route (method + path). The receiver decides the base: `api` talks to
     `/api`, `pblApi` to the server root (`/v1/*`) — getting that wrong is exactly
     what broke the Signing Keys panel.

  2. **Worker → Express.** Every `/api/...` route the Worker dispatches must exist
     in Express, or be listed below with a reason. Two lists, because the two
     reasons are different kinds of fact:
       - `WORKER_ONLY_BY_DESIGN` — a delivery mechanism or a legacy alias.
       - `KNOWN_GAPS` — a real capability Express does not have. This list is a
         shrink-only baseline: if a gap is closed, the test FAILS until the entry
         is removed, so the list cannot quietly rot.

  3. **The parsers themselves.** Anchors are asserted first (routes that certainly
     exist). A silent parse failure would otherwise turn this into a test that
     passes while checking nothing — which nearly happened twice while writing it
     (double-slash path composition, and a receiver-blind base URL).

Run:
    scripts/test_cross_surface_contract.py        # or `make test-scripts`
"""

from __future__ import annotations

import importlib
import re
from pathlib import Path
from typing import Any

# pytest lives in agent/.venv (see scripts/script_test_runner.py).
pytest: Any = importlib.import_module("pytest")

REPO = Path(__file__).resolve().parent.parent
INDEX = REPO / "server/src/index.js"
ROUTES_DIR = REPO / "server/src/routes"
DASHBOARD = REPO / "dashboard/src"
WORKER = REPO / "serverless/worker.ts"

# Routes the parser must find. If one disappears, the parse is wrong (or a route
# was deleted) — either way this file must not silently check nothing.
ANCHORS = [
    ("POST", "/api/auth/login"),
    ("POST", "/api/enroll/token"),
    ("POST", "/api/enroll/claim"),
    ("GET", "/api/integrations"),
    ("GET", "/api/devices"),
    ("GET", "/api/health"),
    ("GET", "/v1/policy"),
]

# Worker-only by design: a delivery mechanism that only exists serverless, or a
# legacy path kept for agents already in the field.
WORKER_ONLY_BY_DESIGN = {
    ("GET", "/api/download/agent"): "KV-backed binary delivery; Express serves per-device installers under /api/installer",
    ("GET", "/api/download/agent-installer"): "KV-backed binary delivery (installer wrapper)",
    ("GET", "/api/download/installer"): "KV-backed binary delivery (NSIS setup)",
    ("GET", "/api/download/lockscreen"): "KV-backed binary delivery",
    ("GET", "/api/download/deploy.ps1"): "KV-backed script delivery",
    ("GET", "/api/download/quick.ps1"): "KV-backed script delivery",
    ("GET", "/api/download/reenroll.ps1"): "KV-backed script delivery",
    ("POST", "/api/ping"): "legacy alias of POST /api/agent/checkin",
    ("POST", "/api/command-ack"): "legacy alias of POST /api/agent/command-ack",
}

# Real capabilities Express does not have. Shrink-only: closing one must fail this
# test until the entry is deleted (the same discipline as the graph's
# orphaned-commit-refs baseline).
KNOWN_GAPS = {
    ("POST", "/api/rearm"): "hardware-UUID-bound re-arm for PblPersistDxe; Express has no rearm route",
    ("POST", "/api/agent/efs-cert"): "agent-side EFS certificate upload; Express has no efs-cert route",
    ("POST", "/api/enroll"): "admin enrolment by path; Express enrols via POST /api/devices + /api/enroll/{token,claim}",
}


# ---------------------------------------------------------------------------
# Parsers (validated by the anchors test below)
# ---------------------------------------------------------------------------


def normalise(path: str) -> str:
    """One canonical form: no query, no trailing slash, `:param`, single slashes."""
    path = re.sub(r"\$\{[^}]*\}", ":x", path).split("?")[0].rstrip("/")
    path = re.sub(r":\w+", ":x", path)
    return re.sub(r"/{2,}", "/", path) or "/"


def express_routes() -> set[tuple[str, str]]:
    """The Express route table, from the mounts and the routers they mount."""
    source = INDEX.read_text()
    requires = dict(re.findall(r"const (\w+)\s*=\s*require\('\./routes/([\w-]+)'\)", source))

    mounts = re.findall(r"mountApi\('(/api/[^']+)'[^)]*?(\w+)\)", source)
    # /v1 is mounted with an inline middleware in front of the router.
    mounts += re.findall(r"app\.use\('(/v1)'[\s\S]{0,400}?(\w+)\.router\)", source)

    table: set[tuple[str, str]] = set()
    for prefix, var in mounts:
        assert var in requires, f"mount {prefix} -> {var} is not a required router"
        router_file = ROUTES_DIR / f"{requires[var]}.js"
        assert router_file.is_file(), f"mount {prefix} -> {router_file} missing"
        for match in re.finditer(
            r"router\.(get|post|patch|put|delete|all)\(\s*'([^']*)'", router_file.read_text()
        ):
            table.add((match.group(1).upper(), normalise(prefix + "/" + match.group(2))))
    return table


def ui_calls() -> set[tuple[str, str]]:
    """Every API call in the dashboard, with the correct base per receiver."""
    calls: set[tuple[str, str]] = set()
    for file in DASHBOARD.rglob("*"):
        if file.suffix not in (".js", ".jsx") or not file.is_file():
            continue
        for match in re.finditer(
            r"(\w+)\.(get|post|patch|put|delete)\(\s*[`'\"]([^'\"`]+)", file.read_text()
        ):
            receiver, method, path = match.group(1), match.group(2).upper(), match.group(3)
            if not path.startswith("/"):
                continue
            if receiver == "pblApi":
                # The PBL API lives at the server root, not under /api.
                calls.add((method, normalise(path)))
            elif receiver == "api":
                calls.add((method, normalise("/api" + path)))
    return calls


def worker_routes() -> set[tuple[str, str]]:
    """Every /api route the Worker dispatches."""
    return {
        (match.group(2), normalise(match.group(1)))
        for match in re.finditer(
            r"path === '(/api/[^']+)' && method === '(\w+)'", WORKER.read_text()
        )
    }


def resolves(table: set[tuple[str, str]], method: str, path: str) -> bool:
    return any(p == path and m in (method, "ALL") for m, p in table)


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


def test_the_parsers_see_the_routes_that_certainly_exist():
    """Guard first: a silent parse failure would make every check below vacuous."""
    table = express_routes()

    assert len(table) > 60, f"only {len(table)} Express routes parsed — parser out of date"
    missing = [anchor for anchor in ANCHORS if anchor not in table]
    assert missing == [], f"anchors not found (parser broken): {missing}"


def test_every_dashboard_call_resolves_to_an_express_route():
    table = express_routes()
    unresolved = sorted(
        f"{method} {path}" for method, path in ui_calls() if not resolves(table, method, path)
    )

    assert unresolved == [], (
        "the dashboard calls routes the server does not serve — this is the S204 "
        "class (a 404 the user sees and no unit test does):\n  " + "\n  ".join(unresolved)
    )


def test_every_worker_api_route_exists_in_express_or_is_documented():
    table = express_routes()
    unexplained = []
    for method, path in sorted(worker_routes()):
        if resolves(table, method, path):
            continue
        if (method, path) in WORKER_ONLY_BY_DESIGN or (method, path) in KNOWN_GAPS:
            continue
        unexplained.append(f"{method} {path}")

    assert unexplained == [], (
        "Worker routes with no Express counterpart and no recorded reason (the S205 "
        "class — a serverless-only capability nobody noticed was missing):\n  "
        + "\n  ".join(unexplained)
    )


def test_a_closed_gap_must_be_removed_from_the_baseline():
    """KNOWN_GAPS is shrink-only: fixing one should fail until its entry is deleted."""
    table = express_routes()

    closed = [
        f"{method} {path}" for (method, path) in KNOWN_GAPS if resolves(table, method, path)
    ]
    assert closed == [], (
        "these were recorded as gaps but Express now serves them — delete the "
        "entry so the baseline keeps shrinking:\n  " + "\n  ".join(closed)
    )


def test_the_two_allow_lists_do_not_overlap():
    overlap = set(WORKER_ONLY_BY_DESIGN) & set(KNOWN_GAPS)
    assert overlap == set(), f"listed as both by-design and a gap: {sorted(overlap)}"


def test_by_design_entries_are_still_absent_from_express():
    """If Express gains one, it is ordinary parity now and the entry is noise."""
    table = express_routes()
    present = [
        f"{method} {path}"
        for (method, path) in WORKER_ONLY_BY_DESIGN
        if resolves(table, method, path)
    ]
    assert present == [], (
        "Express now serves these, so they are no longer Worker-only:\n  " + "\n  ".join(present)
    )


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
