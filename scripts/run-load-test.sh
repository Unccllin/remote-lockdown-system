#!/usr/bin/env bash
#
# run-load-test.sh — Runner for k6 load test scenarios.
#
# Usage:
#   scripts/run-load-test.sh --scenario baseline
#   scripts/run-load-test.sh --scenario lockdown --url http://localhost:3001 --vus 500 --duration 1m
#   scripts/run-load-test.sh --scenario all
#
# Options:
#   --scenario <baseline|lockdown|mixed|all>  Which test to run (default: baseline)
#   --url <server-url>                        Target server (default: http://localhost:3001)
#   --vus <count>                             Override VU count (K6_VUS env var)
#   --duration <time>                         Override duration (K6_DURATION env var)
#   --agent-key <key>                         Agent API key (K6_AGENT_KEY env var)
#   --admin-token <token>                     Admin bearer token (K6_ADMIN_TOKEN env var)
#   -h, --help                                Show this help message
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOAD_DIR="${REPO_ROOT}/tests/load"

# Defaults
SCENARIO="baseline"
URL="http://localhost:3001"
VUS=""
DURATION=""
AGENT_KEY=""
ADMIN_TOKEN=""

usage() {
  cat <<'EOF'
run-load-test.sh — Run k6 load test scenarios for the remote-lockdown-system.

Usage:
  scripts/run-load-test.sh --scenario baseline
  scripts/run-load-test.sh --scenario lockdown --url http://localhost:3001 --vus 500 --duration 1m
  scripts/run-load-test.sh --scenario all

Options:
  --scenario <baseline|lockdown|mixed|all>  Which test to run (default: baseline)
  --url <server-url>                        Target server (default: http://localhost:3001)
  --vus <count>                             Override VU count (K6_VUS env var)
  --duration <time>                         Override duration (K6_DURATION env var)
  --agent-key <key>                         Agent API key (K6_AGENT_KEY env var)
  --admin-token <token>                     Admin bearer token (K6_ADMIN_TOKEN env var)
  -h, --help                                Show this help message

Environment variables (passed through to k6 scripts):
  K6_VUS, K6_DURATION, K6_BASE_URL, K6_AGENT_KEY, K6_ADMIN_TOKEN, K6_POLL_INTERVAL

Prerequisites:
  - k6 installed (https://k6.io)
  - A running server reachable at --url
  - Test devices registered and (for lockdown) pending commands queued
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      SCENARIO="$2"; shift 2 ;;
    --url)
      URL="$2"; shift 2 ;;
    --vus)
      VUS="$2"; shift 2 ;;
    --duration)
      DURATION="$2"; shift 2 ;;
    --agent-key)
      AGENT_KEY="$2"; shift 2 ;;
    --admin-token)
      ADMIN_TOKEN="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

# Validate scenario
case "$SCENARIO" in
  baseline|lockdown|mixed|all) ;;
  *)
    echo "Invalid scenario: ${SCENARIO}" >&2
    echo "Valid scenarios: baseline, lockdown, mixed, all" >&2
    exit 2
    ;;
esac

# Check k6 is installed
if ! command -v k6 >/dev/null 2>&1; then
  echo "ERROR: k6 is not installed." >&2
  echo "" >&2
  echo "Install k6:" >&2
  echo "  Linux (Debian/Ubuntu):" >&2
  echo "    sudo gpg -k" >&2
  echo "    sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A36442D57D35B459D764BB1C0" >&2
  echo "    echo 'deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main' | sudo tee /etc/apt/sources.list.d/k6.list" >&2
  echo "    sudo apt-get update && sudo apt-get install k6" >&2
  echo "" >&2
  echo "  macOS (Homebrew):  brew install k6" >&2
  echo "  Windows (choco):   choco install k6" >&2
  echo "  Docker:            docker run --rm -i grafana/k6 run -<" >&2
  echo "  See: https://k6.io/docs/get-started/installation/" >&2
  exit 1
fi

echo "=== Load Test Runner ==="
echo "Scenario: ${SCENARIO}"
echo "Target:   ${URL}"
echo "k6:       $(k6 version 2>/dev/null || echo 'unknown')"
echo ""

# Build environment exports
export K6_BASE_URL="$URL"
[[ -n "$VUS" ]] && export K6_VUS="$VUS"
[[ -n "$DURATION" ]] && export K6_DURATION="$DURATION"
[[ -n "$AGENT_KEY" ]] && export K6_AGENT_KEY="$AGENT_KEY"
[[ -n "$ADMIN_TOKEN" ]] && export K6_ADMIN_TOKEN="$ADMIN_TOKEN"

run_one() {
  local script="$1"
  local name="$2"
  if [[ ! -f "$script" ]]; then
    echo "ERROR: script not found: $script" >&2
    exit 1
  fi
  echo "------------------------------------------------------------"
  echo "Running: ${name}"
  echo "Script:  ${script}"
  echo "------------------------------------------------------------"
  if k6 run "$script"; then
    echo ""
    echo "[${name}] PASS — thresholds met."
    return 0
  else
    local rc=$?
    echo ""
    echo "[${name}] FAIL (exit ${rc}) — one or more thresholds were breached or errors occurred." >&2
    return $rc
  fi
}

declare -a SCENARIOS_TO_RUN
case "$SCENARIO" in
  all)
    SCENARIOS_TO_RUN=("baseline" "lockdown" "mixed") ;;
  *)
    SCENARIOS_TO_RUN=("$SCENARIO") ;;
esac

declare -A SCRIPT_MAP=(
  [baseline]="${LOAD_DIR}/k6-baseline.js"
  [lockdown]="${LOAD_DIR}/k6-lockdown-spike.js"
  [mixed]="${LOAD_DIR}/k6-mixed.js"
)

OVERALL_RC=0
for s in "${SCENARIOS_TO_RUN[@]}"; do
  if ! run_one "${SCRIPT_MAP[$s]}" "$s"; then
    OVERALL_RC=1
  fi
done

echo ""
echo "=== Load Test Summary ==="
if [[ "$OVERALL_RC" -eq 0 ]]; then
  echo "All requested scenarios passed their thresholds."
else
  echo "One or more scenarios FAILED. Review the output above." >&2
fi
exit "$OVERALL_RC"
