---
name: phase-4-cicd
description: CI/CD pipeline enhancement with linting, security scanning, dependency management, and caching
---

# Phase 4 — CI/CD Pipeline Enhancement

## Context

The repo has GitHub Actions workflows for CI and release. This phase enhances
them with linting, security scanning, dependency management, and caching
improvements.

## Current State

### CI Workflows
- `.github/workflows/ci.yml` — runs server, dashboard, agent tests on push/PR
  - 3+ jobs: server-tests, dashboard-tests, agent-tests
  - Uses Node 20, Python 3.12, npm ci for reproducible installs
  - Concurrency control: cancels in-progress runs on new pushes to same branch
  - `dorny/paths-filter` for conditional job execution
  - `npm audit` and `pip-audit` steps for security scanning
  - Uploads test results as artifacts
- `.github/workflows/lint.yml` — linting workflow (push + PR)
  - `lint-server`: ESLint on `server/src/` + `server/tests/`
  - `lint-dashboard`: ESLint on `dashboard/src/` + `dashboard/tests/`
  - `lint-agent`: ruff on `agent/*.py` + `agent/tests/`
  - `lint-workflows`: actionlint on `.github/workflows/`
  - Each job runs in parallel, fails on any lint error
- `.github/workflows/release.yml` — builds + publishes agent binaries and Electron apps on tag push
  - Agent binaries built on 4 platforms (windows-x64, linux-x64, darwin-x64, darwin-arm64)
  - Electron apps built per-platform, macOS per-arch with manifest merging
  - CI gates for electron, serverless, scripts, hw harness (D-021 CLOSED)
- `.github/workflows/codeql.yml` — CodeQL SAST workflow (push + PR + weekly schedule, JS + Python)

### Lint Configs
- `server/.eslintrc.json` — `eslint:recommended` + `eslint-plugin-security`
- `dashboard/.eslintrc.json` — `eslint:recommended` + React plugins
- `agent/ruff.toml` — ruff config with security rules

### Dependency Management
- `.github/dependabot.yml` — Dependabot config
  - `npm` ecosystem: `/server`, `/dashboard`, `/electron` — weekly, group minor+patch
  - `pip` ecosystem: `/agent` — weekly
  - `github-actions` ecosystem: `/` — weekly
  - Ignores major updates (manual review required)

### Caching
- Python: `actions/setup-python` with `cache: pip`
- Node: `actions/setup-node` with `cache: npm`

## Verification

```bash
# Run lint locally (same as CI)
make lint

# Individual component lint
make lint-server
make lint-dashboard
make lint-agent

# Verify workflow files exist
ls .github/workflows/ci.yml .github/workflows/lint.yml .github/workflows/release.yml .github/workflows/codeql.yml

# Verify dependabot config exists
cat .github/dependabot.yml

# Verify ESLint configs exist
cat server/.eslintrc.json
cat dashboard/.eslintrc.json
cat agent/ruff.toml

# Full verification sweep (includes lint)
make full-verify
```

## Regression checks

1. **Verify linting fails the build (not just warns)**: `make lint; echo $?` (should be 0 when clean)
2. **Verify CodeQL workflow exists**: `ls .github/workflows/codeql.yml`
3. **Verify Dependabot creates PRs only (no auto-merge)**: `grep -i "auto.*merge\|automerge" .github/dependabot.yml` (should be empty)
4. **Verify concurrency cancellation in ci.yml**: `grep -A5 "concurrency" .github/workflows/ci.yml`
5. **Verify path filtering uses dorny/paths-filter**: `grep "dorny/paths-filter" .github/workflows/ci.yml`

## Gotchas

- Linting that doesn't block is ignored — all lint jobs fail the build on any error
- Dependabot creates PRs only — auto-merging dependencies without review is risky for security-sensitive code
- Native `paths` filtering cancels the entire workflow if no paths match, which breaks required status checks — `dorny/paths-filter` allows conditional job execution within a single workflow
- ESLint uses `.eslintrc.json` format (legacy) with eslint@8 — not flat config

## Graph Integration

**Phase node**: `P4` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P4` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SYNTAX-SWEEP, V-SHELL-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: D-021 (CLOSED — CI gates for electron, serverless, scripts, hw harness added)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
