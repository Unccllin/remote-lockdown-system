# Skill Domain: Phase 0 — Build Foundation & Artifact Verification

## Context

The remote-lockdown-system has three buildable components:
1. **Server** (`server/`) — Node.js/Express, no build step (runs directly)
2. **Dashboard** (`dashboard/`) — React + Vite, builds to `dashboard/dist/`
3. **Agent** (`agent/`) — Python, builds via PyInstaller to `agent/dist/`
4. **Electron** (`electron/`) — Desktop app, builds via electron-builder

## Current State

- `agent/build.sh` exists (Linux) and `agent/build.ps1` (Windows) — both call PyInstaller with `.spec` files
- `agent/agent.spec`, `agent/watchdog.spec`, `agent/offline_recovery.spec` exist
- `dashboard/package.json` has `"build": "vite build"` script
- `electron/package.json` has electron-builder config with `extraResources` pointing to `../dashboard/dist/` and `../agent/dist/`
- **No top-level build orchestration** — each component must be built separately
- **No artifact verification** — no script checks that builds produced expected outputs

## Research Findings

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

### PyInstaller Spec Analysis
- `agent.spec` — single-file mode, bundles cryptography + requests
- `watchdog.spec` — watchdog process monitor
- `offline_recovery.spec` — offline recovery tool
- All use `--onefile` pattern

### Vite Build
- `dashboard/vite.config.js` proxies `/api` to `localhost:3001` in dev
- Production build outputs static files; server serves them via `express.static`

## Reasoning Questions (agents must answer before implementing)

1. **Should build-all.sh fail fast or continue on component failure?**
   - Answer: Fail fast. A partial build (e.g., dashboard built but agent failed) produces a broken Electron app. Better to stop and report which component failed.

2. **Should check-artifacts.sh verify file sizes or just existence?**
   - Answer: Both. A 0-byte file means the build silently failed. Check existence AND size > 0.

3. **Should the Makefile wrap build-all.sh or duplicate logic?**
   - Answer: Wrap. Single source of truth. Makefile targets call scripts/ scripts.

4. **Should build-all.sh handle cross-platform builds?**
   - Answer: No. It builds for the CURRENT platform. Cross-platform builds happen in CI (release.yml). The local script is for dev/testing.

## Implementation Guidelines

### scripts/build-all.sh
- Accept `--component <name>` to build a single component
- Accept `--skip-electron` for faster dev builds
- Check prerequisites (node, python, pip) before starting
- Build in dependency order: dashboard → agent → server deps → electron
- Print build summary at end with artifact paths and sizes
- Exit non-zero if any build fails

### scripts/check-artifacts.sh
- `--check-structure` mode: verify directories exist (non-destructive)
- `--verify` mode: check each expected artifact exists and is non-empty
- `--json` output mode for CI integration
- Return appropriate exit codes: 0=all good, 1=missing artifacts, 2=empty artifacts

### Makefile
- Targets: `build`, `build-server`, `build-dashboard`, `build-agent`, `build-electron`, `test`, `test-server`, `test-agent`, `test-dashboard`, `clean`, `check-artifacts`
- `build` depends on `build-dashboard build-agent build-electron`
- `test` runs all three test suites
- `clean` removes dist/ directories

## File Boundaries
- CREATE: `scripts/build-all.sh`, `scripts/check-artifacts.sh`, `Makefile`
- DO NOT EDIT: `agent/build.sh`, `agent/build.ps1`, `dashboard/package.json`, `electron/package.json`
- DO NOT EDIT: any source files in `server/src/`, `dashboard/src/`, `agent/*.py`

## Graph Integration

**Phase node**: `P0` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P0` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-BUILD-DASHBOARD,V-SYNTAX-SWEEP,V-SHELL-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

