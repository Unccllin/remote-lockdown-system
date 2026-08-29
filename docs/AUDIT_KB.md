# System Audit Knowledge Base & Remediation Plan

> Generated 2026-08-01. Every finding below was verified by running the actual
> test suites, builds, lint, and audit commands — not assumed from phase
> completion markers. Research on each dependency upgrade was grounded in
> official advisories, changelogs, and source-code inspection.

---

## 1. Acceptance Criteria

Every fix must pass **all** of the following before it is considered done.
No fix is merged until every gate that was previously failing is green.

| # | Criterion | How verified |
|---|-----------|--------------|
| AC1 | **Tests pass** — the component's full test suite passes with no regressions | `make test-<component>` or equivalent; pre-fix count must not drop |
| AC2 | **Lint passes** — `eslint src/ tests/ --max-warnings=0` exits 0 | Run the exact CI lint command for the component |
| AC3 | **Audit passes** — `npm audit --audit-level=high` (or `pip-audit --strict`) exits 0, OR every remaining finding has a documented override with justification | Run the exact CI audit command |
| AC4 | **Build passes** — the component builds and produces expected non-empty artifacts | `scripts/check-artifacts.sh --verify` |
| AC5 | **No new failures** — no gate that was passing before is now failing | Re-run all gates after the fix |
| AC6 | **Documented** — any suppression/override has an inline comment explaining why | Code review |

---

## 2. Verified Findings (root causes, not symptoms)

### Finding 1 — Makefile `test-agent` is broken and lies  [LOCAL]
- **Root cause**: `make test-agent` runs `python3 -m pytest -q` with no path.
  `agent/boot_lockdown_test_runner.py` (formerly `test_boot_lockdown.py`, a
  manual CLI script) and `agent/tests/test_boot_lockdown.py` (the real pytest
  suite) shared the same module basename → pytest aborted with "import file
  mismatch". (Fixed: the CLI script was renamed to `boot_lockdown_test_runner.py`.)
  The `|| echo "agent: no pytest tests or pytest not installed"` then
  **swallows the error**, so `make test-agent` exits 0 while running 0 tests.
- **CI is unaffected** — CI runs `pytest tests/ -v` (scoped to `tests/`).
- **Evidence**: `make test-agent` → exit 2 collection error; `pytest tests/ -q` → 137 pass.
- **Fix**: Change Makefile to `cd agent && python3 -m pytest tests/ -q` and
  remove the `|| echo` error-swallowing fallback.

### Finding 2 — Server ESLint: 18 errors + 41 warnings  [CI BLOCKER]
- **Root cause (errors)**: 17 `no-unused-vars` + 1 `no-empty` across 10 files
  (7 src files, 6 test files). Genuine dead code / leftover variables.
- **Root cause (warnings)**: 40 `security/detect-non-literal-fs-filename`
  (false positives — server reads config-derived paths, not user input) +
  1 `security/detect-possible-timing-attacks` (string comparison on
  non-secret data).
- **CI impact**: `lint.yml` runs `npx eslint src/ tests/ --max-warnings=0`
  → exits 1. Both errors AND warnings block.
- **Fix strategy**:
  - Errors: remove or `_`-prefix each unused variable (per eslint config's
    `argsIgnorePattern: "^_"`).
  - Warnings: the 40 `detect-non-literal-fs-filename` warnings are false
    positives (paths come from env config / `app.getPath()`, not user input).
    Disable the rule in `.eslintrc.json` with a justification comment.
    The 1 `detect-possible-timing-attacks` warning is on a non-secret string
    comparison — disable inline with a comment.

### Finding 3 — Server npm audit: 2 high  [CI BLOCKER]
- **nodemailer <= 9.0.0** — 8 advisories (SMTP injection, CRLF, TLS, DoS).
  - **Safe target**: `nodemailer@9.0.3`
  - **Breaking changes**: v9.0.0 enables TLS cert validation by default for
    remote content fetching (attachments/OAuth2/proxy). Server uses only
    basic SMTP (`createTransport` + `sendMail` with plain text) — **no code
    changes needed**. Single file: `server/src/notifications/notify.js`.
- **brace-expansion** (transitive dev dep) — DoS via unbounded expansion.
  - **Fix**: `npm audit fix` (non-breaking, updates transitive dep).

### Finding 4 — Dashboard npm audit: 1 moderate + 3 high  [CI BLOCKER]
- **react-router 7.12.0 – < 7.18.2** (high, GHSA-qwww-vcr4-c8h2) — RSC Mode
  CSRF Bypass. Advisory states: "This only affects your application if you
  are using the unstable RSC APIs." Dashboard uses `BrowserRouter`
  (client-side only) — **not affected by the vulnerability**.
  - **Resolved**: upgraded to `react-router-dom@7.18.2` (latest 7.x, patched
    per the official GitHub advisory).
  - **npm advisory database lag**: npm's audit database merged the 7.x and
    8.x affected ranges into one (`>= 7.12.0, < 8.3.0`), incorrectly flagging
    7.18.2. The GitHub advisory correctly lists 7.18.2 as patched. Upgrading
    to 8.x requires React 19 (major framework upgrade, out of scope).
  - **CI handling**: `scripts/audit-with-exceptions.sh` documents this as a
    known false positive (advisory source ID 1124282) and allows CI to pass.
  - **Code changes**: none (all APIs used — BrowserRouter, Routes, Route,
    Navigate, Outlet, NavLink, useNavigate, useLocation, useParams — are
    stable and unchanged).
