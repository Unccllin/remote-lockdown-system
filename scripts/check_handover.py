#!/usr/bin/env python3
"""Validate the product handover inventory (docs/handover-registry.json).

The handover package is the non-code half of this product: key custody, account
ownership, physical assets, named obligations and the written acceptances. It is
the half that cannot be recovered from `git log`, so it is also the half that
rots silently.

This gate fails when:

  * a secret-shaped variable appears in an env example but is not registered
    (a new key nobody recorded custody of),
  * an entry is missing a required field, or duplicates another id,
  * a key is marked `critical` but also `regenerable: yes` (a contradiction:
    a critical key is one whose loss cannot be undone),
  * a cited reference path does not exist on disk,
  * `--strict` is given (or meta.status is `transferred`) and an obligation
    still has no named person, or an acceptance is still unsigned.

Usage:
    python3 scripts/check_handover.py              # pre-transfer check
    python3 scripts/check_handover.py --strict     # post-transfer gate
    python3 scripts/check_handover.py --self-test  # prove the checks have teeth
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(REPO_ROOT, "docs", "handover-registry.json")

ENV_EXAMPLES = [".env.prod.example", os.path.join("server", ".env.example")]

# A variable name that implies a credential, a key or a live posting endpoint.
SECRET_NAME = re.compile(
    r"(SECRET|KEY|PASSWORD|PEPPER|TOKEN|PASS|WEBHOOK)", re.IGNORECASE
)
ENV_LINE = re.compile(r"^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=")

SEVERITIES = {"critical", "high", "medium", "low"}
REGENERABLE = {"yes", "no", "yes-with-reenrolment"}

REQUIRED = {
    "keys": ["id", "name", "where", "purpose", "regenerable",
             "severity", "loss_impact", "transfer_action"],
    "accounts": ["id", "service", "why", "transfer_action"],
    "assets": ["id", "what", "why", "transfer_action"],
    "obligations": ["id", "obligation", "cadence", "role", "evidence"],
    "acceptances": ["id", "item", "status"],
    "gaps": ["id", "gap", "blocks", "remedy"],
}


def fail(msg: str, failures: list[str]) -> None:
    failures.append(msg)


class HandoverError(Exception):
    """A file the inventory depends on cannot be read."""


def load_registry(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise HandoverError(f"cannot read registry {path}: {error}") from error


def env_secret_names(root: str, failures: list[str]) -> dict[str, str]:
    """Every credential-shaped variable declared in an env example -> its file.

    A missing env example is not an error (a fresh clone may lack one), but an
    unreadable one is: silently scanning nothing would report a clean bill of
    health for a file nobody checked.
    """
    found: dict[str, str] = {}
    for rel in ENV_EXAMPLES:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                lines = list(handle)
        except OSError as error:
            fail(f"cannot read {rel}: {error}", failures)
            continue
        for line in lines:
            match = ENV_LINE.match(line)
            if match and SECRET_NAME.search(match.group(1)):
                found.setdefault(match.group(1), rel)
    return found


def check_registry(reg: dict, root: str, strict: bool) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []

    meta = reg.get("meta", {})
    if not meta.get("status"):
        fail("meta.status is missing", failures)
    effective_strict = strict or meta.get("status") == "transferred"

    seen_ids: dict[str, str] = {}
    registered_env: dict[str, str] = {}

    for section, required in REQUIRED.items():
        entries = reg.get(section)
        if not isinstance(entries, list) or not entries:
            fail(f"{section}: missing or empty", failures)
            continue
        for index, entry in enumerate(entries):
            label = entry.get("id") or f"{section}[{index}]"
            for field in required:
                value = entry.get(field)
                if value in (None, "", [], {}):
                    fail(f"{label}: required field '{field}' is empty", failures)
            if label in seen_ids:
                fail(f"{label}: duplicate id (also used as {seen_ids[label]})", failures)
            seen_ids[label] = section

            for ref in entry.get("references", []):
                if not os.path.exists(os.path.join(root, ref)):
                    fail(f"{label}: reference does not exist: {ref}", failures)

    for entry in reg.get("keys", []):
        label = entry.get("id", "?")
        severity = entry.get("severity")
        regenerable = entry.get("regenerable")

        if severity not in SEVERITIES:
            fail(f"{label}: severity '{severity}' not in {sorted(SEVERITIES)}", failures)
        if regenerable not in REGENERABLE:
            fail(f"{label}: regenerable '{regenerable}' not in {sorted(REGENERABLE)}",
                 failures)
        if severity == "critical" and regenerable == "yes":
            fail(
                f"{label}: critical severity contradicts regenerable=yes — "
                "a key whose loss cannot be undone is not regenerable",
                failures,
            )
        if not entry.get("transfer_action"):
            fail(f"{label}: no transfer_action (a key with no handover step is a "
                 "key nobody knows how to move)", failures)
        for var in entry.get("env_vars", []):
            if var in registered_env and registered_env[var] != label:
                fail(f"{var}: registered twice ({registered_env[var]} and {label})",
                     failures)
            registered_env[var] = label
        for path in entry.get("where", []):
            if "/" in path and not os.path.exists(os.path.join(root, path)):
                fail(f"{label}: where path does not exist: {path}", failures)

    for var, source in env_secret_names(root, failures).items():
        if var in registered_env:
            continue
        if var in reg.get("env_ignore", []):
            continue
        fail(
            f"{var} ({source}): credential-shaped variable is not registered in "
            "docs/handover-registry.json — add its custody entry, or list it in "
            "env_ignore with a reason",
            failures,
        )

    for entry in reg.get("obligations", []):
        label = entry.get("id", "?")
        if effective_strict and not entry.get("named_person"):
            fail(f"{label}: no named_person (strict mode requires an accountable "
                 "human for every obligation)", failures)
        if not entry.get("named_person"):
            warnings.append(f"{label}: no named person yet (allowed pre-transfer)")

    if effective_strict:
        for entry in reg.get("acceptances", []):
            label = entry.get("id", "?")
            if entry.get("status") != "signed":
                fail(f"{label}: acceptance is '{entry.get('status')}' (strict mode "
                     "requires signed)", failures)
            if not entry.get("signed_by"):
                fail(f"{label}: signed acceptance has no signed_by", failures)

    for entry in reg.get("acceptances", []):
        label = entry.get("id", "?")
        if entry.get("status") not in {"unsigned", "signed"}:
            fail(f"{label}: status '{entry.get('status')}' not in "
                 "{unsigned, signed}", failures)
        if entry.get("status") == "signed" and not entry.get("signed_by"):
            fail(f"{label}: marked signed with no signed_by", failures)

    return failures, warnings


def render(reg: dict, failures: list[str], warnings: list[str], quiet: bool) -> int:
    keys = reg.get("keys", [])
    critical = [k for k in keys if k.get("severity") == "critical"]
    obligations = reg.get("obligations", [])
    assigned = [o for o in obligations if o.get("named_person")]
    signed = [a for a in reg.get("acceptances", []) if a.get("status") == "signed"]

    if not quiet:
        print(f"[handover] registry: docs/handover-registry.json "
              f"(status={reg.get('meta', {}).get('status')})")
        print(f"[handover] keys: {len(keys)} ({len(critical)} critical) · "
              f"accounts: {len(reg.get('accounts', []))} · "
              f"assets: {len(reg.get('assets', []))}")
        print(f"[handover] obligations: {len(assigned)}/{len(obligations)} with a "
              f"named person · acceptances: {len(signed)}/"
              f"{len(reg.get('acceptances', []))} signed")
        print("[handover] unowned critical keys: "
              + (", ".join(k["id"] for k in critical) or "none"))
        for warning in warnings:
            print(f"[handover] WARN {warning}")

    if failures:
        print(f"[handover] FAIL {len(failures)} problem(s):")
        for problem in failures:
            print(f"  - {problem}")
        return 1

    print("[handover] OK — inventory is complete and internally consistent")
    return 0


def self_test() -> int:
    """Mutate a copy and assert every check fires. A gate that cannot fail is a log line."""
    base = load_registry(REGISTRY)
    checks: list[tuple[str, dict, bool]] = []

    mutated = copy.deepcopy(base)
    mutated["keys"] = [
        entry for entry in mutated["keys"] if entry["id"] != "K-BACKUP"
    ]
    checks.append(("a dropped key entry makes its env var unregistered",
                   mutated, True))

    mutated = copy.deepcopy(base)
    mutated["keys"][0]["regenerable"] = "yes"
    mutated["keys"][0]["severity"] = "critical"
    checks.append(("critical + regenerable contradiction is caught", mutated, True))

    mutated = copy.deepcopy(base)
    mutated["obligations"][0]["role"] = ""
    checks.append(("obligation with no role is caught", mutated, True))

    mutated = copy.deepcopy(base)
    mutated["assets"][0]["references"] = ["docs/does-not-exist.md"]
    checks.append(("missing reference path is caught", mutated, True))

    mutated = copy.deepcopy(base)
    mutated["keys"][1]["id"] = mutated["keys"][0]["id"]
    checks.append(("duplicate id is caught", mutated, True))

    mutated = copy.deepcopy(base)
    mutated["keys"][0]["severity"] = "catastrophic"
    checks.append(("unknown severity is caught", mutated, True))

    checks.append(("the real registry is accepted", base, False))

    ok = True
    for label, reg, should_fail in checks:
        failures, _ = check_registry(reg, REPO_ROOT, strict=False)
        got = bool(failures)
        verdict = "ok" if got == should_fail else "MISMATCH"
        if got != should_fail:
            ok = False
        print(f"[self-test] {verdict}: {label} "
              f"(expected {'fail' if should_fail else 'pass'}, "
              f"got {'fail' if got else 'pass'})"
              + ("" if verdict == "ok" else f" :: {failures[:2]}"))

    # Strict mode must reject the pre-transfer registry, which has no named people.
    strict_failures, _ = check_registry(base, REPO_ROOT, strict=True)
    strict_ok = bool(strict_failures)
    if not strict_ok:
        ok = False
    print(f"[self-test] {'ok' if strict_ok else 'MISMATCH'}: --strict rejects an "
          f"unassigned registry (got {'fail' if strict_ok else 'pass'})")

    # And strict mode must accept it once it is fully signed off.
    assigned = copy.deepcopy(base)
    for entry in assigned["obligations"]:
        entry["named_person"] = "Filled By Self-Test"
    for entry in assigned["acceptances"]:
        entry["status"] = "signed"
        entry["signed_by"] = "Filled By Self-Test"
    assigned["meta"]["status"] = "transferred"
    strict_pass, strict_pass_failures = check_registry(assigned, REPO_ROOT, strict=True)
    if strict_pass_failures:
        ok = False
        print(f"[self-test] MISMATCH: fully assigned registry rejected :: "
              f"{strict_pass_failures[:3]}")
    else:
        print("[self-test] ok: fully assigned registry passes --strict")

    # The env scan itself needs teeth: prove it sees a real variable.
    names = env_secret_names(REPO_ROOT, [])
    for required in ("JWT_SECRET", "BACKUP_ENCRYPT_KEY", "UPDATE_SIGNING_KEY"):
        if required not in names:
            ok = False
            print(f"[self-test] MISMATCH: env scan missed {required}")

    print("[self-test] " + ("all checks have teeth" if ok else "SELF-TEST FAILED"))
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=REGISTRY)
    parser.add_argument("--root", default=REPO_ROOT)
    parser.add_argument("--strict", action="store_true",
                        help="post-transfer mode: require named people and signed acceptances")
    parser.add_argument("--self-test", action="store_true",
                        help="mutate copies and assert each check fires")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    try:
        reg = load_registry(args.registry)
    except HandoverError as error:
        print(f"[handover] FAIL {error}")
        return 1

    failures, warnings = check_registry(reg, args.root, args.strict)
    return render(reg, failures, warnings, args.quiet)


if __name__ == "__main__":
    sys.exit(main())
