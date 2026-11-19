#!/usr/bin/env bash
# lint-graph.sh — ruff over .devin/graph, the code that enforces every graph invariant.
#
# Why this exists (S328): `graph_assert.py` decides whether I1-I7 pass, and no gate in this repo read
# it. ruff governed `agent/`, eslint the JS components, `tsc` the worker — so the checker was the one
# unlinted file in the tree, and it had accumulated 9 mechanical findings.
#
# The rule set is deliberately narrower than agent/ruff.toml: that config selects S (security) and
# per-file ignores tuned for code shipped to a device. This is a build-time script, so E/W/F/I/UP at
# line-length 100 is the honest bar — style and correctness rules that cannot change behaviour.
#
# Usage: scripts/lint-graph.sh            # check only
#        scripts/lint-graph.sh --fix      # apply the safe autofixes
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$PROJECT_ROOT/.devin/graph"
VENV_PY="$PROJECT_ROOT/agent/.venv/bin/python"

PY=""
if [ -x "$VENV_PY" ] && "$VENV_PY" -m ruff --version >/dev/null 2>&1; then
    PY="$VENV_PY"
elif command -v ruff >/dev/null 2>&1; then
    PY=""
elif python3 -m ruff --version >/dev/null 2>&1; then
    PY="python3"
else
    echo "ERROR: ruff is not installed (agent/.venv, PATH, or system python)." >&2
    echo "       Install it with: agent/.venv/bin/pip install -r agent/requirements-dev.txt" >&2
    exit 2
fi

run() {
    if [ -n "$PY" ]; then "$PY" -m ruff "$@"; else ruff "$@"; fi
}

echo "=== graph lint (ruff: E,W,F,I,UP at 100) ==="
if ! run check --select E,W,F,I,UP --line-length 100 --no-cache "$TARGET"; then
    echo "[FAIL] ruff check reported findings in .devin/graph" >&2
    exit 1
fi
echo "[OK] ruff check clean"
