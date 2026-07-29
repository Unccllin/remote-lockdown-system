#!/usr/bin/env bash
# Master Orchestrator — Remote Lockdown Production Readiness
#
# Manages phase execution, spawns subagents, checks on them, and enforces
# test gates. Subagents do not context-switch: if a new task appears while
# a subagent is working, a new subagent is spawned for the new task.
#
# Usage:
#   ./orchestrator.sh <phase-number>           # Run a single phase
#   ./orchestrator.sh all                       # Run all phases in dependency order
#   ./orchestrator.sh status                    # Show status of all phases
#   ./orchestrator.sh test <phase-number>       # Run tests for a phase only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PHASES_DIR="$SCRIPT_DIR/phases"
TASK_QUEUE_DIR="$SCRIPT_DIR/task-queue"
RESULTS_DIR="$SCRIPT_DIR/results"

mkdir -p "$TASK_QUEUE_DIR" "$RESULTS_DIR"

# Phase dependency graph
declare -A PHASE_DEPS=(
  [0]=""
  [1]=""
  [2]=""
  [3]="0 1 2"
  [4]="0 1 2 3"
  [5]="4"
  [6]="3"
  [7]="0 1 2 3 4 5 6"
)

# Phase names
declare -A PHASE_NAMES=(
  [0]="build-foundation"
  [1]="secrets-config"
  [2]="platform-services"
  [3]="hardening"
  [4]="cicd"
  [5]="signing-autoupdate"
  [6]="monitoring"
  [7]="e2e-testing"
)

# ─── Helpers ────────────────────────────────────────────────────────────────

log()   { echo "[$(date -u +%H:%M:%S)] [orchestrator] $*" >&2; }
ok()    { echo "  ✓ $*"; }
fail()  { echo "  ✗ $*" >&2; }
phase_log() { echo "[$(date -u +%H:%M:%S)] [phase-$1] $*" >&2; }

# Check if a phase's dependencies are all complete
deps_met() {
  local phase=$1
  local deps="${PHASE_DEPS[$phase]:-}"
  for dep in $deps; do
    if [[ ! -f "$RESULTS_DIR/phase-$dep.complete" ]]; then
      return 1
    fi
  done
  return 0
}

# Run phase-specific tests
run_phase_tests() {
  local phase=$1
  local conf="$PHASES_DIR/phase-$phase.conf"
  if [[ ! -f "$conf" ]]; then
    fail "No config found for phase $phase"
    return 1
  fi
  source "$conf"
  phase_log "$phase" "Running phase-specific tests..."
  if declare -F phase_tests >/dev/null 2>&1; then
    if phase_tests; then
      ok "Phase $phase tests passed"
      return 0
    else
      fail "Phase $phase tests failed"
      return 1
    fi
  fi
  return 0
}

# Run regression tests (existing test suites)
run_regression_tests() {
  local phase=$1
  phase_log "$phase" "Running regression tests..."
  local rc=0

  # Server tests
  (cd "$PROJECT_ROOT/server" && npm test >/dev/null 2>&1) || {
    fail "Server regression tests failed"
    rc=1
  }

  # Agent tests
  (cd "$PROJECT_ROOT/agent" && python -m pytest tests/ -v >/dev/null 2>&1) || {
    fail "Agent regression tests failed"
    rc=1
  }

  # Dashboard tests
  (cd "$PROJECT_ROOT/dashboard" && npm test >/dev/null 2>&1) || {
    fail "Dashboard regression tests failed"
    rc=1
  }

  if [[ $rc -eq 0 ]]; then
    ok "All regression tests passed"
  fi
  return $rc
}

# Run a single phase
run_phase() {
  local phase=$1
  local name="${PHASE_NAMES[$phase]}"
  local conf="$PHASES_DIR/phase-$phase.conf"

  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  PHASE $phase: $name"
  echo "════════════════════════════════════════════════════════════════"

  # Check dependencies
  if ! deps_met "$phase"; then
    fail "Dependencies not met for phase $phase. Required: ${PHASE_DEPS[$phase]}"
    return 1
  fi

  # Load phase config
  if [[ ! -f "$conf" ]]; then
    fail "No config for phase $phase at $conf"
    return 1
  fi
  source "$conf"

  phase_log "$phase" "Skill domain: $SKILL_DOMAIN"
  phase_log "$phase" "Files owned: $FILES_OWNED"
  phase_log "$phase" "Tasks: $TASKS"

  # Execute tasks (in a real run, these spawn subagents)
  # The orchestrator writes tasks to the task queue; subagents pick them up.
  local task_file="$TASK_QUEUE_DIR/phase-$phase.tasks"
  echo "$TASKS" | tr ',' '\n' > "$task_file"
  phase_log "$phase" "Task queue written to $task_file"

  # Run phase-specific tests with retry loop
  local max_retries=3
  local attempt=1
  while [[ $attempt -le $max_retries ]]; do
    phase_log "$phase" "Test attempt $attempt/$max_retries"

    if run_phase_tests "$phase" && run_regression_tests "$phase"; then
      touch "$RESULTS_DIR/phase-$phase.complete"
      ok "Phase $phase COMPLETE"
      return 0
    fi

    attempt=$((attempt + 1))
    if [[ $attempt -le $max_retries ]]; then
      phase_log "$phase" "Tests failed, retrying (consult skill domain)..."
    fi
  done

  fail "Phase $phase FAILED after $max_retries attempts"
  return 1
}

# Show status of all phases
show_status() {
  echo "Phase Status:"
  echo "──────────────────────────────────────────────"
  for phase in 0 1 2 3 4 5 6 7; do
    local name="${PHASE_NAMES[$phase]}"
    local status="PENDING"
    if [[ -f "$RESULTS_DIR/phase-$phase.complete" ]]; then
      status="COMPLETE"
    elif deps_met "$phase" 2>/dev/null; then
      status="READY"
    fi
    printf "  Phase %d %-22s %s\n" "$phase" "$name" "$status"
  done
}

# Run all phases in dependency order
run_all() {
  # Phases 0-2 can run in parallel (no file conflicts)
  # For sequential execution, run in topological order
  local order=(0 1 2 3 4 5 6 7)
  for phase in "${order[@]}"; do
    if [[ -f "$RESULTS_DIR/phase-$phase.complete" ]]; then
      ok "Phase $phase already complete, skipping"
      continue
    fi
    if ! run_phase "$phase"; then
      fail "Halting: phase $phase failed"
      return 1
    fi
  done
  echo ""
  ok "ALL PHASES COMPLETE"
  show_status
}

# ─── Main ───────────────────────────────────────────────────────────────────

case "${1:-}" in
  all)     run_all ;;
  status)  show_status ;;
  test)
    [[ -z "${2:-}" ]] && { echo "Usage: $0 test <phase-number>"; exit 1; }
    source "$PHASES_DIR/phase-$2.conf" 2>/dev/null || { fail "No config for phase $2"; exit 1; }
    run_phase_tests "$2"
    ;;
  [0-7])   run_phase "$1" ;;
  *)       echo "Usage: $0 {all|status|test <n>|<phase-number>}"; exit 1 ;;
esac
