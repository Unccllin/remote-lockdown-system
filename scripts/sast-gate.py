#!/usr/bin/env python3
"""sast-gate.py — summarise a Semgrep JSON report and gate on ERROR findings.

Why this exists: CodeQL cannot run in this repository. Code scanning on a private
repository requires GitHub Code Security, and without it the SARIF upload returns
403, so `.github/workflows/codeql.yml` is gated off and fails nothing. This gives
the same class of coverage without the licence.

Semgrep's `p/default` ruleset produces three tiers of result. The gate fails only
on ERROR severity: those are high-confidence issues in the code under review.
WARNING/MEDIUM/INFO results are printed (grouped by rule, so a reviewer can see
patterns rather than a wall of lines) but do not block — most are expected in this
codebase, e.g. `dynamic-urllib-use` for an agent that posts to operator-configured
server URLs, or `express-check-csurf` for a token-authenticated API that has no
cookie session to forge.

Usage:
    python3 scripts/sast-gate.py semgrep.json
    python3 scripts/sast-gate.py semgrep.json --strict   # WARNING blocks too

Exit: 0 clean, 1 findings at the gating severity, 2 unreadable report.
"""

import argparse
import collections
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description="Gate a Semgrep JSON report.")
    ap.add_argument("report", help="path to the JSON produced by semgrep --json-output")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="treat WARNING as gating as well (ERROR is always gating)",
    )
    args = ap.parse_args()

    try:
        with open(args.report, encoding="utf-8") as fh:
            report = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[FAIL] cannot read {args.report}: {exc}", file=sys.stderr)
        return 2

    results = report.get("results") or []
    by_sev = collections.Counter(r.get("extra", {}).get("severity") for r in results)
    gating_sevs = {"ERROR", "WARNING"} if args.strict else {"ERROR"}

    print(f"Semgrep findings: {len(results)}")
    for sev in ("ERROR", "WARNING", "MEDIUM", "INFO"):
        if by_sev.get(sev):
            print(f"  {sev:8} {by_sev[sev]}")

    gating = [r for r in results if r.get("extra", {}).get("severity") in gating_sevs]
    if gating:
        print()
        print(f"[FAIL] {len(gating)} finding(s) at {', '.join(sorted(gating_sevs))} severity:")
        for r in gating:
            loc = f"{r.get('path')}:{r.get('start', {}).get('line')}"
            msg = (r.get("extra", {}).get("message") or "").strip().splitlines()
            print(f"  {loc}  {r.get('check_id')}")
            if msg:
                print(f"      {msg[0][:150]}")
        return 1

    # Non-gating findings, grouped so patterns are visible instead of noise.
    rest = [r for r in results if r not in gating]
    if rest:
        print()
        print("Non-gating findings (reported, not blocking), grouped by rule:")
        grouped = collections.Counter(r.get("check_id") for r in rest)
        for rule, count in grouped.most_common(10):
            files = {r.get("path") for r in rest if r.get("check_id") == rule}
            print(f"  {count:3}  {rule}  ({len(files)} file(s))")

    print()
    print("[OK] no findings at gating severity")
    return 0


if __name__ == "__main__":
    sys.exit(main())
