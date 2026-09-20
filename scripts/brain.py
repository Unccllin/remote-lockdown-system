#!/usr/bin/env python3
"""
Brain — Evidence-Tagged Belief Layer

File-based belief store for AI agents. Every claim the system holds is an
atomic record with an evidence level and provenance. Knowledge evolves:
verification promotes beliefs, refutation kills them (but keeps the record),
staleness decays them.

Stages:
  init       — Create .devin/brain/ store
  assert     — Add a proposed belief (status: proposed)
  confirm    — Mark a belief confirmed (requires evidence + provenance)
  refute     — Mark a belief refuted, record the correction, flag dependents
  retrieve   — Search beliefs by keyword; returns status + evidence tags
  list       — List beliefs (filterable by status/domain)
  gen-view   — Regenerate .devin/brain/BELIEFS.md (GENERATED — do not edit)
  stale      — Report beliefs whose provenance files changed since last_verified
  check      — Validate store integrity (confirmed ⇒ evidence + provenance)

Evidence ladder (ordinal strength):
  assumed < code-read < spec-checked < emulated < real-media < hardware

A belief may never be cited at a level above its evidence. "Emulated" is not
"hardware-verified". Sessions must not claim a higher rung than the record.

Usage:
  python3 scripts/brain.py <command> [options]
"""

import argparse
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    raise ImportError("PyYAML is required by brain.py. Install with: pip install pyyaml")

# ─── Constants ───────────────────────────────────────────────────────────────

BRAIN_DIR = Path(__file__).resolve().parent.parent / ".devin" / "brain"
STORE_FILE = BRAIN_DIR / "beliefs.yaml"
VIEW_FILE = BRAIN_DIR / "BELIEFS.md"
REPO_ROOT = Path(__file__).resolve().parent.parent

EVIDENCE_LEVELS = ["assumed", "code-read", "spec-checked", "emulated", "real-media", "hardware"]
STATUSES = ["proposed", "confirmed", "refuted", "decayed"]
RETRIEVE_DEFAULT_N = 8


# ─── Utilities ───────────────────────────────────────────────────────────────

