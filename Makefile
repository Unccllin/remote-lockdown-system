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
	@echo "  make test                 run all test suites"
	@echo "  make test-server          run server tests"
	@echo "  make test-agent           run agent tests"
	@echo "  make test-dashboard       run dashboard tests"
	@echo ""
	@echo "Other:"
	@echo "  make check-artifacts      verify build outputs (strict)"
	@echo "  make check-structure      check dist dirs exist (non-fatal)"
	@echo "  make verify-env           verify all environment items (agent, NSIS, Docker, signing, etc.)"
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

.PHONY: test test-server test-agent test-dashboard

test: test-server test-agent test-dashboard

test-server:
	@cd server && npm test

test-agent:
	@cd agent && python3 -m pytest tests/ -q

test-dashboard:
	@cd dashboard && npm test

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
# Clean — remove all build outputs.
# ---------------------------------------------------------------------------

.PHONY: clean

clean:
	@echo "Removing dist/ directories..."
	@rm -rf dashboard/dist agent/dist agent/build electron/dist-electron
	@echo "Clean complete."
