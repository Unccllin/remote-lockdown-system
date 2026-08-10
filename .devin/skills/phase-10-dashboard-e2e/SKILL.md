# Skill Domain: Phase 10 — Dashboard E2E (Playwright)

## Context
Dashboard has component tests (vitest + testing-library) but no browser-based E2E tests. This phase adds Playwright E2E tests that drive the real dashboard UI against a running server.

## Current State
- dashboard/tests/ — vitest component tests (ConfirmModal, DevicesPage, DeviceDetailPage)
- dashboard/src/pages/ — Login, Setup, Overview, Devices, DeviceDetail, Enroll, Audit, Map, Health
- dashboard/src/api/client.js — Axios client with JWT auth
- No Playwright installed or configured

## Research Findings
### Playwright Setup
- `@playwright/test` package
- `playwright.config.js` in dashboard/
- Tests in `dashboard/e2e/` directory
- Playwright can auto-start the Vite dev server
- Need to also start the backend server

### Test Flow
1. Start backend (Express with SQLite test DB)
2. Start dashboard dev server (Vite)
3. Playwright launches browser → navigates to dashboard
4. Test: login flow (enter credentials, click login, verify redirect)
5. Test: device list loads
6. Test: enroll device flow
7. Test: flag stolen flow (type hostname confirmation)
8. Test: recover device flow
9. Test: audit log visible
10. Test: health page loads

### Playwright Config
- Base URL: http://localhost:5173 (Vite default)
- Web server config: start both backend + Vite
- Use `page.goto()`, `page.fill()`, `page.click()`, `page.expect()`
- Screenshots on failure for debugging

### Challenges
- Need to seed test data (admin account, devices) before tests
- Can use the setup endpoint to create admin, or seed DB directly
- Dashboard proxies /api to localhost:3001 — need backend running on 3001

## Reasoning Questions
1. **Playwright or Cypress?**
   - Answer: Playwright. Better cross-browser support, faster, built-in auto-wait, no separate download server needed. Already common in modern projects.

2. **Should E2E tests run in CI?**
   - Answer: Yes, but as a separate job (slow). Add to ci.yml with `npx playwright test`. Use Playwright's GitHub Actions setup.

3. **Should tests use headed or headless mode?**
   - Answer: Headless in CI, headed for local dev (configurable via `--headed` flag).

4. **How to handle auth state across tests?**
   - Answer: Use `beforeAll` to login via API and store auth state. Playwright's `storageState` can persist cookies/localStorage. Or just login via UI in each test (simpler, more realistic).

## Implementation Guidelines
### dashboard/package.json
Add to devDependencies: `@playwright/test`
Add script: `"test:e2e": "playwright test"`

### dashboard/playwright.config.js
- testDir: ./e2e
- baseURL: http://localhost:5173
- webServer: start Vite + backend
- retries: 1 in CI
- screenshot: only-on-failure

### dashboard/e2e/fixtures.js
- Start backend with SQLite test DB
- Create admin account
- Create test devices
- Provide authenticated page context

### dashboard/e2e/auth.spec.js
- Login page renders
- Login with valid credentials → redirect to dashboard
- Login with invalid credentials → error message
- Setup page for first-run

### dashboard/e2e/devices.spec.js
- Device list loads
- Flag stolen flow with hostname confirmation
- Recover device flow
- Audit log page loads

### .github/workflows/ci.yml
Add `dashboard-e2e` job that runs Playwright tests.

## File Boundaries
- EDIT: `dashboard/package.json` (add @playwright/test + script)
- CREATE: `dashboard/playwright.config.js`, `dashboard/e2e/*.spec.js`, `dashboard/e2e/fixtures.js`
- EDIT: `.github/workflows/ci.yml` (add dashboard-e2e job)
- DO NOT EDIT: existing dashboard source, component tests

## Graph Integration

**Phase node**: `P10` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P10` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-DASHBOARD,V-BUILD-DASHBOARD

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