def atomic_write(path: Path, content: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    tmp.rename(path)


def now_iso():
    return datetime.now().strftime("%Y-%m-%d")


def load_store() -> dict:
    if not STORE_FILE.exists():
        return {"beliefs": []}
    with open(STORE_FILE) as f:
        data = yaml.safe_load(f)
    if not data or "beliefs" not in data:
        return {"beliefs": []}
    return data


def save_store(data: dict) -> None:
    BRAIN_DIR.mkdir(parents=True, exist_ok=True)
    header = (
        "# beliefs.yaml — evidence-tagged belief store\n"
        "# Managed by scripts/brain.py. Edit via CLI commands, not by hand.\n"
        "# statuses: proposed | confirmed | refuted | decayed\n"
        "# evidence: assumed < code-read < spec-checked < emulated < real-media < hardware\n\n"
    )
    atomic_write(STORE_FILE, header + yaml.dump(data, default_flow_style=False,
                                                 sort_keys=False, allow_unicode=True,
                                                 width=100))


def gen_belief_id(store: dict) -> str:
    max_num = 0
    for b in store["beliefs"]:
        m = re.match(r"B-(\d+)", str(b.get("id", "")))
        if m:
            max_num = max(max_num, int(m.group(1)))
    return f"B-{max_num + 1:03d}"


def find_belief(store: dict, belief_id: str) -> dict | None:
    for b in store["beliefs"]:
        if b.get("id") == belief_id:
            return b
    return None


def evidence_rank(level: str) -> int:
    try:
        return EVIDENCE_LEVELS.index(level)
    except ValueError:
        return -1


def keyword_score(query: str, text: str) -> float:
    query_words = set(re.findall(r"\w+", query.lower()))
    text_words = set(re.findall(r"\w+", text.lower()))
    if not query_words or not text_words:
        return 0.0
    return len(query_words & text_words) / len(query_words)


def belief_text(b: dict) -> str:
    return " ".join(str(b.get(k, "")) for k in
                    ("statement", "domain", "notes", "source", "provenance"))


# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_init(args):
    BRAIN_DIR.mkdir(parents=True, exist_ok=True)
    if STORE_FILE.exists():
        print(f"[INFO] Store already exists: {STORE_FILE}")
    else:
        save_store({"beliefs": []})
        print(f"[OK] Initialized belief store: {STORE_FILE}")
    print(f"     View will be generated at: {VIEW_FILE}")


def cmd_assert(args):
    store = load_store()
    belief = {
        "id": gen_belief_id(store),
        "statement": args.statement,
        "domain": args.domain or "general",
        "status": "proposed",
        "evidence_level": "assumed",
        "provenance": args.provenance or "",
        "source": args.source or "",
        "asserted": now_iso(),
        "last_verified": None,
        "commit_ref": None,
        "supersedes": None,
        "superseded_by": None,
        "dependents": [],
        "notes": args.notes or "",
    }
    store["beliefs"].append(belief)
    save_store(store)
    print(f"[OK] Asserted {belief['id']} (proposed/assumed): {args.statement[:70]}")


def cmd_confirm(args):
    store = load_store()
    b = find_belief(store, args.id)
    if not b:
        print(f"[ERROR] Belief {args.id} not found")
        sys.exit(1)
    if args.evidence_level not in EVIDENCE_LEVELS[1:]:
        print(f"[ERROR] confirm requires --evidence-level one of: {', '.join(EVIDENCE_LEVELS[1:])}")
        print("        ('assumed' is not confirmation — evidence is required)")
        sys.exit(1)
    if not args.provenance:
        print("[ERROR] confirm requires --provenance (file:line, spec cite, or artifact path)")
        sys.exit(1)
    b["status"] = "confirmed"
    b["evidence_level"] = args.evidence_level
    b["provenance"] = args.provenance
    b["last_verified"] = now_iso()
    b["commit_ref"] = args.commit
    save_store(store)
    print(f"[OK] Confirmed {args.id} at level '{args.evidence_level}': {b['statement'][:60]}")


def cmd_refute(args):
    store = load_store()
    b = find_belief(store, args.id)
    if not b:
        print(f"[ERROR] Belief {args.id} not found")
        sys.exit(1)
    if not args.replacement:
        print("[ERROR] refute requires --replacement — a killed belief must be replaced")
        print("        with what is actually true. Refutation without correction loses")
        print("        the knowledge of *why* it was wrong.")
        sys.exit(1)

    b["status"] = "refuted"
    b["refuted_on"] = now_iso()
    b["refute_evidence"] = args.evidence or ""

    # Create the replacement belief
    replacement = {
        "id": gen_belief_id(store),
        "statement": args.replacement,
        "domain": b.get("domain", "general"),
        "status": "proposed",
        "evidence_level": "assumed",
        "provenance": args.evidence or "",
        "source": f"refutes {args.id}",
        "asserted": now_iso(),
        "last_verified": None,
        "commit_ref": None,
        "supersedes": args.id,
        "superseded_by": None,
        "dependents": [],
        "notes": "",
    }
    b["superseded_by"] = replacement["id"]
    store["beliefs"].append(replacement)

    # Flag dependents — beliefs that relied on the refuted one
    flagged = [d for d in b.get("dependents", []) if find_belief(store, d)]
    for dep_id in flagged:
        dep = find_belief(store, dep_id)
        dep.setdefault("notes", "")
        dep["notes"] = (dep["notes"] + f" [STALE: depended on refuted {args.id}]").strip()
        if dep["status"] == "confirmed":
            dep["status"] = "proposed"  # demoted pending re-verification

    save_store(store)
    print(f"[OK] Refuted {args.id}: {b['statement'][:60]}")
    print(f"     Replacement {replacement['id']} asserted (proposed — needs confirm)")
    if flagged:
        print(f"[WARN] {len(flagged)} dependent belief(s) demoted for re-verification: {', '.join(flagged)}")


def cmd_retrieve(args):
    store = load_store()
    if not store["beliefs"]:
        print("[INFO] No beliefs in store. Run: python3 scripts/brain.py init")
        return
    scored = []
    for b in store["beliefs"]:
        score = keyword_score(args.query, belief_text(b))
        if score > 0:
            scored.append((score, b))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    n = args.n or RETRIEVE_DEFAULT_N
    for score, b in scored[:n]:
        status_tag = {"confirmed": "CONF", "refuted": "KILLED",
                      "proposed": "PROP", "decayed": "DECAY"}[b["status"]]
        print(f"{b['id']} [{status_tag}|{b['evidence_level']:>11s}] ({b['domain']})")
        print(f"      {b['statement'][:100]}")
        if b["status"] == "refuted" and b.get("superseded_by"):
            rep = find_belief(store, b["superseded_by"])
            if rep:
                print(f"      → superseded by {rep['id']}: {rep['statement'][:80]}")
    if not scored:
        print(f"[INFO] No beliefs matched '{args.query}'")


def cmd_list(args):
    store = load_store()
    for b in store["beliefs"]:
        if args.status and b["status"] != args.status:
            continue
        if args.domain and not b.get("domain", "").startswith(args.domain):
            continue
        status_tag = {"confirmed": "CONF", "refuted": "KILLED",
                      "proposed": "PROP", "decayed": "DECAY"}[b["status"]]
        print(f"{b['id']} [{status_tag}|{b['evidence_level']:>11s}] {b['domain']:<28s} {b['statement'][:70]}")


def cmd_gen_view(args):
    store = load_store()
    lines = [
        "# BELIEFS.md — Generated View (do not edit; regenerate via `brain.py gen-view`)",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — "
        f"{len(store['beliefs'])} beliefs",
        "",
        "Evidence ladder: assumed < code-read < spec-checked < emulated < real-media < hardware",
        "",
    ]
    # Group by domain
    domains = {}
    for b in store["beliefs"]:
        domains.setdefault(b.get("domain", "general"), []).append(b)
    for domain in sorted(domains):
        lines.append(f"## {domain}")
        lines.append("")
        lines.append("| ID | Status | Evidence | Statement |")
        lines.append("|---|--------|----------|-----------|")
        for b in domains[domain]:
            stmt = b["statement"].replace("|", "\\|")
            extra = ""
            if b["status"] == "refuted" and b.get("superseded_by"):
                extra = f" → see {b['superseded_by']}"
            lines.append(f"| {b['id']} | {b['status']} | {b['evidence_level']} | {stmt}{extra} |")
        lines.append("")
    atomic_write(VIEW_FILE, "\n".join(lines))
    print(f"[OK] Generated {VIEW_FILE}")


def _resolve_provenance_file(match: str) -> Path | None:
    """Resolve a provenance path token to a repo file (direct or basename)."""
    direct = REPO_ROOT / match
    if direct.exists():
        return direct
    found = list(REPO_ROOT.rglob(Path(match).name))
    return found[0] if found else None


def _file_changed_since_commit(repo_file: Path, commit_ref: str) -> bool | None:
    """True if repo_file changed in any commit after commit_ref.

    Returns None when the check can't run (no git / commit unknown / file
    untracked). Commit-aware staleness is precise: it only fires when the
    provenance file actually changed in a later commit, not merely when its
    mtime moved (e.g. an unrelated same-day edit).
    """
    if not commit_ref:
        return None
    try:
        rel = repo_file.relative_to(REPO_ROOT)
    except ValueError:
        return None
    try:
        # 0 exit + empty output => no commits touching the file after ref.
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "log", "--oneline",
             f"{commit_ref}..HEAD", "--", str(rel)],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None  # bad commit_ref or not a git op context
    return bool(out.stdout.strip())


