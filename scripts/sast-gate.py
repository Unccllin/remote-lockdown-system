#!/usr/bin/env python3
"""sast-gate.py — gate a Semgrep JSON report against a reviewed-exception list.

Why this exists: CodeQL cannot run in this repository. Code scanning on a private
repository requires GitHub Code Security, and without it the SARIF upload returns
403, so `.github/workflows/codeql.yml` is gated off and fails nothing. This gives
the same class of coverage without the licence.

Why it is not just "fail on ERROR": that was the policy until session 250, and it
made the WARNING tier decorative. Semgrep printed 40 WARNING findings on every
run and nobody had to look at any of them — a summary line nobody reads is a
half-gate (recorded as a Layer-4 failure in S250's trace block). Every finding now
has to reach a verdict: either it is fixed, or it is listed in
`scripts/sast-exceptions.json` with a disposition and a reason that a reviewer can
check against the code.

What counts as evidence, and why the key is the source line
------------------------------------------------------------
Semgrep's OSS report sets `extra.lines` and `extra.fingerprint` to the literal
string `"requires login"` — the registry withholds both from unauthenticated
scans (measured in S251). A gate keyed on `fingerprint` would therefore match
everything against nothing. The identity used here is instead:

    (rule id, file path, the stripped source line at the finding's line,
     occurrence index within that group)

read from the file on disk. That is stable when code moves up or down a file, and
it is deliberately *unstable* when the flagged line changes: editing the code
invalidates its exception, so a stale "we reviewed this" cannot silently cover
new code. Exceptions that match nothing are a failure too — that is how a fixed
finding gets its entry removed instead of lingering as decoration.

ERROR findings cannot be excepted at all. The tiers above ERROR are where a
reviewed accept-risk decision belongs; ERROR means the rule is confident the code
is exploitable, and no comment in a JSON file changes that.

Usage:
    python3 scripts/sast-gate.py semgrep.json
    python3 scripts/sast-gate.py semgrep.json --lenient      # report only, never fails
    python3 scripts/sast-gate.py semgrep.json --exceptions other.json

Exit: 0 every finding classified, 1 unclassified findings or stale exceptions,
      2 unreadable report or an invalid exceptions file.
"""

from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_EXCEPTIONS = SCRIPT_DIR / "sast-exceptions.json"
DEFAULT_REPO_ROOT = SCRIPT_DIR.parent

