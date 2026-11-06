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
    # No Express route exists at all.
    ("POST", "/api/ping"): "legacy alias of POST /api/agent/checkin",
    ("POST", "/api/command-ack"): "legacy alias of POST /api/agent/command-ack",
}

# Routed by Express but not produced there: /api/download/:name serves the four
# binaries and answers 404 with guidance for anything else. The Worker *generates*
# these three scripts from KV; Express has no generator, so the path is routed and
# deliberately unsupported rather than missing.
ROUTED_NOT_PRODUCED = {
    ("GET", "/api/download/deploy.ps1"): "Worker generates this script; Express routes /api/download/:name and answers 404 with guidance",
    ("GET", "/api/download/quick.ps1"): "Worker generates this script; Express routes /api/download/:name and answers 404 with guidance",
    ("GET", "/api/download/reenroll.ps1"): "Worker generates this script; Express routes /api/download/:name and answers 404 with guidance",
}

# Real capabilities Express does not have. Shrink-only: closing one must fail this
# test until the entry is deleted (the same discipline as the graph's
# orphaned-commit-refs baseline).
KNOWN_GAPS = {
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
    """Does an Express route cover this method+path, treating `:x` as one segment?

    Segment-wise matching matters: `/api/download/:name` is how a router serves
    `/api/download/agent`, and an exact-string comparison would call that missing
    (which is exactly what happened when the downloads router was added).
    """
    target = [seg for seg in path.strip("/").split("/") if seg != ""]
    for route_method, route_path in table:
        if route_method not in (method, "ALL"):
            continue
        route_segs = [seg for seg in route_path.strip("/").split("/") if seg != ""]
        if len(route_segs) != len(target):
            continue
        # strict=True: the length guard above already ensures equal sizes, and
        # asserting it here means a future edit that drops the guard fails loudly
        # instead of silently comparing only the shared prefix.
        if all(rs == ts or rs == ":x" for rs, ts in zip(route_segs, target, strict=True)):
            return True
    return False


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
        if (
            (method, path) in WORKER_ONLY_BY_DESIGN
            or (method, path) in ROUTED_NOT_PRODUCED
            or (method, path) in KNOWN_GAPS
        ):
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


def test_routed_not_produced_entries_are_actually_routed():
    """The middle category means "reached, deliberately 404", not "missing"."""
    table = express_routes()
    unrouted = [
        f"{method} {path}"
        for (method, path) in ROUTED_NOT_PRODUCED
        if not resolves(table, method, path)
    ]
    assert unrouted == [], (
        "recorded as routed-but-not-produced, but no Express route reaches them "
        "(move them to WORKER_ONLY_BY_DESIGN):\n  " + "\n  ".join(unrouted)
    )


def test_the_three_lists_do_not_overlap():
    sets = {
        "by design": set(WORKER_ONLY_BY_DESIGN),
        "routed not produced": set(ROUTED_NOT_PRODUCED),
        "known gaps": set(KNOWN_GAPS),
    }
    overlaps = [
        f"{name} ∩ {other}: {sorted(entries & other_entries)}"
        for name, entries in sets.items()
        for other, other_entries in sets.items()
        if name < other and entries & other_entries
    ]
    assert overlaps == [], "an entry belongs to two lists: " + "; ".join(overlaps)


# ---------------------------------------------------------------------------
# D-221: the uninstall-token derivation is a contract between two surfaces
# ---------------------------------------------------------------------------
# The route-path checks above cannot see this class of defect. Express issued
# `HMAC(ADMIN_TOKEN, window)` while the Worker issued `SHA256("window:ADMIN_TOKEN")`, so a token
# from one surface never verified on the other — and each suite tested only its own surface, so
# both stayed green. The vectors file is now the single statement of the scheme, and this test
# recomputes it from first principles: a vector that is wrong cannot go on to "pin" two wrong
# implementations.

VECTORS = REPO / "docs" / "adr" / "D-221-token-vectors.json"


def test_the_shared_vectors_match_their_own_statement():
    import hashlib
    import hmac
    import json

    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    secret = data["secret"]

    def bound(device_id: str, window: int) -> str:
        return hmac.new(
            secret.encode(), f"{device_id}:{window}".encode(), hashlib.sha256
        ).hexdigest()

    wrong = [
        entry for entry in data["bound"] if bound(entry["device_id"], entry["window"]) != entry["token"]
    ]
    assert wrong == [], f"bound vectors disagree with the documented scheme: {wrong}"

    wrong_express = [
        entry
        for entry in data["legacy_express"]
        if hmac.new(secret.encode(), str(entry["window"]).encode(), hashlib.sha256).hexdigest()
        != entry["token"]
    ]
    assert wrong_express == [], f"legacy_express vectors are wrong: {wrong_express}"

    wrong_worker = [
        entry
        for entry in data["legacy_worker"]
        if hashlib.sha256(f"{entry['window']}:{secret}".encode()).hexdigest() != entry["token"]
    ]
    assert wrong_worker == [], f"legacy_worker vectors are wrong: {wrong_worker}"


def test_the_vectors_actually_differ_between_the_two_legacy_schemes():
    """The divergence D-221 records must stay visible in the vectors.

    If someone "fixes" the file by making both legacy lists identical, the migration test on
    each surface would stop proving anything.
    """
    import json

    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    express_tokens = {entry["token"] for entry in data["legacy_express"]}
    worker_tokens = {entry["token"] for entry in data["legacy_worker"]}
    assert express_tokens & worker_tokens == set(), (
        "the two legacy derivations are supposed to differ; identical vectors mean the file no "
        "longer describes what each surface used to issue"
    )


def test_the_legacy_scheme_has_not_passed_its_sunset():
    """The Q2-A migration window must end on its own, without anyone remembering.

    A tag-driven repo has no "next release" that code can observe, so the end of the window is a
    date in the vectors file (with the rationale that set it). On or after that date this test
    fails and says exactly what to delete — which is the whole point: the deprecation was
    otherwise a log line nobody reads.
    """
    import datetime
    import json

    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    sunset = datetime.date.fromisoformat(data["legacy_sunset"])
    today = datetime.datetime.now(datetime.timezone.utc).date()

    assert today < sunset, (
        f"the legacy uninstall-token scheme reached its sunset on {sunset.isoformat()} "
        f"(today is {today.isoformat()}). It is still accepted by both surfaces, which means a "
        "token with no device binding still verifies. Delete it:\n"
        "  1. server/src/routes/agent.js  — legacyUninstallToken() and its verify branch\n"
        "  2. serverless/worker.ts        — legacyUninstallToken() and its verify branch\n"
        "  3. the deprecated_scheme marker on both surfaces (+ the two legacy tests)\n"
        "  4. empty legacy_express / legacy_worker in docs/adr/D-221-token-vectors.json, and move "
        "the fact that the two schemes differed into the D-221 ledger entry, where it belongs as "
        "history\n"
        "Then delete this test and the two suite-level sunset cases."
    )


def test_the_sunset_window_is_not_open_ended():
    """Guards the guard: a sunset set far enough out is the same as no sunset.

    Without this, editing one field to 2099 passes every check above while leaving the weak scheme
    alive indefinitely.
    """
    import datetime
    import json

    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    closed_at = datetime.date.fromisoformat(data["d221_closed_at"])
    sunset = datetime.date.fromisoformat(data["legacy_sunset"])
    window_days = (sunset - closed_at).days

    assert sunset > closed_at, "the sunset must be after the close it starts from"
    assert window_days <= 180, (
        f"the migration window is {window_days} days; the ruling asked for one release and the "
        "vectors file records 90 days. A window this long is a decision to keep the weak scheme, "
        "and it belongs in a ruling rather than in a date field"
    )


def test_the_sunset_is_recorded_in_a_parseable_form():
    import datetime
    import json

    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert "legacy_sunset" in data, "no sunset recorded — the deprecation has no end"
    # Raises if it is not an ISO date; a free-text field would defeat the two checks above.
    datetime.date.fromisoformat(data["legacy_sunset"])
    assert data.get("legacy_sunset_reason"), "the sunset must say where it came from"


def test_both_suites_read_the_vectors():
    """A suite that stops reading the file silently drops out of the cross-surface pin."""
    missing = [
        str(path.relative_to(REPO))
        for path in (REPO / "server/tests/uninstallAuth.test.js", REPO / "serverless/worker.test.ts")
        if "D-221-token-vectors.json" not in path.read_text(encoding="utf-8")
    ]
    assert missing == [], (
        "these suites no longer read docs/adr/D-221-token-vectors.json, so their surface is "
        "unpinned: " + ", ".join(missing)
    )


if __name__ == "__main__":
    from script_test_runner import run

    raise SystemExit(run(__file__))
