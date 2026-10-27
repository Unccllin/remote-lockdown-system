#!/usr/bin/env python3
"""check_licenses.py — audit third-party licences and emit THIRD-PARTY-NOTICES.

Why this exists (S141): the repo is private and ships anti-theft security
software, but had no LICENSE, no NOTICE file and no `license` field in any
package.json. That blocks reusing any Apache-2.0 code (e.g. MeshCentral's AMT
plumbing) and, worse, hides the real question: does anything already in the tree
carry a copyleft licence that would constrain how this product can be
distributed?

What it does:
  * reads the installed `node_modules/*/package.json` for each component, so the
    answer reflects what actually ships rather than what the lockfile wishes;
  * classifies each licence: permissive / copyleft / unknown;
  * reads Python requirements for names only (offline: licence text unknown);
  * writes THIRD-PARTY-NOTICES.md;
  * exits non-zero when a copyleft (GPL/AGPL) dependency is found, because that
    is a distribution decision, not something to discover later.

Usage:
  scripts/check_licenses.py                 # report + write notices + exit code
  scripts/check_licenses.py --check         # report only; non-zero on copyleft
  scripts/check_licenses.py --json          # machine-readable summary
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = ["server", "dashboard", "electron", "serverless"]

PERMISSIVE = {
    "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
    "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0", "Zlib", "WTFPL",
    "MIT-0", "Apache-2.0 AND MIT", "BSD", "CC-BY-4.0", "(MIT OR CC0-1.0)",
    "MPL-2.0", "EPL-2.0", "Artistic-2.0", "LGPL-3.0-or-later",
}
# Licences that are neither permissive nor classic copyleft, but impose
# conditions a commercial product must consciously accept. Hippocratic-2.1 is
# not OSI-approved and restricts *use* (not just redistribution).
RESTRICTED = {"Hippocratic-2.1", "Hippocratic-2.0", "SSPL-1.0", "BUSL-1.1",
              "Commons-Clause", "Elastic-2.0"}

# Packages that ship a LICENSE file but omit the `license` field from
# package.json. Values verified by reading the shipped LICENSE file (S141).
LICENSE_OVERRIDES = {
    "@react-leaflet/core": "Hippocratic-2.1",
    "react-leaflet": "Hippocratic-2.1",
}

COPYLEFT = {"GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0",
            "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0", "AGPL-3.0-only",
            "AGPL-3.0-or-later", "SSPL-1.0", "CDDL-1.0"}


def licence_of(pkg: dict) -> str:
    lic = pkg.get("license")
    if isinstance(lic, dict):
        lic = lic.get("type")
    if not lic:
        lic = pkg.get("licenses")
        if isinstance(lic, list) and lic:
            lic = lic[0].get("type") if isinstance(lic[0], dict) else str(lic[0])
    return str(lic or "UNKNOWN")


def _terms(lic: str) -> list[str]:
    """Split an SPDX expression into its individual licence ids.

    Packages ship disjunctions like "(MIT OR WTFPL)"; the consumer may pick any
    one, so the expression is permissive if any term is. Without this, three
    dependencies were reported as UNKNOWN purely because of the parentheses.
    """
    cleaned = lic.strip().strip("()")
    parts = re.split(r"\s+(?:OR|AND)\s+", cleaned, flags=re.IGNORECASE)
    return [p.strip().strip("()") for p in parts if p.strip()]


def classify(lic: str) -> str:
    if lic.upper() != "UNKNOWN":
        classes = {_classify_single(t) for t in _terms(lic)}
        if "copyleft" in classes:
            return "copyleft"
        if "restricted" in classes:
            return "restricted"
        if "permissive" in classes:
            return "permissive"
    return "unknown"


def _classify_single(lic: str) -> str:
    norm = lic.replace(" ", "")
    if any(norm.startswith(c.replace(" ", "")) for c in COPYLEFT):
        return "copyleft"
    if any(norm.startswith(r.replace(" ", "")) for r in RESTRICTED):
        return "restricted"
    if any(norm.startswith(p.replace(" ", "")) for p in PERMISSIVE):
        return "permissive"
    return "unknown"


def scan_node(component: str) -> dict[str, dict]:
    found: dict[str, dict] = {}
    nm = ROOT / component / "node_modules"
    if not nm.is_dir():
        return found
    for entry in nm.iterdir():
        if not entry.is_dir():
            continue
        candidates = [entry] if (entry / "package.json").is_file() else list(entry.iterdir())
        for pkg_dir in candidates:
            pj = pkg_dir / "package.json"
            if not pj.is_file():
                continue
            try:
                data = json.loads(pj.read_text(encoding="utf-8", errors="replace"))
            except (OSError, json.JSONDecodeError):
                continue
            name = data.get("name")
            if not name:
                continue
            lic = licence_of(data)
            if lic == "UNKNOWN":
                lic = LICENSE_OVERRIDES.get(name, lic)
            found[f"{name}@{data.get('version', '?')}"] = {
                "name": name,
                "version": data.get("version", "?"),
                "license": lic,
                "class": classify(lic),
                "component": component,
            }
    return found


def scan_python() -> list[str]:
    reqs = []
    for req in (ROOT / "agent" / "requirements.txt", ROOT / "agent" / "requirements-dev.txt"):
        if not req.is_file():
            continue
        for line in req.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                reqs.append(line.split("==")[0].split(">=")[0].strip())
    return sorted(set(reqs))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report only, do not write notices")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="also fail on use-restricted licences (for CI once the policy is decided)",
    )
    args = ap.parse_args()

    all_pkgs: dict[str, dict] = {}
    by_component: dict[str, dict[str, dict]] = {}
    for comp in COMPONENTS:
        found = scan_node(comp)
        by_component[comp] = found
        for key, val in found.items():
            all_pkgs.setdefault(key, val)

    counts = defaultdict(int)
    for pkg in all_pkgs.values():
        counts[pkg["class"]] += 1

    by_name = lambda pkgs: sorted(pkgs, key=lambda p: p["name"].lower())  # noqa: E731
    copyleft = by_name(p for p in all_pkgs.values() if p["class"] == "copyleft")
    restricted = by_name(p for p in all_pkgs.values() if p["class"] == "restricted")
    unknown = by_name(p for p in all_pkgs.values() if p["class"] == "unknown")
    py = scan_python()

    if args.json:
        print(json.dumps({
            "counts": dict(counts),
            "packages": sorted(all_pkgs.values(), key=lambda p: p["name"].lower()),
            "copyleft": copyleft,
            "restricted": restricted,
            "unknown": [p["name"] for p in unknown],
            "python_requirements": py,
        }, indent=2))
        return 1 if (copyleft or (restricted and args.strict)) else 0

    print(f"scanned {len(all_pkgs)} distinct npm packages across {len(COMPONENTS)} components")
    print(f"  permissive: {counts['permissive']}   unknown: {counts['unknown']}   "
          f"copyleft: {counts['copyleft']}   restricted: {counts['restricted']}")
    print(f"  python requirements (licence text not resolved offline): {len(py)}")

    if copyleft:
        print("\n[FAIL] copyleft dependencies found — this constrains distribution:")
        for p in copyleft:
            print(f"  {p['name']}@{p['version']}  {p['license']}  ({p['component']})")
    if restricted:
        print("\n[FAIL] licence(s) with use restrictions (not OSI-approved) — product decision:")
        for pkg in restricted:
            print(f"  {pkg['name']}@{pkg['version']}  {pkg['license']}  ({pkg['component']})")
        print("  Options: accept and document, or replace with a permissive alternative")
        print("  (e.g. leaflet itself is BSD-2-Clause; only the react-leaflet wrapper is restricted).")

    if unknown:
        print(f"\n[WARN] {len(unknown)} package(s) with no resolvable licence field:")
        for p in unknown[:15]:
            print(f"  {p['name']}@{p['version']}  ({p['component']})")
        if len(unknown) > 15:
            print(f"  … and {len(unknown) - 15} more")

    if not args.check:
        notices = ROOT / "THIRD-PARTY-NOTICES.md"
        lines = [
            "# Third-Party Notices",
            "",
            "Generated by `scripts/check_licenses.py` — do not edit by hand.",
            f"{len(all_pkgs)} distinct npm packages across: {', '.join(COMPONENTS)}.",
            "",
            "Copyleft dependencies in the shipped tree are a distribution decision;",
            "the generator exits non-zero if any are present.",
            "",
            "## npm",
            "",
            "| Package | Version | Licence | Component |",
            "|---|---|---|---|",
        ]
        for p in sorted(all_pkgs.values(), key=lambda p: (p["name"].lower(), p["component"])):
            lines.append(f"| {p['name']} | {p['version']} | {p['license']} | {p['component']} |")
        lines += ["", "## Python (agent)", "",
                  "Licence text is not resolved offline; verify before distribution.", ""]
        lines += [f"- {r}" for r in py]
        notices.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"\nwrote {notices.relative_to(ROOT)}")

    return 1 if (copyleft or (restricted and args.strict)) else 0


if __name__ == "__main__":
    sys.exit(main())
