---
name: phase-0-build-foundation
description: Build orchestration and artifact verification for server, dashboard, agent, and electron components
---

# Phase 0 — Build Foundation & Artifact Verification

## Context

The remote-lockdown-system has four buildable components:
1. **Server** (`server/`) — Node.js/Express, no build step (runs directly)
2. **Dashboard** (`dashboard/`) — React + Vite, builds to `dashboard/dist/`
3. **Agent** (`agent/`) — Python, builds via PyInstaller to `agent/dist/`
4. **Electron** (`electron/`) — Desktop app, builds via electron-builder

## Current State

- `scripts/build-all.sh` orchestrates all component builds in dependency order (dashboard → agent → server deps → electron)
  - Supports `--component <name>` for single-component builds
  - Supports `--skip-electron` for faster dev builds
  - Checks prerequisites (node, python, pip) before starting
  - Prints build summary with artifact paths and sizes
  - Fails fast on any component failure
- `scripts/check-artifacts.sh` verifies build outputs exist and are non-empty
  - `--check-structure` mode: verify directories exist (non-destructive)
  - `--verify` mode: check each expected artifact exists and is non-empty
  - `--json` output mode for CI integration
  - Exit codes: 0=all good, 1=missing artifacts, 2=empty artifacts
- `Makefile` wraps all scripts (single source of truth): `make build`, `make build-dashboard`, `make build-agent`, `make build-server`, `make build-electron`, `make test`, `make check-artifacts`, `make clean`
- `agent/build.sh` (Linux) and `agent/build.ps1` (Windows) call PyInstaller with `.spec` files
- `agent/agent.spec`, `agent/watchdog.spec`, `agent/offline_recovery.spec` exist (all `--onefile` mode)
- `dashboard/package.json` has `"build": "vite build"` script
- `electron/package.json` has electron-builder config with `extraResources` pointing to `../dashboard/dist/` and `../agent/dist/`

### Build Order (dependency chain)
1. `dashboard` must build BEFORE `electron` (electron bundles dashboard/dist/)
2. `agent` must build BEFORE `electron` (electron bundles agent/dist/)
3. `server` deps must install BEFORE `electron` (electron bundles server/node_modules)
4. `sqlite3` native rebuild needed for Electron: `npx electron-rebuild -f -w sqlite3 -m ../server/node_modules`

### Expected Artifacts
- `dashboard/dist/index.html` + assets/
- `agent/dist/lockdown-agent` (or `.exe` on Windows)
- `agent/dist/lockdown-watchdog`
- `agent/dist/lockdown-recovery`
- `electron/dist-electron/` — platform-specific installers

## Verification

```bash
# Full build (dashboard + agent + electron)
make build

# Faster dev build (skip electron packaging)
make build-skip-electron

# Verify build outputs exist and are non-empty
make check-artifacts

# Check dist directories exist (non-fatal; electron/dist-electron expected missing locally)
make check-structure

# Full verification sweep (graph + lint + tests + e2e + env + artifacts)
make full-verify

# Clean all dist/ directories
make clean
```

## Regression checks

1. **Verify build-all.sh fails fast on component failure**: `scripts/build-all.sh --component dashboard && echo "dashboard build OK"`
2. **Verify check-artifacts.sh checks existence AND size**: `scripts/check-artifacts.sh --verify`
3. **Verify Makefile wraps scripts (no duplicated logic)**: `grep -c 'scripts/' Makefile` should show script delegation
4. **Verify build-all.sh builds for CURRENT platform only**: `scripts/build-all.sh --skip-electron` (cross-platform builds happen in CI release.yml)

## Gotchas

- `electron/dist-electron/` is expected to be missing locally — `make check-structure` is non-fatal for this reason
- `sqlite3` native module must be rebuilt for Electron (`npx electron-rebuild`), not just for Node
- Full `make build` is slow (needs PyInstaller + electron-builder) — use `make build-skip-electron` for dev

## Graph Integration

**Phase node**: `P0` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P0` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-BUILD-DASHBOARD, V-SYNTAX-SWEEP, V-SHELL-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
