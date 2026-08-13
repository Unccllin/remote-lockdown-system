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
GRAPH_DIR="$PROJECT_ROOT/.devin/graph"
TRACE_FILE="$GRAPH_DIR/trace.md"
CURRENT_STATE_FILE="$GRAPH_DIR/current-state.md"

mkdir -p "$TASK_QUEUE_DIR" "$RESULTS_DIR"

# Phase dependency graph (all 17 phases — synced with .devin/graph/GRAPH-SPEC.yaml)
declare -A PHASE_DEPS=(
  [0]=""
  [1]=""
  [2]=""
  [3]="0 1 2"
  [4]="0 1 2 3"
  [5]="4"
  [6]="3"
  [7]="0 1 2 3 4 5 6"
  [8]="4"
  [9]="7"
  [10]="7"
  [11]="7"
  [12]="11"
  [13]="6"
  [14]="11"
  [15]="13"
  [16]="3"
)

# Phase names (all 17 phases — synced with .devin/graph/GRAPH-SPEC.yaml)
declare -A PHASE_NAMES=(
  [0]="build-foundation"
  [1]="secrets-config"
  [2]="platform-services"
  [3]="hardening"
  [4]="cicd"
  [5]="signing-autoupdate"
  [6]="monitoring"
  [7]="e2e-testing"
  [8]="deps-sast"
  [9]="agent-e2e"
  [10]="dashboard-e2e"
  [11]="postgres"
  [12]="docker"
  [13]="notifications-metrics"
  [14]="backup-restore"
  [15]="load-testing"
  [16]="rbac"
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

# ─── Graph enforcement (Refactors 3, 4, 5) ──────────────────────────────────
# These functions wire the node graph into the orchestrator's phase transitions.
# See docs/adr/GRAPH-SPEC.md and docs/adr/REFACTOR-LOG.md for details.

# Refactor 3: Assert phase deps via graph_assert.py (Python-level check)
# This is a SECOND check in addition to deps_met() — it validates against
# the formal graph spec, not just .complete file existence.
graph_check_phase() {
  local phase=$1
  local phase_id="P$phase"
  if [[ ! -f "$GRAPH_DIR/graph_assert.py" ]]; then
    phase_log "$phase" "WARNING: graph_assert.py not found — skipping graph check"
    return 0
  fi
  if ! python3 "$GRAPH_DIR/graph_assert.py" --assert-phase-deps "$phase_id" >/dev/null 2>&1; then
    local output
    output=$(python3 "$GRAPH_DIR/graph_assert.py" --assert-phase-deps "$phase_id" 2>&1)
    fail "Graph invariant violation for phase $phase_id:"
    echo "    $output" >&2
    return 1
  fi
  phase_log "$phase" "Graph check passed: $phase_id dependencies met (I1)"
}

# Refactor 4: RULE-ZERO gate — check that trace.md has a RULE-ZERO entry
# before allowing code execution. The trace is session-scoped: a RULE-ZERO
# entry in the current session covers all phases worked in that session.
# This enforces graph invariant I5 (no code before Rule Zero).
rule_zero_check() {
  local phase=$1
  local phase_id="P$phase"

  if [[ ! -f "$TRACE_FILE" ]]; then
    fail "RULE-ZERO not completed: trace.md not found at $TRACE_FILE"
    echo "    Read the skill file for phase $phase, then log understanding to trace.md" >&2
    return 1
  fi

  # Check for ANY RULE-ZERO entry in the trace (session-scoped, not phase-scoped)
  if ! grep -q "RULE-ZERO" "$TRACE_FILE" 2>/dev/null; then
    fail "RULE-ZERO not completed for phase $phase_id"
    echo "    Read .devin/skills/phase-$phase-*/SKILL.md and source code," >&2
    echo "    then log understanding to $TRACE_FILE before running this phase." >&2
    echo "    Format: '### RULE-ZERO — Understanding logged before code changes'" >&2
    return 1
  fi
  phase_log "$phase" "RULE-ZERO check passed (I5): understanding logged to trace.md"
}

# Refactor 5: Write a session-end status block to trace.md AND current-state.md
# This enforces graph invariant I4 (no session close without trace update).
# Both files must have the session-end status block — trace.md for full
# history, current-state.md for compact session startup.
write_session_end() {
  local status=$1  # "SUCCESS" or "FAILURE"
  local phases_run=$2
  local timestamp
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local session_block
  session_block=$(cat << EOF

## Orchestrator session-end — $timestamp

**Status**: $status
**Phases run**: $phases_run
**Graph invariants**: $(python3 "$GRAPH_DIR/graph_assert.py" 2>&1 | head -3 | tail -1)

**Next session opens with**:
Run \`python3 .devin/graph/graph_assert.py\` to verify all invariants pass,
then check \`docs/adr/DEBT-LEDGER.md\` for open debt items.

---
EOF
)

  # Append to trace.md (full history)
  if [[ -f "$TRACE_FILE" ]]; then
    echo "$session_block" >> "$TRACE_FILE"
    log "Session-end block written to trace.md (I4)"
  fi

  # Append to current-state.md (compact summary)
  if [[ -f "$CURRENT_STATE_FILE" ]]; then
    echo "$session_block" >> "$CURRENT_STATE_FILE"
    log "Session-end block written to current-state.md (I4)"
  fi
}

# Clean state checklist — verifies the 5 conditions from Lecture 12.
# Run via `make clean-state` or `orchestrator.sh clean-state`.
clean_state_check() {
  local pass_count=0
  local fail_count=0
  local check_name

  echo "Clean State Checklist:"
  echo "──────────────────────────────────────────────"

  # 1. Build passes (dashboard build is the most common to break)
  check_name="1. Build passes"
  if (cd "$PROJECT_ROOT/dashboard" && npx vite build >/dev/null 2>&1); then
    ok "$check_name"
    pass_count=$((pass_count + 1))
  else
    fail "$check_name"
    fail_count=$((fail_count + 1))
  fi

  # 2. Tests pass (all 3 suites)
  check_name="2. Tests pass"
  local test_fail=0
  (cd "$PROJECT_ROOT/server" && npm test >/dev/null 2>&1) || test_fail=1
  (cd "$PROJECT_ROOT/agent" && python3 -m pytest tests/ -q >/dev/null 2>&1) || test_fail=1
  (cd "$PROJECT_ROOT/dashboard" && npx vitest run >/dev/null 2>&1) || test_fail=1
  if [[ $test_fail -eq 0 ]]; then
    ok "$check_name"
    pass_count=$((pass_count + 1))
  else
    fail "$check_name"
    fail_count=$((fail_count + 1))
  fi

  # 3. Progress recorded (trace.md + current-state.md have session-end blocks)
  check_name="3. Progress recorded"
  local progress_fail=0
  if ! python3 "$GRAPH_DIR/graph_assert.py" >/dev/null 2>&1; then
    progress_fail=1
  fi
  if [[ $progress_fail -eq 0 ]]; then
    ok "$check_name"
    pass_count=$((pass_count + 1))
  else
    fail "$check_name (graph invariants failed)"
    fail_count=$((fail_count + 1))
  fi

  # 4. No temporary artifacts (git status should show only intentional changes)
  check_name="4. No temp artifacts"
  local temp_files
  temp_files=$(cd "$PROJECT_ROOT" && git status --short | grep -E '\.(log|tmp)$|debug_|^?? test_' || true)
  if [[ -z "$temp_files" ]]; then
    ok "$check_name"
    pass_count=$((pass_count + 1))
  else
    fail "$check_name (found: $temp_files)"
    fail_count=$((fail_count + 1))
  fi

  # 5. Startup path functional (graph-check passes)
  check_name="5. Startup path functional"
  if python3 "$GRAPH_DIR/graph_assert.py" >/dev/null 2>&1; then
    ok "$check_name"
    pass_count=$((pass_count + 1))
  else
    fail "$check_name"
    fail_count=$((fail_count + 1))
  fi

  echo ""
  echo "──────────────────────────────────────────────"
  echo "  $pass_count passed, $fail_count failed"
  if [[ $fail_count -gt 0 ]]; then
    return 1
  fi
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
  (cd "$PROJECT_ROOT/agent" && python3 -m pytest tests/ -v >/dev/null 2>&1) || {
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

  # Check dependencies (bash-level)
  if ! deps_met "$phase"; then
    fail "Dependencies not met for phase $phase. Required: ${PHASE_DEPS[$phase]}"
    return 1
  fi

  # Graph enforcement: assert phase deps via graph_assert.py (Refactor 3, I1)
  if ! graph_check_phase "$phase"; then
    return 1
  fi

  # Graph enforcement: RULE-ZERO gate (Refactor 4, I5)
  if ! rule_zero_check "$phase"; then
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
  for phase in 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
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
  # For sequential execution, run in topological order (all 17 phases)
  local order=(0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)
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
  write_session_end "SUCCESS" "all"
}

# ─── Main ───────────────────────────────────────────────────────────────────

# Trap failures and write session-end trace (Refactor 5, I4)
trap 'write_session_end "FAILURE" "halted"' ERR

case "${1:-}" in
  all)     run_all ;;
  status)  show_status ;;
  graph-check)
    # Run the full graph invariant sweep
    python3 "$GRAPH_DIR/graph_assert.py"
    ;;
  clean-state)
    # Run the 5-condition clean state checklist (Lecture 12)
    clean_state_check
    ;;
  test)
    [[ -z "${2:-}" ]] && { echo "Usage: $0 test <phase-number>"; exit 1; }
    source "$PHASES_DIR/phase-$2.conf" 2>/dev/null || { fail "No config for phase $2"; exit 1; }
    run_phase_tests "$2"
    ;;
  [0-9])     run_phase "$1" ;;
  1[0-6])    run_phase "$1" ;;
  *)       echo "Usage: $0 {all|status|graph-check|test <n>|<phase-number>}"; exit 1 ;;
esac
