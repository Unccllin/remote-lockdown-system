# Skill Domain: Phase 8 — Dependency Installation & SAST

## Context
Phase 4 created ESLint configs (server/.eslintrc.json, dashboard/.eslintrc.json) and ruff config (agent/ruff.toml), but the actual linter packages were NOT added to devDependencies. CI lint workflow installs them with `--no-save` as a workaround. This phase properly installs them. Also adds CodeQL for continuous SAST.

## Current State
- server/package.json devDeps: jest, nodemon, supertest (no eslint)
- dashboard/package.json devDeps: vitest, testing-library, vite, tailwind (no eslint)
- agent/requirements.txt: cryptography, requests (no ruff, no pytest)
- .github/workflows/lint.yml installs eslint plugins with `--no-save`
- No CodeQL workflow exists

## Research Findings
### ESLint Packages Needed
- server: `eslint`, `eslint-plugin-security`
- dashboard: `eslint`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
- All eslint packages should be compatible with ESLint 9.x (latest stable)

### Ruff Package Needed
- agent: add `ruff` and `pytest` to requirements.txt (or a separate requirements-dev.txt)
- Decision: create `agent/requirements-dev.txt` for dev-only deps (ruff, pytest) to keep production requirements clean

### CodeQL
- Free for public repos
- Supports JavaScript/TypeScript and Python
- Workflow: `.github/workflows/codeql.yml`
- Runs on push + PR + scheduled (weekly)
- Uses `github/codeql-action/init@v3`, `autobuild`, `analyze`

## Reasoning Questions
1. **Separate requirements-dev.txt or add to requirements.txt?**
   - Answer: Separate file. Production agent should not ship ruff. `requirements-dev.txt` for dev/CI.

2. **ESLint 8 or 9?**
   - Answer: ESLint 9 (latest). The configs use legacy `.eslintrc.json` format which ESLint 9 supports via `ESLINT_USE_FLAT_CONFIG=false` env var, OR migrate to flat config. For minimal changes, keep `.eslintrc.json` and pin eslint@8 (last version with native eslintrc support). Use eslint@8 to avoid flat config migration.

3. **Should lint workflow stop using --no-save?**
   - Answer: Yes. After deps are in package.json, CI uses `npm ci` which installs devDeps. Remove `--no-save` installs from lint.yml.

## Implementation Guidelines
### server/package.json
Add to devDependencies: `eslint@^8.57.0`, `eslint-plugin-security@^1.7.1`

### dashboard/package.json
Add to devDependencies: `eslint@^8.57.0`, `eslint-plugin-react@^7.34.0`, `eslint-plugin-react-hooks@^4.6.0`, `eslint-plugin-react-refresh@^0.4.0`

### agent/requirements-dev.txt
Create with: `ruff==0.5.0`, `pytest==8.2.0`

### .github/workflows/lint.yml
Edit to remove `--no-save` installs (deps now in package.json). Use `npm ci` instead.

### .github/workflows/codeql.yml
Create CodeQL workflow: push+PR+weekly schedule, JS+Python analysis, autobuild.

## File Boundaries
- EDIT: `server/package.json`, `dashboard/package.json`, `.github/workflows/lint.yml`
- CREATE: `agent/requirements-dev.txt`, `.github/workflows/codeql.yml`
- DO NOT EDIT: existing ESLint configs, ruff.toml, source code

## Graph Integration

**Phase node**: `P8` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P8` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-LINT-SERVER,V-LINT-DASHBOARD,V-LINT-AGENT

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

