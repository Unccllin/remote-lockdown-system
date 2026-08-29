---
name: phase-10-dashboard-e2e
description: Playwright browser E2E tests driving the real dashboard UI against a running server
---

# Phase 10 — Dashboard E2E (Playwright)

## Context

Dashboard has component tests (vitest + testing-library) but needed browser-based
E2E tests. This phase adds Playwright E2E tests that drive the real dashboard UI
against a running server.

## Current State

### Playwright Setup
- `dashboard/package.json` — `@playwright/test` in devDependencies, `"test:e2e": "playwright test"` script
- `dashboard/playwright.config.js` — Playwright configuration
  - testDir: `./e2e`
  - baseURL: `http://localhost:5173` (Vite default)
  - webServer: starts both backend + Vite
  - retries: 1 in CI
  - screenshot: only-on-failure

### E2E Test Files
- `dashboard/e2e/fixtures.js` — test fixtures
  - Starts backend with SQLite test DB
  - Creates admin account
  - Creates test devices
  - Provides authenticated page context
- `dashboard/e2e/auth.spec.js` — authentication flow tests
  - Login page renders
  - Login with valid credentials → redirect to dashboard
  - Login with invalid credentials → error message
  - Setup page for first-run
- `dashboard/e2e/devices.spec.js` — device management flow tests
  - Device list loads
  - Flag stolen flow with hostname confirmation
  - Recover device flow
  - Audit log page loads
- `dashboard/e2e/screenshot.cjs` — screenshot utility

### CI Integration
- `.github/workflows/ci.yml` — `dashboard-e2e` job that runs Playwright tests

## Verification

```bash
# Run Playwright browser E2E tests (requires dashboard built + server running)
# Set USE_SQLITE=true and ALLOW_NON_PROD=1 for local runs
make test-e2e-dashboard

# Run directly via Playwright
cd dashboard && npx playwright test

# Verify Playwright config exists
ls dashboard/playwright.config.js

# Verify E2E test files exist
ls dashboard/e2e/auth.spec.js dashboard/e2e/devices.spec.js dashboard/e2e/fixtures.js

# Verify @playwright/test is in devDependencies
grep "playwright" dashboard/package.json

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify Playwright is configured (not Cypress)**: `grep -c "playwright" dashboard/package.json dashboard/playwright.config.js`
2. **Verify E2E tests run in CI as separate job**: `grep -i "dashboard-e2e\|playwright" .github/workflows/ci.yml`
3. **Verify tests use headless mode in CI**: `grep -i "headless" dashboard/playwright.config.js`
4. **Verify auth state handling across tests**: `grep -i "storageState\|login\|auth" dashboard/e2e/fixtures.js`
5. **Verify screenshots on failure for debugging**: `grep -i "screenshot" dashboard/playwright.config.js`

## Gotchas

- Playwright E2E tests are slow — they run as a separate CI job, not in the main test job
- Tests need both backend (Express on 3001) and frontend (Vite on 5173) running simultaneously
- Dashboard proxies `/api` to `localhost:3001` — backend must be running on port 3001
- Set `USE_SQLITE=true` and `ALLOW_NON_PROD=1` for local runs
- Headless in CI, headed for local dev (configurable via `--headed` flag)
- Auth state can be persisted via Playwright's `storageState` or login via UI in each test (simpler, more realistic)

## Graph Integration

**Phase node**: `P10` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P10` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-DASHBOARD, V-BUILD-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
