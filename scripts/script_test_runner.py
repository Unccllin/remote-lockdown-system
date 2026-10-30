"""Shared runner for the ``scripts/test_*.py`` suites.

Why this exists
---------------
``make test-scripts`` executes every ``scripts/test_*.py`` **directly**, and the
repo has now lost real test coverage to the same mistake twice: a module that
defines pytest tests but has no ``__main__`` block imports them, runs none, and
exits 0. `scripts/test_memory.py` did that for 44 tests (recorded in AGENTS.md),
and `scripts/test_ci_annotate.py` did it again for 13 tests added in session 150
— invisible, because both looked green.

So the runner lives in one place instead of being copy-pasted into each suite:

    if __name__ == "__main__":
        from script_test_runner import run

        raise SystemExit(run(__file__))

Two details that matter:

* ``pytest`` is imported dynamically. These scripts live in ``scripts/``, where
  pytest is not on the import path — it is installed in ``agent/.venv`` — so a
  top-level import would be reported unresolved by a static analyser even
  though ``make test-scripts`` picks the venv interpreter.
* A missing pytest is a **failure** (exit 2), not a silent pass. This harness
  exists because "green while running nothing" was the failure mode.

This file is deliberately *not* named ``test_*.py``: the auto-discover loop in
the Makefile would try to run it as a suite.
"""

from __future__ import annotations

import importlib
import sys


def run(path: str) -> int:
    """Run *path* under pytest and return its exit status."""
    try:
        pytest = importlib.import_module("pytest")
    except ImportError:
        print(
            "ERROR: pytest is required to run this suite "
            "(use agent/.venv/bin/python or `make test-scripts`)",
            file=sys.stderr,
        )
        return 2
    # pytest.main returns an int (or an IntEnum ExitCode); no conversion needed.
    return pytest.main([path, "-q"])


if __name__ == "__main__":
    print("this module is a helper; run a scripts/test_*.py suite instead")
    raise SystemExit(2)