def cmd_stale(args):
    """Beliefs whose provenance files changed after last_verified.

    Precise path (preferred): when a belief carries commit_ref, flag stale
    only if a provenance file changed in a commit AFTER commit_ref
    (git log commit_ref..HEAD -- file). Fallback: mtime-day comparison for
    beliefs without commit_ref.
    """
    store = load_store()
    stale = []
    for b in store["beliefs"]:
        if b["status"] not in ("confirmed",):
            continue
        if not b.get("last_verified"):
            continue
        prov = b.get("provenance", "")
        commit_ref = b.get("commit_ref")
        # Extract repo-relative file paths from provenance (e.g., "Mor.c:18", "agent/agent.py:2906")
        for match in re.findall(r"([\w./-]+\.(?:c|h|py|js|md|yaml|yml|sh))", prov):
            f = _resolve_provenance_file(match)
            if f is None:
                continue
            # Commit-aware path first — precise, ignores same-day unrelated edits.
            changed = _file_changed_since_commit(f, commit_ref)
            if changed is True:
                stale.append((b["id"], match, f"changed-after-{commit_ref[:8]}", b["last_verified"]))
                continue
            if changed is False:
                continue  # no post-commit change — not stale on this file
            # Fallback: mtime-day granularity when commit path unavailable.
            mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d")
            if mtime > b["last_verified"]:
                stale.append((b["id"], match, mtime, b["last_verified"]))
    if stale:
        print(f"[WARN] {len(stale)} belief(s) may be stale — provenance file changed after verification:")
        for bid, f, mtime, verified in stale:
            print(f"  {bid}: {f} modified {mtime} > verified {verified}")
    else:
        print("[OK] No stale beliefs detected")


