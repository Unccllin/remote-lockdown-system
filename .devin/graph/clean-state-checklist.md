# Clean State Checklist

> **Purpose**: Every session must end with the system in a clean state.
> This checklist defines the 5 conditions that must be met before a session
> can close. Run `make clean-state` to verify.
>
> **Source**: WalkingLabs Harness Engineering Course, Lecture 12 — "Why Every
> Session Must Leave a Clean State"

## The 5 conditions

### 1. Build passes
The dashboard build must succeed (the most common build to break).
```bash
cd dashboard && npx vite build
```
**Pass**: exit code 0, `dashboard/dist/` populated.
**Fail**: any error, missing dist.

### 2. Tests pass (including pre-existing tests)
All three test suites must pass — not just the tests for code changed this
session. Regression tests are the safety net.
```bash
# Server (Jest)
cd server && npm test
# Agent (pytest)
cd agent && python3 -m pytest tests/ -q
# Dashboard (Vitest)
cd dashboard && npx vitest run
```
**Pass**: all suites green, no failures.
**Fail**: any test failure in any suite.

### 3. Progress recorded in machine-readable artifacts
The session's work must be recorded in:
- `.devin/graph/trace.md` — full session-end status block (I4)
- `.devin/graph/current-state.md` — compact summary updated (I4 extended)
- Any wayfinder tickets touched this session — status updated to CLOSED
- `docs/adr/DEBT-LEDGER.md` — if debt items were closed, commit_ref + artifact_ref added

**Pass**: all touched artifacts updated.
**Fail**: any artifact stale or missing session-end block.

### 4. No temporary artifacts
No debug logs, TODO markers, commented-out code, or temporary files left
behind. Check with:
```bash
git status --short
```
**Pass**: only intentional changes show (new files, modified files, staged
files). No `*.log`, `*.tmp`, `debug_*`, `test_*` (temporary test files).
**Fail**: untracked temporary files, debug code left in source.

### 5. Startup path remains functional
The standard verification commands must still work:
```bash
make graph-check    # graph invariants pass
make verify-env     # environment verification (61+ checks)
```
**Pass**: both commands exit 0.
**Fail**: either command fails.

## Running the checklist

```bash
make clean-state
```

This runs all 5 conditions and reports pass/fail per condition. The session
is not clean until all 5 pass.