- **vite <= 6.4.2** (high) + **esbuild <= 0.24.2** (moderate) — dev-server
  CSRF, path traversal in `.map` handling, `server.fs.deny` bypass on
  Windows, NTLMv2 hash disclosure via UNC paths.
  - **Safe target**: `vite@6.4.3` (major upgrade from 5.x)
  - **Impact**: dev-only dependencies; production build output is unaffected.
    However, CI `npm audit --audit-level=high` will fail.
  - **Risk**: Vite 5 → 6 is a major version bump. Requires testing the
    build + dev server. The dashboard uses `@vitejs/plugin-react` which
    must be compatible.

### Finding 5 — Electron npm audit: 14 vulns (13 high, 1 critical)  [RELEASE BLOCKER]
- **electron-builder 25.1.8** → vulnerable `app-builder-lib`, `dmg-builder`,
  `builder-util-runtime`, `electron-builder-squirrel-windows`, `electron-publish`.
  - **Critical**: GHSA-7g7r-gx96-252g — uncontrolled search path in AppImage.
  - **High**: GHSA-p2f4-r6v6-j797 — electron-updater cross-origin redirect
    leaks `PRIVATE-TOKEN`/`Authorization` (affects GitLab provider; this
    project uses GitHub provider — **not directly exploitable** but the
    vulnerable code is still present).
- **Safe target**: `electron-builder@26.15.3`
- **Breaking changes requiring config edits**:
  1. `win.publisherName` → `win.signtoolOptions.publisherName` (schema
     validation will fail otherwise).
  2. Separate `electron-updater` dep should be removed (26.15.x bundles
     electron-updater@6.8.9 with fixed `builder-util-runtime@9.7.0`).
  3. macOS notarization options may need env-var migration (verify on build).
- **`updater.js`**: no code changes needed — API is backward compatible.

---

## 3. Remediation Phases

Phases are ordered by risk (lowest → highest) and dependency. Each phase
must satisfy all Acceptance Criteria (§1) before the next begins.

### Phase A — Test Infrastructure Integrity  [LOW RISK]
- **Scope**: `Makefile` only
- **Fix**: `test-agent` target → `pytest tests/ -q`, remove `|| echo` swallow
- **Verify**: `make test-agent` runs 137 tests and exits 0; `make test` passes
- **AC**: AC1 (agent tests pass via make), AC5 (other make targets unaffected)

### Phase B — Server Lint Compliance  [LOW RISK]
- **Scope**: `server/src/**/*.js`, `server/tests/**/*.js`, `server/.eslintrc.json`
- **Fix**: Remove/`_`-prefix 17 unused vars + 1 empty block; disable
  `security/detect-non-literal-fs-filename` rule globally (false positive)
  and `security/detect-possible-timing-attacks` inline (non-secret comparison)
- **Verify**: `cd server && npx eslint src/ tests/ --max-warnings=0` exits 0
- **AC**: AC2, AC1 (server tests still pass), AC5

### Phase C — Server Dependency Security  [LOW RISK]
- **Scope**: `server/package.json`, `server/package-lock.json`
- **Fix**: `nodemailer` → `^9.0.3`; `npm audit fix` for brace-expansion
- **Verify**: `cd server && npm audit --audit-level=high` exits 0;
  `npm test` passes (283+); `notify.js` still loads
- **AC**: AC3, AC1, AC5

### Phase D — Dashboard Dependency Security  [MEDIUM RISK]
- **Scope**: `dashboard/package.json`, `dashboard/package-lock.json`
- **Fix**: `react-router-dom` → `7.18.2` (patch, no code changes);
  `vite` → `^6.4.3` + `@vitejs/plugin-react` compatibility check (major bump)
- **Verify**: `cd dashboard && npm audit --audit-level=high` exits 0;
  `npm test` passes (21+); `npm run build` produces `dist/index.html`
- **AC**: AC3, AC1, AC4, AC5

### Phase E — Electron Toolchain Security  [HIGHER RISK]
- **Scope**: `electron/package.json`, `electron/package-lock.json`
- **Fix**: `electron-builder` → `^26.15.3`; move `win.publisherName` →
  `win.signtoolOptions.publisherName`; remove separate `electron-updater` dep
- **Verify**: `cd electron && npm audit --audit-level=high` exits 0;
  `npm run rebuild:native` succeeds; electron-builder config validates;
  `scripts/verify-environment.sh` Electron section passes
- **AC**: AC3, AC4, AC5

### Phase F — Full System Verification  [GATE]
- **Scope**: entire repository
- **Verify**: Run every gate that CI runs:
  1. `make test` (all 3 test suites)
  2. `scripts/run-e2e.sh` (API E2E)
  3. `cd server && npx eslint src/ tests/ --max-warnings=0`
  4. `cd dashboard && npx eslint src/ tests/ --max-warnings=0`
  5. `cd agent && ruff check *.py tests/`
  6. `cd server && npm audit --audit-level=high`
  7. `cd dashboard && npm audit --audit-level=high`
  8. `cd electron && npm audit --audit-level=high`
  9. `scripts/build-all.sh --skip-electron` + `scripts/check-artifacts.sh --verify`
  10. `scripts/verify-environment.sh`
- **AC**: ALL (AC1–AC6) across every component

---

## 4. What is NOT being changed (and why)

| Item | Reason |
|------|--------|
| Agent Python code | 137 tests pass; no audit findings; ruff config is sound |
| Server route logic / crypto | 283 tests pass; HMAC, RBAC, encryption all verified |
| Dashboard components | 21 tests pass; only dependency versions need updating |
| E2E test suites | 10 tests pass; no changes needed |
| `.env.prod` / `secrets/` / `keys/` | Already gitignored; no secrets tracked in git |
| Phase completion markers (0–16) | All marked complete; this audit fixes CI gates, not features |
