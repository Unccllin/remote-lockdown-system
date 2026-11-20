#!/usr/bin/env python3
"""Tests for scripts/brain.py — the evidence-tagged belief store.

The brain is the project's *semantic* memory: the layer that decides what may be
cited as hardware-verified versus merely assumed. Until S342 it had no tests at
all, while `memory.py` next to it had 44 — and both share the same write shape
(read store, mutate, atomic_write), which is where the defect was:

  * `atomic_write()` renames a temporary file into place, so a reader never sees a
    torn file. It does **not** stop a *lost update*: two concurrent `assert` calls
    both read the store, both compute the next id from max-id, and the second
    rename discards the first belief. Observed in S341 — two asserts issued in one
    parallel tool block both printed `[OK] Asserted B-186`, and only the second
    statement survived in `beliefs.yaml`.

So the properties worth locking are the ones that were silently false:
  * N concurrent asserts keep N beliefs, with N distinct ids,
  * ids are max+1 (never reused, never colliding),
  * the store is still structurally valid after a concurrent round,
  * the lock is a file, not a process-local mutex — every invocation is its own
    process, so a threading.Lock would pass here and change nothing in reality.

Every test runs the real CLI against a throwaway repo: `brain.py` resolves its
store from `__file__`, so a copy of the script in a temp tree gets its own store
and nothing here can touch `.devin/brain/`.

Written in the hand-rolled style of scripts/test_prepush_secrets.py (a `check()`
counter, no pytest import) so it runs under any interpreter — the concurrency test
spawns real subprocesses, which is the only thing it needs.

Run: python3 scripts/test_brain.py
"""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

_SCRIPTS_DIR = Path(__file__).resolve().parent
BRAIN_SCRIPT = _SCRIPTS_DIR / "brain.py"

# Enough writers that the read-modify-write windows overlap reliably; the store is
# small, so each round is fast.
CONCURRENT_WRITERS = 12

FAILED: list[str] = []


def check(name: str, condition, detail: str = "") -> None:
    if condition:
        print(f"  ✓ {name}")
    else:
        print(f"  ✗ {name} {detail}")
        FAILED.append(name)


def make_repo() -> tuple[Path, Path]:
    """Create a throwaway repo root holding a copy of brain.py.

    Returns (repo_root, brain_dir). brain.py derives its store from __file__, so
    running the copy writes to the temp tree instead of this project's beliefs.
    """
    root = Path(tempfile.mkdtemp(prefix="brain-test-"))
    (root / "scripts").mkdir()
    shutil.copy2(BRAIN_SCRIPT, root / "scripts" / "brain.py")
    return root, root / ".devin" / "brain"


def brain_cmd(root: Path) -> list[str]:
    return [sys.executable, str(root / "scripts" / "brain.py")]


def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        brain_cmd(root) + list(args),
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"brain.py {args} failed:\n{proc.stdout}{proc.stderr}"
    return proc


