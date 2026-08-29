---
name: phase-8-deps-sast
description: Proper installation of linter dev dependencies and CodeQL SAST workflow integration
---

# Phase 8 — Dependency Installation & SAST

## Context

Phase 4 created ESLint configs and ruff config, but the actual linter packages
needed to be properly added to devDependencies (CI was using `--no-save` as a
workaround). This phase properly installs them and adds CodeQL for continuous
SAST.

## Current State

### ESLint Packages Installed
- `server/package.json` devDependencies: `eslint@^8.57.0`, `eslint-plugin-security@^1.7.1` (plus jest, nodemon, supertest)
- `dashboard/package.json` devDependencies: `eslint@^8.57.0`, `eslint-plugin-react@^7.34.0`, `eslint-plugin-react-hooks@^4.6.0`, `eslint-plugin-react-refresh@^0.4.0` (plus vitest, testing-library, vite, tailwind)
- ESLint 8.x used (last version with native `.eslintrc.json` support — no flat config migration needed)

### Ruff Packages Installed
- `agent/requirements-dev.txt` — dev-only deps: `ruff==0.5.0`, `pytest==8.2.0`
- Production `agent/requirements.txt` remains clean (cryptography, requests only — ruff does NOT ship to production)

### CodeQL Workflow
- `.github/workflows/codeql.yml` — CodeQL SAST workflow
  - Triggers: push + PR + scheduled (weekly)
  - Languages: JavaScript/TypeScript + Python
  - Uses `github/codeql-action/init@v3`, `autobuild`, `analyze`
  - Free for public repos

### CI Lint Workflow
- `.github/workflows/lint.yml` — no longer uses `--no-save` installs
  - Uses `npm ci` which installs devDeps from package.json
  - All lint packages properly declared in devDependencies

## Verification

```bash
# Verify eslint is in server devDependencies
grep "eslint" server/package.json

# Verify eslint + react plugins are in dashboard devDependencies
grep "eslint" dashboard/package.json

# Verify requirements-dev.txt exists with ruff + pytest
cat agent/requirements-dev.txt

# Verify CodeQL workflow exists
ls .github/workflows/codeql.yml

# Verify lint.yml no longer uses --no-save
grep -c "\-\-no-save" .github/workflows/lint.yml  # should be 0

# Run lint locally (verifies deps are installed)
make lint

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify ruff is NOT in production requirements.txt**: `grep -c "ruff" agent/requirements.txt` (should be 0)
2. **Verify eslint@8 is pinned (not 9)**: `grep "eslint.*8" server/package.json dashboard/package.json`
3. **Verify lint.yml uses npm ci (not --no-save)**: `grep "npm ci" .github/workflows/lint.yml`
4. **Verify CodeQL runs on schedule**: `grep -i "schedule\|weekly" .github/workflows/codeql.yml`

## Gotchas

- ESLint 8 is used (not 9) to avoid flat config migration — `.eslintrc.json` format is supported natively by eslint@8
- `requirements-dev.txt` is separate from `requirements.txt` — production agent should NOT ship ruff
- CodeQL is free for public repos only — private repos would need a different SAST tool

## Graph Integration

**Phase node**: `P8` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P8` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-LINT-SERVER, V-LINT-DASHBOARD, V-LINT-AGENT

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