def cmd_check(args):
    """Validate store integrity."""
    store = load_store()
    errors = []
    ids = set()
    for b in store["beliefs"]:
        bid = b.get("id")
        if bid in ids:
            errors.append(f"duplicate id {bid}")
        ids.add(bid)
        if b.get("status") not in STATUSES:
            errors.append(f"{bid}: invalid status '{b.get('status')}'")
        if b.get("evidence_level") not in EVIDENCE_LEVELS:
            errors.append(f"{bid}: invalid evidence_level '{b.get('evidence_level')}'")
        if b.get("status") == "confirmed":
            if evidence_rank(b.get("evidence_level")) < 1:
                errors.append(f"{bid}: confirmed but evidence_level is 'assumed'")
            if not b.get("provenance"):
                errors.append(f"{bid}: confirmed without provenance")
        for dep in b.get("dependents", []):
            if not any(x.get("id") == dep for x in store["beliefs"]):
                errors.append(f"{bid}: dependent {dep} does not exist")
        for link in ("supersedes", "superseded_by"):
            ref = b.get(link)
            if ref and not any(x.get("id") == ref for x in store["beliefs"]):
                errors.append(f"{bid}: {link} references missing {ref}")
    if errors:
        print(f"[FAIL] {len(errors)} integrity error(s):")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    counts = {}
    for b in store["beliefs"]:
        counts[b["status"]] = counts.get(b["status"], 0) + 1
    print(f"[OK] {len(store['beliefs'])} beliefs, integrity clean "
          f"({', '.join(f'{k}:{v}' for k, v in sorted(counts.items()))})")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Brain — evidence-tagged belief layer")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init")

    p = sub.add_parser("assert")
    p.add_argument("--statement", required=True)
    p.add_argument("--domain")
    p.add_argument("--provenance")
    p.add_argument("--source")
    p.add_argument("--notes")

    p = sub.add_parser("confirm")
    p.add_argument("--id", required=True)
    p.add_argument("--evidence-level", required=True, choices=EVIDENCE_LEVELS[1:])
    p.add_argument("--provenance", required=True)
    p.add_argument("--commit")

    p = sub.add_parser("refute")
    p.add_argument("--id", required=True)
    p.add_argument("--replacement", required=True)
    p.add_argument("--evidence")

    p = sub.add_parser("retrieve")
    p.add_argument("--query", required=True)
    p.add_argument("-n", type=int)

    p = sub.add_parser("list")
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--domain")

    sub.add_parser("gen-view")
    sub.add_parser("stale")
    sub.add_parser("check")

    args = parser.parse_args()
    {
        "init": cmd_init, "assert": cmd_assert, "confirm": cmd_confirm,
        "refute": cmd_refute, "retrieve": cmd_retrieve, "list": cmd_list,
        "gen-view": cmd_gen_view, "stale": cmd_stale, "check": cmd_check,
    }[args.command](args)


if __name__ == "__main__":
    main()