def spawn(root: Path, *args: str) -> subprocess.Popen:
    return subprocess.Popen(
        brain_cmd(root) + list(args),
        cwd=root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def beliefs(brain_dir: Path) -> list[dict]:
    data = yaml.safe_load((brain_dir / "beliefs.yaml").read_text())
    return data["beliefs"]


def belief_ids(brain_dir: Path) -> list[str]:
    return [b["id"] for b in beliefs(brain_dir)]


def test_sequential_asserts_allocate_max_plus_one():
    root, brain_dir = make_repo()
    run(root, "init")
    run(root, "assert", "--statement", "first")
    run(root, "assert", "--statement", "second")
    run(root, "assert", "--statement", "third")
    ids = belief_ids(brain_dir)
    check(
        "three sequential asserts are B-001..B-003",
        ids == ["B-001", "B-002", "B-003"],
        str(ids),
    )


def test_concurrent_asserts_keep_every_belief():
    """S341's defect: the last writer's rename discarded another writer's belief.

    Without the store lock this loses beliefs — measured by removing the
    `@mutating` decorator, which reproduces both the duplicate id and the short
    store (see docs/artifacts/s342-brain-store-lock.txt).
    """
    root, brain_dir = make_repo()
    run(root, "init")

    procs = [
        spawn(root, "assert", "--statement", f"concurrent belief {i}")
        for i in range(CONCURRENT_WRITERS)
    ]
    results = [(p.wait(timeout=120), p.communicate()) for p in procs]
    failures = [(code, out[0] + out[1]) for code, out in results if code != 0]
    check("every concurrent assert exited 0", not failures, str(failures[:2])[:300])

    ids = belief_ids(brain_dir)
    check(
        f"{CONCURRENT_WRITERS} concurrent asserts keep {CONCURRENT_WRITERS} beliefs",
        len(ids) == CONCURRENT_WRITERS,
        f"store holds {len(ids)}: {ids} — a write was lost",
    )
    check(
        "every concurrent id is distinct",
        len(set(ids)) == CONCURRENT_WRITERS,
        f"ids collided: {sorted(ids)}",
    )
    statements = {b["statement"] for b in beliefs(brain_dir)}
    check(
        "every statement survived",
        statements == {f"concurrent belief {i}" for i in range(CONCURRENT_WRITERS)},
        f"missing: {sorted({f'concurrent belief {i}' for i in range(CONCURRENT_WRITERS)} - statements)}",
    )


def test_store_is_still_valid_after_a_concurrent_round():
    root, brain_dir = make_repo()
    run(root, "init")
    procs = [
        spawn(root, "assert", "--statement", f"belief {i}")
        for i in range(CONCURRENT_WRITERS)
    ]
    for p in procs:
        p.wait(timeout=120)

    # `check` exits 0 only when the store parses and every confirmed belief carries
    # evidence + provenance; a truncated or interleaved file would fail here.
    proc = subprocess.run(
        brain_cmd(root) + ["check"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    check(
        "brain.py check passes after the race", proc.returncode == 0, proc.stdout[-300:]
    )
    leftovers = list(brain_dir.glob("*.tmp"))
    check("no temporary store file is left behind", not leftovers, str(leftovers))


def test_the_store_lock_is_a_file_beside_the_store():
    """A process-local mutex would pass the tests above and fix nothing in reality."""
    root, brain_dir = make_repo()
    run(root, "init")
    run(root, "assert", "--statement", "creates the lock file")
    check("the lock is a file in the brain dir", (brain_dir / ".beliefs.lock").exists())


def test_confirm_still_promotes_a_belief_under_the_lock():
    """The decorator must not break the commands it wraps."""
    root, brain_dir = make_repo()
    run(root, "init")
    run(root, "assert", "--statement", "the worker sorts newest first")
    run(
        root,
        "confirm",
        "--id",
        "B-001",
        "--evidence-level",
        "code-read",
        "--provenance",
        "serverless/worker.ts:1064",
    )
    belief = beliefs(brain_dir)[0]
    check(
        "confirm promotes the belief",
        belief["status"] == "confirmed",
        str(belief["status"]),
    )
    check(
        "confirm records the evidence level",
        belief["evidence_level"] == "code-read",
        str(belief["evidence_level"]),
    )


def test_a_refusal_inside_the_lock_does_not_strand_it():
    """sys.exit() runs inside the `with store_lock()`: the lock must be released.

    The reachable refusal is a missing belief, not a missing argument — argparse
    already declares confirm's --evidence-level/--provenance and refute's
    --replacement as required, so the in-command `[ERROR] a missing --x` branches
    are unreachable from the CLI (noted in S342's trace). What matters here is that
    the error path leaves the store usable for the next writer.
    """
    root, brain_dir = make_repo()
    run(root, "init")
    run(root, "assert", "--statement", "x")

    proc = subprocess.run(
        brain_cmd(root)
        + [
            "confirm",
            "--id",
            "B-999",
            "--evidence-level",
            "code-read",
            "--provenance",
            "p",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    check(
        "confirming a missing belief exits 1 inside the lock",
        proc.returncode == 1 and "not found" in proc.stdout,
        f"rc={proc.returncode} out={proc.stdout[-200:]}",
    )

    # If the lock were stranded, this write would block (or the round would lose it).
    run(root, "assert", "--statement", "written after a refusal")
    ids = belief_ids(brain_dir)
    check(
        "the next writer still gets its own id",
        ids == ["B-001", "B-002"],
        str(ids),
    )


def test_a_refuted_belief_gets_a_replacement_under_the_lock():
    """refute is the one command that allocates an id AND mutates another record."""
    root, brain_dir = make_repo()
    run(root, "init")
    run(root, "assert", "--statement", "the old claim")
    run(root, "refute", "--id", "B-001", "--replacement", "the corrected claim")
    records = beliefs(brain_dir)
    by_id = {b["id"]: b for b in records}
    check(
        "refute keeps both records", len(records) == 2, str([b["id"] for b in records])
    )
    check("the original is refuted", by_id["B-001"]["status"] == "refuted")
    check("the replacement supersedes it", by_id["B-002"].get("supersedes") == "B-001")
    check(
        "the original points at its replacement",
        by_id["B-001"].get("superseded_by") == "B-002",
    )


def test_a_platform_without_any_lock_primitive_refuses_to_run():
    """Silently running unlocked is worse than refusing: it loses a writer's belief.

    The Windows branch is resolved through getattr, so a renamed msvcrt symbol would
    otherwise degrade to "no lock" with no signal at all. Exercised through a driver
    script in a temp tree rather than by importing brain.py into this process: the guard
    has to hold for a REAL invocation, and a fresh interpreter is the honest test of that.
    """
    root = Path(tempfile.mkdtemp(prefix="brain-nolock-"))
    driver = root / "probe.py"
    driver.write_text(
        "import importlib.util, pathlib, sys\n"
        f"spec = importlib.util.spec_from_file_location('b', {str(BRAIN_SCRIPT)!r})\n"
        "brain = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(brain)\n"
        "brain.BRAIN_DIR = pathlib.Path(sys.argv[1])\n"
        "brain.LOCK_FILE = brain.BRAIN_DIR / '.beliefs.lock'\n"
        "brain.fcntl = None\n"
        "brain._msvcrt_locking = None\n"
        "with brain.store_lock():\n"
        "    print('ENTERED_UNLOCKED')\n"
    )
    proc = subprocess.run(
        [sys.executable, str(driver), str(root)], capture_output=True, text=True, check=False
    )
    combined = proc.stdout + proc.stderr
    check(
        "refuses to run with no lock primitive",
        proc.returncode != 0 and "ENTERED_UNLOCKED" not in combined,
        f"rc={proc.returncode} out={combined[-200:]}",
    )
    check(
        "and says why",
        "refusing to run unlocked" in combined,
        combined[-200:],
    )


if __name__ == "__main__":
    print("=== test_brain.py ===")
    tests = [
        (n, f)
        for n, f in sorted(globals().items())
        if n.startswith("test_") and callable(f)
    ]
    print(f"    {len(tests)} tests discovered")
    if not tests:
        # S319: `if FAILED` alone reports success when discovery finds nothing.
        print("  NO TESTS DISCOVERED — discovery is broken; refusing to report success")
        sys.exit(1)
    print()
    for _name, _fn in tests:
        _fn()
    print()
    if FAILED:
        print(f"  {len(FAILED)} check(s) FAILED: {', '.join(FAILED)}")
        sys.exit(1)
    print("  all checks passed")
    sys.exit(0)
