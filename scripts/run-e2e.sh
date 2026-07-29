#!/usr/bin/env bash
#
# Phase 7: E2E test runner for the Remote Lockdown System.
#
# Runs the API-level end-to-end tests in tests/e2e/ against a real Express
# app backed by an isolated SQLite temp database (no external services).
#
# Usage:
#   scripts/run-e2e.sh                       # run all E2E suites
#   scripts/run-e2e.sh --suite lockdown      # run only the lockdown flow
#   scripts/run-e2e.sh --suite recovery      # run only the recovery flow
#   scripts/run-e2e.sh --agent-integration   # include the real-agent integration suite
#   scripts/run-e2e.sh --verbose             # show full test output
#   scripts/run-e2e.sh --suite all --verbose
#
# Exit code: 0 if all tests pass, 1 if any fail.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Locate the repo root (this script lives in <repo>/scripts/).
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SUITE="all"
VERBOSE=0
AGENT_INTEGRATION=0
EXTRA_JEST_ARGS=()

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --suite <all|lockdown|recovery>   Which E2E suite to run (default: all)
  --agent-integration               Include the real-agent integration suite
                                    (tests/e2e/agent-integration.test.js).
                                    Requires python3 + cryptography + requests.
  --verbose                         Show full test output (jest --verbose)
  --help, -h                        Show this help message

Examples:
  $(basename "$0") --suite lockdown
  $(basename "$0") --suite all --verbose
  $(basename "$0") --agent-integration
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --suite)
      SUITE="$2"
      shift 2
      ;;
    --suite=*)
      SUITE="${1#*=}"
      shift
      ;;
    --agent-integration)
      AGENT_INTEGRATION=1
      shift
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_JEST_ARGS+=("$@")
      break
      ;;
    *)
      # Forward unknown flags to jest (e.g. --testPathPattern, --ci).
      EXTRA_JEST_ARGS+=("$1")
      shift
      ;;
  esac
done

# Validate suite selection.
case "${SUITE}" in
  all)
    TEST_MATCH='["<rootDir>/tests/e2e/*.test.js"]'
    SUITE_LABEL="all E2E suites"
    ;;
  lockdown)
    TEST_MATCH='["<rootDir>/tests/e2e/lockdown-flow.test.js"]'
    SUITE_LABEL="lockdown flow"
    ;;
  recovery)
    TEST_MATCH='["<rootDir>/tests/e2e/recovery-flow.test.js"]'
    SUITE_LABEL="recovery flow"
    ;;
  *)
    echo "ERROR: unknown suite '${SUITE}' (expected: all|lockdown|recovery)" >&2
    usage >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# --agent-integration: append the real-agent integration suite to the test
# match list. This is opt-in because it spawns a Python subprocess and
# requires python3 + cryptography + requests to be installed.
# ---------------------------------------------------------------------------
if [[ "${AGENT_INTEGRATION}" -eq 1 ]]; then
  # If a specific suite was selected (not "all"), append the integration
  # suite alongside it. If "all" was selected, the glob already covers it,
  # but we add it explicitly so it's always included even if the glob is
  # narrowed later.
  if [[ "${SUITE}" == "all" ]]; then
    TEST_MATCH='["<rootDir>/tests/e2e/*.test.js"]'
    SUITE_LABEL="all E2E suites + agent integration"
  else
    # Convert the single-element array literal to a two-element one.
    EXISTING_MATCH="${TEST_MATCH%]*}"
    TEST_MATCH="${EXISTING_MATCH}, \"<rootDir>/tests/e2e/agent-integration.test.js\"]"
    SUITE_LABEL="${SUITE_LABEL} + agent integration"
  fi
fi

# ---------------------------------------------------------------------------
# Locate jest. The server package owns the jest/supertest dev dependencies.
# ---------------------------------------------------------------------------
JEST_BIN="${REPO_ROOT}/server/node_modules/.bin/jest"
if [[ ! -x "${JEST_BIN}" ]]; then
  echo "ERROR: jest not found at ${JEST_BIN}" >&2
  echo "       Run 'cd server && npm install' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build an inline jest config.
#
# - rootDir = repo root (so testMatch resolves tests/e2e/*.test.js)
# - moduleDirectories includes server/node_modules so test files can resolve
#   'supertest', 'express', 'sqlite3', etc. without a root-level node_modules.
# - maxWorkers=1: each test file bootstraps its own SQLite singleton; serial
#   execution keeps output readable and avoids native-module load races.
# ---------------------------------------------------------------------------
JEST_CONFIG=$(cat <<EOF
{
  "testEnvironment": "node",
  "rootDir": "${REPO_ROOT}",
  "testMatch": ${TEST_MATCH},
  "moduleDirectories": ["node_modules", "server/node_modules"],
  "maxWorkers": 1,
  "forceExit": true,
  "detectOpenHandles": true
}
EOF
)

JEST_ARGS=(--config "${JEST_CONFIG}")
if [[ "${VERBOSE}" -eq 1 ]]; then
  JEST_ARGS+=(--verbose)
fi
if [[ ${#EXTRA_JEST_ARGS[@]} -gt 0 ]]; then
  JEST_ARGS+=("${EXTRA_JEST_ARGS[@]}")
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "============================================================"
echo "  Remote Lockdown System — E2E tests"
echo "  Suite:   ${SUITE_LABEL}"
echo "  Repo:    ${REPO_ROOT}"
echo "  Verbose: $( [[ ${VERBOSE} -eq 1 ]] && echo yes || echo no )"
echo "  Agent:   $( [[ ${AGENT_INTEGRATION} -eq 1 ]] && echo included || echo excluded )"
echo "============================================================"

set +e
"${JEST_BIN}" "${JEST_ARGS[@]}"
JEST_EXIT=$?
set -e

echo "------------------------------------------------------------"
if [[ ${JEST_EXIT} -eq 0 ]]; then
  echo "  RESULT: PASS (all E2E tests succeeded)"
else
  echo "  RESULT: FAIL (one or more E2E tests failed; exit ${JEST_EXIT})"
fi
echo "------------------------------------------------------------"

exit "${JEST_EXIT}"
