# Makefile — developer convenience targets for the remote-lockdown-system.
#
# All targets wrap the scripts in scripts/ so that the shell scripts remain
# the single source of truth for build and verification logic. Do not
# duplicate build logic here; call the scripts instead.
#
# Common usage:
#   make build              # build dashboard + agent + electron
#   make build-skip-electron# build without the slow electron packaging
#   make test               # run all test suites
#   make check-artifacts    # verify build outputs exist and are non-empty
#   make clean              # remove all dist/ directories

SHELL := /bin/bash

# Scripts (single source of truth).
BUILD_SCRIPT    := scripts/build-all.sh
CHECK_SCRIPT    := scripts/check-artifacts.sh

# Default target.
.PHONY: help
help:
	@echo "Remote Lockdown System — developer targets"
	@echo ""
	@echo "Build:"
	@echo "  make build                build dashboard, agent, and electron"
	@echo "  make build-skip-electron  build dashboard + agent (skip electron)"
	@echo "  make build-dashboard      build only the dashboard"
	@echo "  make build-agent          build only the agent"
	@echo "  make build-server         install only server dependencies"
	@echo "  make build-electron       build only the electron app"
	@echo ""
	@echo "Test:"
	@echo "  make test                 run all test suites (server + agent + dashboard)"
	@echo "  make test-server          run server tests"
	@echo "  make test-agent           run agent tests"
	@echo "  make test-dashboard       run dashboard tests"
	@echo "  make test-worker          run serverless worker tests"
	@echo "  make test-electron        run electron tests"
	@echo "  make test-e2e             run API-level E2E tests (lockdown + recovery + agent-integration)"
	@echo "  make test-e2e-dashboard   run Playwright browser E2E tests (dashboard)"
	@echo "  make test-coverage        run all test suites with coverage reporting"
	@echo "  make full-verify          run everything: lint + test + e2e + verify-env + graph-check"
	@echo "  make hw-test              run hardware test harness v2.0 (D-003, simulate mode)"
	@echo "  make hw-test-dry          dry-run hardware test harness"
	@echo "  make hw-test-check        check test eligibility (no execution)"
	@echo ""
	@echo "Other:"
	@echo "  make check-artifacts      verify build outputs (strict)"
	@echo "  make check-structure      check dist dirs exist (non-fatal)"
	@echo "  make verify-env           verify all environment items (agent, NSIS, Docker, signing, etc.)"
	@echo "  make graph-check          run graph invariant sweep (I1-I7)"
	@echo "  make graph-status         print convergence report (phases, debt, enforcement gaps)"
	@echo "  make gen-state            regenerate current-state.md from trace.md (compact, auto-derived)"
	@echo "  make archive-trace        rotate old sessions from trace.md to archive files"
	@echo "  make clean-state          run 5-condition clean state checklist (L12)"
	@echo "  make clean                remove all dist/ directories"

# ---------------------------------------------------------------------------
# Build targets — all wrap scripts/build-all.sh
# ---------------------------------------------------------------------------

.PHONY: build build-dashboard build-agent build-server build-electron build-skip-electron

# Full build: dashboard + agent must succeed before electron bundles them.
build: build-dashboard build-agent build-electron

# Faster dev build: skip the slow electron packaging step.
build-skip-electron:
	@$(BUILD_SCRIPT) --skip-electron

# Single-component builds delegate to build-all.sh --component.
build-dashboard:
	@$(BUILD_SCRIPT) --component dashboard

build-agent:
	@$(BUILD_SCRIPT) --component agent

build-server:
	@$(BUILD_SCRIPT) --component server

build-electron:
	@$(BUILD_SCRIPT) --component electron

# ---------------------------------------------------------------------------
# Test targets — run each component's own test suite directly.
# (build-all.sh is a build orchestrator; tests live in each component.)
# ---------------------------------------------------------------------------

.PHONY: test test-server test-agent test-dashboard test-worker test-electron test-e2e test-e2e-dashboard test-coverage

test: test-server test-agent test-dashboard

test-server:
	@cd server && npm test

test-agent:
	@cd agent && python3 -m pytest tests/ -q

test-dashboard:
	@cd dashboard && npm test

test-worker:
	@cd serverless && npx vitest run

test-electron:
	@cd electron && npm test

# Lint all components — server, dashboard, agent.
.PHONY: lint lint-server lint-dashboard lint-agent

lint: lint-server lint-dashboard lint-agent

lint-server:
	@cd server && npx eslint src/ tests/ --max-warnings=0

lint-dashboard:
	@cd dashboard && npx eslint src/ tests/ --max-warnings=0

lint-agent:
	@cd agent && python3 -m ruff check . tests/ && python3 -m ruff format --check . tests/

# Format check is now part of lint-agent. This target is kept for backwards
# compatibility but simply delegates to lint-agent's format check.
.PHONY: format-check
format-check:
	@cd agent && python3 -m ruff format --check . tests/

