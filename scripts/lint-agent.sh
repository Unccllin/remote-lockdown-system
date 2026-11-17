#!/usr/bin/env bash
# lint-agent.sh — run ruff (check + format check) with an interpreter that has it.
#
# Why this exists: the Makefile target ran `python3 -m ruff`, and on a host without ruff
# installed for the system interpreter `make full-verify` died at that step with
# "No module named ruff" — after `graph-check` had passed, so the sweep stopped one target
# in and reported nothing about the rest (S271). The same shape as run-agent-tests.sh: pick
# the interpreter once, and fail loudly when the tool is genuinely absent.
#
# The version matters as much as the presence: ruff 0.5.0 (what agent/requirements-dev.txt
# used to pin) reports 6 findings in agent/agent.py that 0.17.5 does not — a pin that
# disagrees with CI is how "green there, red here" happens. requirements-dev.txt now pins
# the gate version and CI installs from it.
#
# Usage: scripts/lint-agent.sh            # check + format check
#        scripts/lint-agent.sh --check   # check only
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/agent"
VENV_PY="$AGENT_DIR/.venv/bin/python"

PY=""
if [ -x "$VENV_PY" ] && "$VENV_PY" -m ruff --version >/dev/null 2>&1; then
    PY="$VENV_PY"
elif command -v ruff >/dev/null 2>&1; then
    PY=""
elif python3 -m ruff --version >/dev/null 2>&1; then
    PY="python3"
else
    echo "[FAIL] ruff is not installed for the venv, on PATH, or for python3." >&2
    echo "       Install it: agent/.venv/bin/pip install -r agent/requirements-dev.txt" >&2
    exit 2
fi

run_ruff() {
    if [ -z "$PY" ]; then
        ruff "$@"
    else
        "$PY" -m ruff "$@"
    fi
}

cd "$AGENT_DIR" || exit 2
if [ "${1:-}" = "--format-only" ]; then
    # `make format-check` delegates here for the same interpreter resolution; it used to
    # carry its own `python3 -m ruff` line, which is the bug this script exists to remove.
    run_ruff format --check . tests/ || exit 1
    echo "[OK] ruff format clean"
    exit 0
fi
run_ruff check . tests/ || exit 1
if [ "${1:-}" = "--check" ]; then
    exit 0
fi
run_ruff format --check . tests/ || exit 1
echo "[OK] ruff check + format clean"
