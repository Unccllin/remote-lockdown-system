#!/usr/bin/env bash
# run-agent-tests.sh — run the agent pytest suite with the interpreter that has
# the dev dependencies installed.
#
# Why this exists (S141): agent/pyproject.toml sets
#   addopts = "-q --timeout=30"
# which requires pytest-timeout. The dev dependencies live in agent/.venv
# (see AGENTS.md), but every documented command used the system interpreter:
#   npm test            -> cd agent && python3 -m pytest tests/ -v
#   make test-agent     -> cd agent && python3 -m pytest tests/ -q
# On a machine without pytest-timeout in the system Python both fail with
#   ERROR: python -m pytest: error: unrecognized arguments: --timeout=30
# so the documented "clean sweep" never reached the agent suite. This wrapper
# is the single place that picks the interpreter; callers pass pytest flags.
#
# Usage:
#   scripts/run-agent-tests.sh                # -q from pyproject addopts
#   scripts/run-agent-tests.sh -v
#   scripts/run-agent-tests.sh --cov=. --cov-report=term
#
# Exit code: pytest's exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENT_DIR="$PROJECT_ROOT/agent"

YELLOW='\033[1;33m'; NC='\033[0m'

if [ ! -d "$AGENT_DIR" ]; then
  echo "[FAIL] agent directory not found at $AGENT_DIR" >&2
  exit 2
fi

VENV_PY="$AGENT_DIR/.venv/bin/python"
if [ -x "$VENV_PY" ]; then
  PY="$VENV_PY"
else
  PY="$(command -v python3 || true)"
  if [ -z "$PY" ]; then
    echo "[FAIL] neither agent/.venv/bin/python nor python3 is available" >&2
    exit 2
  fi
  printf "${YELLOW}[..]${NC} agent/.venv not found — falling back to %s\n" "$PY" >&2
  printf "${YELLOW}[..]${NC} If pytest reports 'unrecognized arguments: --timeout', install the dev deps:\n" >&2
  printf "      python3 -m venv agent/.venv && agent/.venv/bin/pip install -r agent/requirements-dev.txt\n" >&2
fi

cd "$AGENT_DIR" || exit 2
exec "$PY" -m pytest tests/ "$@"