# API-level E2E tests — runs lockdown + recovery + agent-integration suites
# against a real Express app with isolated SQLite temp database.
test-e2e:
	@scripts/run-e2e.sh --agent-integration --verbose

# Playwright browser E2E tests — requires dashboard built and server running.
# Set USE_SQLITE=true and ALLOW_NON_PROD=1 for local runs.
test-e2e-dashboard:
	@cd dashboard && npx playwright test

# Run all test suites with coverage reporting.
test-coverage:
	@export PATH="/home/cllin/.local/node/bin:$$PATH" && \
	echo "=== Server coverage ===" && cd server && npm run test:coverage && cd .. && \
	echo "=== Agent coverage ===" && cd agent && python3 -m pytest tests/ --cov=. --cov-report=term -q && cd .. && \
	echo "=== Dashboard coverage ===" && cd dashboard && npx vitest run --coverage && cd .. && \
	echo "=== Worker coverage ===" && cd serverless && npx vitest run --coverage && cd .. && \
	echo "=== Electron coverage ===" && cd electron && npm run test:coverage && cd .. && \
	echo "=== All coverage reports generated ==="

# Full verification sweep — runs everything in order:
#   1. Graph invariant check (fastest gate, catches structural issues first)
#   2. Lint (all components)
#   3. Tests (all 5 test suites)
#   4. E2E (API-level)
#   5. Environment verification (build tooling, signing, Docker)
#   6. Artifact check (build outputs exist)
# Stops on first failure.
.PHONY: full-verify

full-verify: graph-check lint test test-e2e verify-env check-artifacts
	@echo ""
	@echo "=========================================="
	@echo "  FULL VERIFICATION PASSED"
	@echo "  graph-check + lint + tests + e2e + env + artifacts"
	@echo "=========================================="

# Hardware test harness v2.0 (D-003) — runs 12 enforcement path tests against
# real Windows/HP hardware. On non-Windows/non-HP, tests are skipped.
# Modes: simulate (real actions), dry-run (skip), check (eligibility only).
# Use hw-test-dry to see what would run without executing real actions.
.PHONY: hw-test hw-test-dry hw-test-check

hw-test:
	@cd agent && python3 hw_test_harness.py --mode simulate

hw-test-dry:
	@cd agent && python3 hw_test_harness.py --mode dry-run

hw-test-check:
	@cd agent && python3 hw_test_harness.py --mode check

# ---------------------------------------------------------------------------
# Artifact verification — wraps scripts/check-artifacts.sh
# ---------------------------------------------------------------------------

.PHONY: check-artifacts check-structure

check-artifacts:
	@$(CHECK_SCRIPT) --verify

check-structure:
	@$(CHECK_SCRIPT) --check-structure

# ---------------------------------------------------------------------------
# Environment verification — wraps scripts/verify-environment.sh
# Tests items that were previously "cannot verify in WSL": agent PyInstaller
# build, NSIS installer compilation, platform installer syntax, code signing
# dry-run, Docker validation, and Electron packaging.
# ---------------------------------------------------------------------------

.PHONY: verify-env

verify-env:
	@scripts/verify-environment.sh

# ---------------------------------------------------------------------------
# Graph invariant sweep — checks all 7 graph invariants (I1-I7)
# Run before starting work to verify the project is in a consistent state.
# See .devin/graph/GRAPH-SPEC.yaml for the full spec.
# ---------------------------------------------------------------------------

.PHONY: graph-check

graph-check:
	@python3 .devin/graph/graph_assert.py

# Graph convergence report — surfaces the real remaining work (phases, debt,
# enforcement paths). Unlike graph-check (which asserts invariants), this
# never raises — it reports what's done vs. what's left.
.PHONY: graph-status

graph-status:
	@python3 .devin/graph/graph_assert.py --convergence

# Regenerate current-state.md from trace.md + GRAPH-SPEC.yaml.
# current-state.md is a GENERATED artifact — do not edit by hand.
# Run this after appending a session block to trace.md.
.PHONY: gen-state

gen-state:
	@python3 scripts/graph_session.py generate-current-state

# Rotate old session blocks from trace.md into trace-archive-YYYY-MM.md files.
# Keeps trace.md compact (under 3000 lines) by moving old sessions to archives.
# Default: archive when trace.md exceeds 3000 lines, keep latest 5 sessions.
.PHONY: archive-trace

archive-trace:
	@python3 scripts/graph_session.py archive-trace

# ---------------------------------------------------------------------------
# Clean state checklist — 5 conditions from Lecture 12
# Run at session end to verify the system is in a clean state.
# See .devin/graph/clean-state-checklist.md for details.
# ---------------------------------------------------------------------------

.PHONY: clean-state

clean-state:
	@bash .devin/orchestration/orchestrator.sh clean-state

# ---------------------------------------------------------------------------
# Clean — remove all build outputs.
# ---------------------------------------------------------------------------

.PHONY: clean

clean:
	@echo "Removing dist/ directories..."
	@rm -rf dashboard/dist agent/dist agent/build electron/dist-electron
	@echo "Clean complete."
