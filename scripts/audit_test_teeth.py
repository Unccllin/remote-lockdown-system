#!/usr/bin/env python3
"""audit_test_teeth.py — would each 'verified-in-unit-test' path's suite notice a regression?

Why this exists
---------------
The graph marks ten enforcement paths `verified-in-unit-test`. That status means
"a test exists and passes", which is not the same as "the test would fail if the
feature regressed". The difference is not academic: session 169 shipped an
assertion that read the lock state through a path the bug never touched, so it
would have passed with the defect reinstated.

This script answers the question the only way that actually settles it — by
reintroducing the defect and running the suite. Each row is a *semantic* mutation
of the line that makes the feature work (skip the decryption, always claim the
setting applied, never check the deadman switch), not a cosmetic edit.

  KILLED    the suite failed -> the test has teeth
  SURVIVED  the suite passed -> the test does not test this behaviour

Usage:
  scripts/audit_test_teeth.py                 # run every mutation (~2 min)
  scripts/audit_test_teeth.py --path E-ACK    # one path
  scripts/audit_test_teeth.py --list          # show the table, change nothing

Exit code: 0 when every mutation is killed, 1 when any survives (a finding).

Safety: the mutated file is snapshotted in memory and restored in a `finally`
block, so a crash cannot leave a mutated source tree. It never runs git commands
that could discard unrelated work.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Each row: enforcement path, file, unique text to replace, replacement.
#
# Mutations run against the WHOLE agent suite, not one file. Picking a suite per
# path invites a mapping error — session 171 pointed E-EFFECTIVENESS at the BCD
# module's tests while the mutated aggregator lived in agent.py, so a bad mapping
# masqueraded as a test gap. The operational question is "would the suite notice
# this regression?", and the suite is all of it.
MUTATIONS: list[dict] = [
    {
        "path": "E-DECRYPT",
        "file": "agent/agent.py",
        "old": "            decrypted = fernet.decrypt(data)",
        "new": "            decrypted = data  # MUTATION: skip decryption",
        "why": "decryption becomes a no-op (ciphertext written back as plaintext)",
    },
    {
        "path": "E-ACK",
        "file": "agent/agent.py",
        "old": '    state = {\n        "command_id": command_id,',
        "new": '    return  # MUTATION: never persist the pending ACK\n    state = {\n        "command_id": command_id,',
        "why": "the pending ACK is never written, so a lost ACK cannot be retried",
    },
    {
        "path": "E-EFFECTIVENESS",
        "file": "agent/agent.py",
        "old": '        bcd_crit = bcd_result.get("critical_applied", 0) if bcd_result else 0',
        "new": "        bcd_crit = 1  # MUTATION: always claim critical controls applied",
        "hint": "aggregator in agent.py; covered by test_agent_ack_recovery/_encryption",
        "why": "critical_applied=0 is reported as success (the gap this path exists to close)",
    },
    {
        "path": "E-OFFLINE-QUEUE",
        "file": "agent/agent.py",
        "old": '    """Queue a request for later delivery when the server is unreachable."""',
        "new": '    """Queue a request for later delivery when the server is unreachable."""\n    return  # MUTATION: never queue anything',
        "why": "offline requests are dropped instead of queued",
    },
    {
        "path": "E-TRACK",
        "file": "agent/agent.py",
        "old": "    networks = []\n    system = platform.system()",
        "new": "    networks = []\n    return networks  # MUTATION: never scan\n    system = platform.system()",
        "why": "WiFi scan returns nothing, so covert tracking reports no neighbours",
    },
    {
        "path": "E-DEADMAN",
        "file": "agent/agent.py",
        "old": '        if state.get("status") != "stolen":\n            return',
        "new": '        if True:  # MUTATION: never evaluate the deadman switch\n            return',
        "why": "the deadman switch can never fire",
    },
    {
        "path": "E-RECOVERY",
        "file": "agent/agent.py",
        "old": "        decrypt_folder(folder, key)",
        "new": "        pass  # MUTATION: skip decryption on recovery",
        "why": "recovery reports success but leaves the files encrypted",
    },
    {
        "path": "E-BCD",
        "file": "agent/bcd_lockdown.py",
        "old": "    if setting in BOOTMGR_SCOPED_SETTINGS:\n        return _set_bcd_setting_bootmgr(setting, value)\n    return _set_bcd_setting(setting, value)",
        "new": "    return True  # MUTATION: claim every BCD setting applied",
        "why": "no bcdedit command runs, but the lockdown reports the setting applied",
    },
    {
        "path": "E-HP-UEFI",
        "file": "agent/hp_uefi_lockdown.py",
        "old": "    # Phase 4.1: Admin check — fail-fast before any state writes\n    if not _is_admin():",
        "new": "    # Phase 4.1: Admin check — fail-fast before any state writes\n    if False:  # MUTATION: skip the admin fail-fast",
        "hint": "aggregator in agent.py; covered by test_agent_ack_recovery/_encryption",
        "why": "the admin check no longer fails fast before state writes",
    },
    {
        "path": "E-AUTO-UPDATE",
        "file": "agent/agent.py",
        "old": "    if not signature_b64:\n        return False",
        "new": "    if True:  # MUTATION: accept any update\n        return True",
        "why": "any update is accepted without a signature",
    },
]


def repo_path(rel: str) -> Path:
    """Resolve a table path and refuse anything outside the repository.

    The table is a module constant, so this is defence against a future edit
    rather than against input: a row with `..` must not be able to make this
    script rewrite a file outside the tree.
    """
    target = (REPO / rel).resolve()
    if not target.is_relative_to(REPO):
        raise SystemExit(f"refusing path outside the repo: {rel}")
    return target


def run_suite(suite: str = "tests/") -> tuple[bool | None, str]:
    """Run the suite. Returns (passed, summary); None means the run was invalid.

    Two traps this guards against, both found the hard way in session 171:
      * `scripts/run-agent-tests.sh` does `cd agent` and always passes `tests/`,
        so a repo-relative path never resolves — the first version of this audit
        reported ten "KILLED" that were all collection errors;
      * pytest exits non-zero when it cannot find a file, so "the command failed"
        is not evidence that a test failed. A run only counts when the summary
        line shows tests were actually executed.
    """
    agent_dir = REPO / "agent"
    venv_py = agent_dir / ".venv" / "bin" / "python"
    py = str(venv_py) if venv_py.exists() else "python3"
    proc = subprocess.run(
        [py, "-m", "pytest", suite, "-x", "-q"],
        cwd=agent_dir, capture_output=True, text=True, timeout=900,
    )
    out = proc.stdout + proc.stderr
    lines = [ln for ln in out.strip().splitlines() if ln.strip()]
    summary = lines[-1][:90] if lines else "(no output)"

    # Use pytest's exit code, not the summary text: with `-x` a genuine failure
    # prints "stopping after 1 failures" and no "N failed" line, so text matching
    # read a caught mutation as an invalid run (session 171, twice).
    #   0 passed | 1 tests failed | 2 interrupted | 3 internal | 4 usage | 5 none collected
    if "file or directory not found" in out or "errors during collection" in out:
        return None, summary
    if proc.returncode in (0, 1):
        return proc.returncode == 0, summary
    return None, summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--path", help="only this enforcement path")
    ap.add_argument("--list", action="store_true", help="print the mutation table and exit")
    args = ap.parse_args()

    table = [m for m in MUTATIONS if not args.path or m["path"] == args.path]
    if not table:
        print(f"no mutation for {args.path!r}", file=sys.stderr)
        return 2

    if args.list:
        for m in table:
            print(f"{m['path']:16} {m['file']:32} {m['why']}")
        return 0

    survivors = []
    invalid = []
    for m in table:
        target = repo_path(m["file"])
        original = target.read_text()
        hits = original.count(m["old"])
        if hits != 1:
            print(f"{m['path']:16} SKIPPED — anchor matched {hits} times in {m['file']}")
            continue
        try:
            target.write_text(original.replace(m["old"], m["new"], 1))
            passed, summary = run_suite()
        finally:
            target.write_text(original)

        if passed is None:
            invalid.append(m)
            verdict = "INVALID"
        elif passed:
            survivors.append(m)
            verdict = "SURVIVED"
        else:
            verdict = "KILLED"
        print(f"{m['path']:16} {verdict:9} {summary}")

    print()
    if invalid:
        print(f"{len(invalid)} of {len(table)} runs were INVALID — pytest did not "
              f"execute the suite, so the mutation was neither caught nor missed:")
        for m in invalid:
            print(f"  {m['path']}: {m.get('hint', m['file'])}")
        print()
    if survivors:
        print(f"{len(survivors)} of {len(table)} mutations SURVIVED — these suites do not "
              f"test the behaviour they are credited with:")
        for m in survivors:
            print(f"  {m['path']}: {m['why']}")
        print("\n  the full agent suite passed with these defects reintroduced:")
        return 1
    if invalid:
        return 1
    print(f"all {len(table)} mutations killed — every audited suite has teeth")
    return 0


if __name__ == "__main__":
    sys.exit(main())