REQUIRED_FIELDS = ("rule", "path", "match", "disposition", "reason")
VALID_DISPOSITIONS = ("false-positive", "accepted-risk")
UNREADABLE = "<line unreadable>"


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_report(path: Path) -> tuple[dict | None, str | None]:
    """Return (report, error) — the same shape as load_exceptions, so a caller has
    one place to look for "could not read this" instead of a try block per loader."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except (OSError, ValueError) as exc:
        return None, f"cannot read {path}: {exc}"


def load_exceptions(path: Path) -> tuple[list[dict], list[str]]:
    """Return (entries, problems). A non-empty problem list is fatal."""
    if not path.exists():
        return [], [f"exceptions file not found: {path}"]
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return [], [f"cannot read {path}: {exc}"]

    entries = data.get("exceptions")
    if not isinstance(entries, list):
        return [], [f'{path}: "exceptions" must be a list']

    problems: list[str] = []
    seen: dict[tuple, int] = {}
    for index, entry in enumerate(entries):
        where = f"{path.name}: exceptions[{index}]"
        if not isinstance(entry, dict):
            problems.append(f"{where} is not an object")
            continue
        missing = [f for f in REQUIRED_FIELDS if not entry.get(f)]
        if missing:
            problems.append(f"{where} is missing {', '.join(missing)}")
            continue
        if entry["disposition"] not in VALID_DISPOSITIONS:
            problems.append(
                f"{where} has disposition {entry['disposition']!r}; "
                f"expected one of {', '.join(VALID_DISPOSITIONS)}"
            )
            continue
        if len(entry["reason"].strip()) < 20:
            problems.append(
                f"{where} reason is too short to review "
                f"({len(entry['reason'].strip())} chars, need 20)"
            )
            continue
        key = exception_key(entry)
        if key in seen:
            problems.append(
                f"{where} duplicates exceptions[{seen[key]}] "
                f"({entry['rule']} in {entry['path']})"
            )
            continue
        seen[key] = index
    return entries, problems


def exception_key(entry: dict) -> tuple:
    return (
        entry["rule"],
        entry["path"],
        entry["match"].strip(),
        int(entry.get("occurrence", 1)),
    )


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def source_line(repo_root: Path, finding: dict) -> str:
    """The stripped source text at the finding's line, read from disk.

    Not from the report: `extra.lines` is withheld from unauthenticated scans.
    """
    path = repo_root / finding.get("path", "")
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return UNREADABLE
    lineno = finding.get("start", {}).get("line") or 0
    if lineno < 1 or lineno > len(lines):
        return UNREADABLE
    text = lines[lineno - 1].strip()
    return text or UNREADABLE


def finding_keys(results: list[dict], repo_root: Path) -> list[tuple]:
    """One key per finding, in the same order as *results*.

    Findings that share (rule, path, line text) are numbered in file order so a
    file with two identical flagged lines still has two distinguishable entries.
    """
    ordered = sorted(
        range(len(results)),
        key=lambda i: (
            results[i].get("path", ""),
            results[i].get("start", {}).get("line", 0),
            results[i].get("start", {}).get("col", 0),
            results[i].get("check_id", ""),
        ),
    )
    counters: collections.Counter = collections.Counter()
    keys: list[tuple] = [()] * len(results)
    for i in ordered:
        finding = results[i]
        base = (
            finding.get("check_id", ""),
            finding.get("path", ""),
            source_line(repo_root, finding),
        )
        counters[base] += 1
        keys[i] = base + (counters[base],)
    return keys


def severity(finding: dict) -> str:
    return (finding.get("extra", {}) or {}).get("severity") or "UNKNOWN"


def classify(report: dict, entries: list[dict], repo_root: Path) -> dict:
    """Split findings into gating / accepted / unclassified, and find stale entries.

    * gating      — ERROR severity; an exception cannot cover it.
    * unclassified— any other severity with no reviewed entry.
    * accepted    — non-ERROR findings matched by exactly one entry.
    """
    results = report.get("results") or []
    keys = finding_keys(results, repo_root)
    by_key = {exception_key(e): e for e in entries}

    gating, accepted, unclassified = [], [], []
    consumed: set[tuple] = set()
    for finding, key in zip(results, keys, strict=True):
        if severity(finding) == "ERROR":
            gating.append((finding, by_key.get(key)))
            continue
        entry = by_key.get(key)
        if entry is None:
            unclassified.append(finding)
        else:
            consumed.add(key)
            accepted.append((finding, entry))

    stale = [e for k, e in by_key.items() if k not in consumed]
    return {
        "gating": gating,
        "unclassified": unclassified,
        "accepted": accepted,
        "stale": stale,
        "total": len(results),
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def loc(finding: dict) -> str:
    return f"{finding.get('path')}:{finding.get('start', {}).get('line')}"


def short_rule(finding: dict) -> str:
    return (finding.get("check_id") or "").split(".")[-1]


def report_clean(verdict: dict) -> None:
    print(f"Semgrep findings: {verdict['total']}")
    by_sev = collections.Counter(severity(f) for f, _ in verdict["accepted"])
    for sev in ("MEDIUM", "WARNING", "INFO"):
        if by_sev.get(sev):
            print(f"  {sev:8} {by_sev[sev]} accepted with a documented reason")
    if not verdict["accepted"]:
        print("  none")
        return
    print()
    print("Accepted findings (scripts/sast-exceptions.json), by rule:")
    grouped: dict[str, list[tuple]] = collections.defaultdict(list)
    for finding, entry in verdict["accepted"]:
        grouped[finding.get("check_id")].append((finding, entry))
    for rule, items in sorted(grouped.items(), key=lambda kv: -len(kv[1])):
        files = {loc(f).rsplit(":", 1)[0] for f, _ in items}
        print(f"  {len(items):3}  {rule}  ({len(files)} file(s))")
        for finding, entry in sorted(items, key=lambda pair: loc(pair[0])):
            print(f"        {loc(finding):45} {entry['disposition']}")


def report_gating(verdict: dict, repo_root: Path) -> bool:
    """Print every reason to fail. Returns True when the run must fail."""
    problems = False

    if verdict["gating"]:
        problems = True
        print()
        print(
            f"[FAIL] {len(verdict['gating'])} finding(s) at ERROR severity. "
            "ERROR is not exceptionable — the rule is confident the code is "
            "exploitable. Fix the code:"
        )
        for finding, entry in verdict["gating"]:
            print(f"  {loc(finding):45} {short_rule(finding)}")
            if entry is not None:
                print(
                    "      an exception entry exists for this line but cannot cover "
                    "ERROR severity — delete that entry once the code is fixed"
                )

    if verdict["unclassified"]:
        problems = True
        print()
        print(
            f"[FAIL] {len(verdict['unclassified'])} finding(s) are unclassified. "
            "Fix the code, or add an entry to scripts/sast-exceptions.json "
            "(rule, path, match, disposition, reason, reviewed). Next step: copy "
            "the `match` text below verbatim into the entry:"
        )
        for finding in sorted(verdict["unclassified"], key=loc):
            print(f"  {severity(finding):7} {loc(finding):45} {short_rule(finding)}")
            print(f"      {source_line(repo_root, finding)[:120]}")

    if verdict["stale"]:
        problems = True
        print()
        print(
            f"[FAIL] {len(verdict['stale'])} exception(s) match no finding. Either the "
            "flagged line changed (re-review it) or the finding is gone (delete the "
            "entry). An exception that matches nothing is documentation of a decision "
            "nobody is making any more:"
        )
        for entry in verdict["stale"]:
            print(f"  {entry['path']:45} {entry['rule'].split('.')[-1]}")
            print(f"      match: {entry['match'][:100]}")

    return problems


def unscanned_files(report: dict) -> dict[str, str]:
    """Map each path Semgrep reported an error for to a short reason.

    Why this exists: an unparseable file produces **no findings**, which the gate reads as
    "clean". EDK II C is the live example — `EFIAPI` after a return type and typedefs the OSS
    parser cannot resolve make every `firmware/PblPkg/PblApp/*.c` unreadable, so 17 files were
    silently outside the gate's assurance while the run printed `[OK]`. That is the same class
    of blindness (a tier nobody can see reading as green) that made this gate fail on
    unclassified WARNINGs in S251.

    Reported, not gated: failing here would turn CI red for a dozen pre-existing files whose
    parse failure is a tooling limitation, not a defect, and a permanently-red gate gets
    ignored — which is the failure this script was written to end.
    """
    reasons: dict[str, str] = {}
    for error in report.get("errors") or []:
        path = error.get("path")
        if not path:
            continue
        kind = error.get("type")
        message = str(error.get("message") or "")
        if isinstance(kind, list) and kind and kind[0] == "PartialParsing":
            reason = "partially parsed"
        elif "Timeout" in str(kind) or "Timeout" in message:
            reason = "timed out"
        else:
            reason = "could not be parsed"
        reasons.setdefault(path, reason)
    return reasons


def report_coverage(report: dict) -> None:
    """Print the files that received no coverage. Never affects the exit code."""
    files = unscanned_files(report)
    if not files:
        return
    print()
    print(
        f"[sast] NOTE: {len(files)} file(s) were NOT scanned — Semgrep could not read them, "
        "so 'no findings here' does not mean 'clean':"
    )
    for path in sorted(files):
        print(f"  {path:62} {files[path]}")
    print(
        "[sast] these files carry no static-analysis coverage; the known cause is EDK II C "
        "(EFIAPI after the return type, typedefs the OSS parser cannot resolve)"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Gate a Semgrep JSON report.")
    ap.add_argument("report", help="path to the JSON produced by semgrep --json-output")
    ap.add_argument(
        "--exceptions",
        type=Path,
        default=DEFAULT_EXCEPTIONS,
        help=f"reviewed-exception file (default: {DEFAULT_EXCEPTIONS})",
    )
    ap.add_argument(
        "--repo-root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="root the report's paths are relative to (default: the repository)",
    )
    ap.add_argument(
        "--lenient",
        action="store_true",
        help="report everything and exit 0 (local triage only; CI must not use this)",
    )
    args = ap.parse_args()

    report, problem = load_report(args.report)
    if problem is not None or report is None:
        print(f"[FAIL] {problem or 'empty report'}", file=sys.stderr)
        return 2

    entries, problems = load_exceptions(args.exceptions)
    if problems:
        print(f"[FAIL] invalid exceptions file {args.exceptions}:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "  Each entry needs rule, path, match (the flagged source line), "
            "disposition (false-positive|accepted-risk), reason (>=20 chars), "
            "and reviewed (e.g. S251).",
            file=sys.stderr,
        )
        return 2

    verdict = classify(report, entries, args.repo_root)

    if args.lenient:
        print(f"Semgrep findings: {verdict['total']} (lenient — nothing is gating)")
        for label in ("accepted", "unclassified"):
            for item in verdict[label]:
                finding = item[0] if label == "accepted" else item
                print(f"  {label:13} {severity(finding):7} {loc(finding):45} {short_rule(finding)}")
        for finding, _ in verdict["gating"]:
            print(f"  {'gating':13} ERROR   {loc(finding):45} {short_rule(finding)}")
        for entry in verdict["stale"]:
            print(f"  {'stale-entry':13} {entry['path']:45} {entry['rule'].split('.')[-1]}")
        report_coverage(report)
        return 0

    failed = report_gating(verdict, args.repo_root)
    if failed:
        print()
        print(
            f"Summary: {verdict['total']} finding(s) — {len(verdict['gating'])} ERROR, "
            f"{len(verdict['accepted'])} accepted, {len(verdict['unclassified'])} unclassified, "
            f"{len(verdict['stale'])} stale exception(s)."
        )
        report_coverage(report)
        return 1

    report_clean(verdict)
    print()
    print("[OK] every finding is either fixed or carries a reviewed reason")
    report_coverage(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
