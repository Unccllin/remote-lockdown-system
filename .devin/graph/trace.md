# trace.md — Cross-Session Context Trace

> This file persists context across agent sessions. Every session starts by
> reading this file and ends by appending a session-end status block.
>
> **Graph invariant I4**: `assert_session_closed_with_trace()` enforces that
> the session-end block includes all required sections.

---

## Session 140 — 2026-10-27 (DB driver precedence + SQLite migration idempotency)

### RULE-ZERO
- **Read**: `.devin/skills/phase-11-postgres/SKILL.md` — SQLite↔PG divergence, scope of the PGlite suite.
- **Read**: `server/src/index.js` — dotenv load order, migration call, dbMode log, degraded-boot catch.
- **Read**: `server/src/db/pool.js` — the `USE_SQLITE` branch that decides the driver.
- **Read**: `server/src/db/sqlitePool.js` — `translateSql`, `returnsRows` (incl. PRAGMA), `query`.
- **Read**: `server/src/db/migrationRunner.js` — `runMigrations`, dialect→directory, schema_migrations tracking, `splitSqlStatements`.
- **Read**: `server/src/db/migrate.js`, `server/src/config/env.js` (validateEnv/PLACEHOLDERS).
- **Read**: `server/src/db/migrations-sqlite/*.sql` — which DDL forms are idempotent.
- **Read**: `server/tests/sqlitePool.test.js` — migrate-once-on-a-fresh-DB, the coverage gap.
- **Read**: `Dockerfile.server`, `.dockerignore`, `docker-compose*.yml`, `server/.env` — how the image gets its config.
- **Read**: `tests/pg-smoke/pg-smoke.js` — the real-Postgres harness and its module resolution.
**Finding**: The reported "SQL crashes" is not a SQL defect — real Postgres is clean (13/13 migrations, pg-smoke 65/65, JSONB/HMAC/encryption verified) and a *fresh* SQLite file is clean (13/13). It is a **driver-precedence + migration-idempotency** defect reproduced three ways:
(a) `server/src/index.js:2` runs `require('dotenv').config()` unconditionally, so the dev `server/.env` (`USE_SQLITE=true`, `SQLITE_PATH=./lockdown.db`) loads whenever cwd is `server/` — including production runs.
(b) `server/src/db/pool.js:28` gives `USE_SQLITE=true` precedence over `DATABASE_URL` with no conflict guard, while `index.js:274` logs `dbMode` from `DATABASE_URL` presence — the log reports Postgres while SQLite is actually serving.
(c) `migrations-sqlite/009` (and 8 sibling files) use bare `ALTER TABLE … ADD COLUMN`; SQLite has no `IF NOT EXISTS` for columns, so `server/lockdown.db` (schema_migrations=001–008, but 009 columns already present out-of-band) throws `duplicate column name: boot_lock_status`, aborting the whole sweep → **010–013 never apply** (no `hw_test_artifacts`, no `pbl_kv_store`, no firmware-audit columns) → PBL/hw-artifact/firmware routes 500.
(d) `index.js:266` catches the failure and calls `startServer()` anyway — degraded boot labelled only "API may be degraded".
(e) Docker is *accidentally* safe (`WORKDIR /app`, so dotenv looks for `/app/.env`), but `COPY server/ ./server/` still **bakes `server/.env` into the image** with no `.dockerignore` rule.
(f) `tests/pg-smoke/pg-smoke.js` — the only real-Postgres harness — cannot start as documented (`Cannot find module 'express'`: no `node_modules` above `tests/pg-smoke/`), and is not in CI, so none of this was catchable.
**Fix intent**: fail fast on the ambiguous driver, stop loading `.env` in production, log the driver actually selected, make SQLite DDL drift-healing, refuse degraded boot in production, add a drift regression test, and make pg-smoke runnable + CI-wired.

### IMPLEMENT (7 files + 2 new)
- `server/src/config/env.js` — reject `USE_SQLITE=true` together with `DATABASE_URL` (ambiguous driver) in `validateEnv`.
- `server/src/db/pool.js` — warn when `DATABASE_URL` is being ignored; tag the pg pool `driver: 'pg'`.
- `server/src/db/sqlitePool.js` — export `driver: 'sqlite'`.
- `server/src/index.js` — load dotenv only when `NODE_ENV !== 'production'` (warn if a local `.env` is ignored); derive the migration dialect from `pool.driver`; log the driver actually selected; exit 1 on migration failure in production instead of booting degraded.
- `server/src/db/migrationRunner.js` — `sqliteStatementAlreadyApplied()`: skip `ALTER TABLE … ADD COLUMN` whose column already exists and `CREATE TRIGGER` whose name exists, then record the version (drift healing).
- `tests/pg-smoke/pg-smoke.js` — resolve `server/node_modules` via `module.paths` so the documented invocation works; drop two pre-existing unused bindings.
- `.dockerignore` — exclude `.env`/`**/.env` (keep `.env.example`).
- `scripts/run-pg-smoke.sh` (new) + `make pg-smoke` — ephemeral `postgres:16` or `PG_SMOKE_URL`.
- `.github/workflows/ci.yml` — new `pg-smoke` job with a `postgres:16` service.
- `server/tests/migrationIdempotency.test.js` (new) — 3 tests incl. the drift regression.

### VERIFY
- Drift replay on a copy of the broken DB: 009's 3 columns logged as "already-applied DDL", versions 009–013 recorded, `hw_test_artifacts` + `pbl_kv_store` created, second run "No new migrations to apply."
- Real `server/lockdown.db` healed on boot; log is now honest: `dbMode: "sqlite (./lockdown.db)", driver: "sqlite", dialect: "sqlite"`.
- Authenticated route matrix on the healed DB: `/api/devices` 200, `/api/audit` 200, `/api/admins` 200, `/api/hw-test-artifact` 200 `[]`, `/v1/devices` 200, `/v1/admin/{key-info,operator-key,cert-chain}` 200, `/v1/policy` 200 — **0 level-50 log entries**.
- Fail-fast: `USE_SQLITE=true` + `DATABASE_URL` → `FATAL: invalid configuration`, exit 1. Production + unreachable DB → `Refusing to start in production with an unmigrated schema`, exit 1, no `Server running`.
- Red/green proof: `migrationIdempotency.test.js` passes 3/3 with the fix; with the pre-fix runner restored it fails 1/3 with exactly `SQLITE_ERROR: duplicate column name: boot_lock_status`.
- Server Jest full suite: **38 suites / 631 tests pass** (was 628; +3 new). `npx eslint src/ tests/ --max-warnings=0` → exit 0.
- Real PostgreSQL: migrations 13/13; `node tests/pg-smoke/pg-smoke.js` as documented → **65 PASS / 0 FAIL**; `make pg-smoke` (docker script) → same.
- `.dockerignore` verified by building a stub image from the real context: `/x/.env` absent, `/x/.env.example` present.
- `ci.yml` parses (12 jobs, `pg-smoke` with postgres service, 5 steps); `bash -n scripts/run-pg-smoke.sh` OK.

### Fog cleared
- The "SQL crash" is not a SQL defect: real Postgres is clean (13/13 + 65/65) and a fresh SQLite file is clean (13/13). The breakage was driver precedence + migration drift on an *existing* SQLite DB.
- Why the API half-worked: `/api/health` never touches the missing tables, so the server looked alive while PBL/firmware/hw-artifact routes 500'd.
- Why no test caught it: the only SQLite migration test migrated once against a fresh in-memory DB, and the real-Postgres harness could not start (`Cannot find module 'express'`) and was not in CI.

### Fog remaining
- GitHub Actions results for the new `pg-smoke` job are unverified — no `gh` CLI and no network from here; YAML parses and the steps run locally, nothing more.
- `GET /api/installer/agent-version` returns 404 `{"error":"Device not found"}` — `/:deviceId` shadows the literal route. Pre-existing, found while probing, **not fixed**.
- The Electron path (`electron/server-starter.js`) was not exercised; it sets `USE_SQLITE` deliberately and is masked from the new conflict guard only because it never sets `DATABASE_URL`.
- Agent/Windows behaviour and firmware were not touched — if the user's crash is there, this session does not cover it.

### Debt items closed
- None. This was an undiscovered defect with no ledger entry (D-001..D-021 and D-100..D-211 are unrelated); recorded here rather than retro-fitted onto a ledger item.

### Debt items still open
- D-120 (BitLocker detection real-media residual), D-129 (hardware window), D-130 (code signing rollout), and the 9 enforcement paths still `verified-in-unit-test`.

### Blockers
- D-129 hardware window — unchanged, needs the physical machine.
- GitHub CI confirmation — needs network/credentials unavailable in this environment.
- `scripts/rsh.py` still carries a plaintext SSH password in tracked history; scrubbing history is a decision for the owner (rotating the password is the urgent half).

### Session artifacts
- Diff: 9 modified + 2 new files (258 insertions). New: `scripts/run-pg-smoke.sh`, `server/tests/migrationIdempotency.test.js`.
- Server: 631 tests pass; pg-smoke 65/65 on real PG 16; eslint clean.
- Healed DB: `server/lockdown.db` now at schema_migrations 001–013 with `pbl_kv_store`, `hw_test_artifacts`, and the firmware-audit columns present.

### Failure attribution
- **Layer 4 — Verification feedback** (primary): the migration test ran once on a fresh DB and the one real-Postgres harness could not start, so no gate could ever observe drift. Harness change applied: drift regression test + `pg-smoke` in CI + `make pg-smoke`.
- **Layer 2 — Context provision**: "USE_SQLITE is a dev/Electron switch, never combined with DATABASE_URL" was never written down, and the deciding file (`server/.env`) is gitignored, so its effect was invisible in review. Harness change applied: the conflict is now an explicit `validateEnv` error and the startup log names the driver actually loaded.
- **Layer 5 — State management**: `schema_migrations` silently diverged from the real schema across sessions with nothing to detect it. Harness change applied: startup now heals and logs drift; production refuses to serve on a failed migration.

### Next session opening
The DB layer is now honest and self-healing (driver logged, drift healed, prod fail-fast, pg-smoke in CI) — next: triage the remaining "it never works as expected" reports against the Electron app and a real Windows agent run, since this session only proved the server/Postgres/SQLite paths.

---

## Session 140 — continuation (installer route, Electron run, CI lint, credential scrub)

### RULE-ZERO
- **Read**: `server/src/routes/installer.js` — route registration order (`/:deviceId` at 1496 vs `/agent-version` at 1616).
- **Read**: `server/tests/installer.routes.test.js`, `server/tests/helpers.js` — `createApp`/`makeToken` factories, supertest conventions.
- **Read**: `electron/main.js`, `electron/config.js`, `electron/server-starter.js`, `electron/preload.js`, `dashboard/src/api/client.js` — the actual serverless wiring (`ELECTRON_API_BASE_URL` → preload → `window.electronApp.apiBaseUrl` → axios baseURL).
- **Read**: `.github/workflows/release.yml`, `.github/workflows/ci.yml` — runner labels and the new pg-smoke job.
- **Read**: `scripts/rsh.py`, `scripts/hp_ssh.py` — embedded host/user/password and `AutoAddPolicy`.
**Finding**: (1) `/agent-version` was unreachable because Express matches registration order — the auto-update check always got `404 {"error":"Device not found"}`. (2) The Electron app is a **serverless shell**: it has no database and never sets `USE_SQLITE`, so my earlier S140 claim that it does was wrong — `server-starter.js` only serves `dashboard/dist`. (3) The repo is private (GitHub API 404), so CI status needs a token; local `actionlint` 1.7.12 is clean, and an older 1.7.7 produced a false positive on `macos-15-intel` (which does exist — reverted). (4) `scripts/rsh.py` was tracked with a plaintext password and `AutoAddPolicy`.

### IMPLEMENT
- `server/src/routes/installer.js` — literal `/agent-version` registered before `/:deviceId`, with a comment recording why order matters.
- `server/tests/installer.routes.test.js` — 2 tests: router stack order, and the endpoint no longer answering "Device not found".
- `scripts/rsh.py`, `scripts/hp_ssh.py` — credentials now come from `RLS_SSH_*` env vars; strict host-key verification by default (`RLS_SSH_INSECURE=1` to opt out).
- Git history rewritten with `git-filter-repo --replace-text` to expunge the password from all 323 commits (backup bundle kept outside the repo).

### VERIFY
- Installer: 25/25 tests in `installer.routes.test.js`; full server suite **38 suites / 633 tests pass**.
- Electron (real run, not reasoning): `config.saveWorkerUrl` → `config.json` on disk → `ELECTRON_API_BASE_URL` → `startStaticServer` over the **real** `dashboard/dist`: `/` 200 `no-cache`, `/devices` 200 SPA fallback serving `index.html`, `/assets/index-D9ptcHx7.js` 200 `immutable` (614230B), server closed cleanly. The Electron **binary cannot run here** (`libnspr4.so` missing, no xvfb), so the GUI/main-process path is still unproven.
- CI: `actionlint` 1.7.12 over all 5 workflows → **exit 0** (includes the new `pg-smoke` job). Repo API requires auth, so workflow *run* results remain unchecked.
- Credentials: `git log --all -S '<redacted-password>'` → 0 commits; `git log -p --all | grep -c` → 0; stashes 0; reflog pruned; old commit `58f5ac4` unreachable. Working tree/refs intact (1361 files, 323 commits), `origin` re-added after filter-repo dropped it.

### Fog cleared
- The Electron desktop app genuinely has no local database — the S140 DB defect cannot affect it, and the app only needed its Worker URL.
- The `macos-15-intel` runner-label "defect" was a stale-local-tool false positive, not a workflow bug.
- `/api/installer/agent-version` 404 was pure route ordering, not a missing feature.

### Fog remaining
- Electron GUI path (main process, preload → renderer baseURL, updater) still unrun: `libnspr4.so` missing and no xvfb on this host.
- GitHub Actions run status unverified — private repo, no token.
- **Rotation not performed**: 192.168.1.40 and 192.168.1.219 both refuse port 22 from here, so the password cannot be changed on the hosts right now. It must be treated as compromised.
- Force-pushing the rewritten history is a manual, coordinate-with-collaborators step; local `origin` still points at the old remote history.
- The unknown-asset SPA fallback returns 200 + `index.html` for a missing `.js` (browser shows a MIME error instead of 404). Behaviour observed, not changed.

### Debt items closed
- None (no ledger entry described these; the harness gaps are recorded here and fixed).

### Debt items still open
- D-120, D-129, D-130 and the 9 `verified-in-unit-test` enforcement paths — unchanged.

### Blockers
- D-129 hardware window (unchanged).
- Both SSH test hosts offline → credential rotation blocked until they are reachable.
- GitHub CI confirmation needs a token.

### Session artifacts
- Commits: `15fb329` (db driver + migration drift + pg-smoke harness/CI), `175287e` (installer route order), `1353c13` (credential sanitization), `53a3c57` (graph/docs/memory). All SHAs are post-rewrite.
- Pre-rewrite backup: `~/rls-pre-scrub-20261027-110852.bundle` (contains the old history, i.e. the secret — delete once satisfied).
- Server 633 tests; actionlint 1.7.12 clean; pg-smoke 65/65.

### Failure attribution
- **Layer 4 — Verification feedback** (again): the installer route had no test asserting registration order, and CI linting never ran locally, so both defects survived. Harness change: route-order tests; `actionlint` now available at `~/.local/bin/actionlint`.
- **Layer 3 — Execution environment**: Electron cannot start on this host (`libnspr4.so`, no xvfb), which is why the GUI path is still unverified. Harness change needed: a containerised or xvfb-backed Electron smoke test in CI.
- **Layer 2 — Context provision**: embedding credentials in a tracked helper was normalised by repetition. Harness change: env-only credentials + strict host keys, enforced by review.

### Next session opening
Rotate the two SSH passwords on the hosts as soon as they are reachable and force-push the rewritten history with `git push --force-with-lease` after coordinating, then close the remaining Electron gap by adding an xvfb-backed GUI smoke job.

### S140 addendum — scrub correction and push reality

- **The scrub leaked into its own log.** While documenting "`git log -S <password>` → 0 commits", the session log quoted the credential verbatim. That committed the secret into a *new*, unpushed commit (`7311c68`), undoing the rewrite. Caught by scanning the push range (`git log -p <remote-head>..HEAD`), not the full history — the whole-history scan had been run *before* that commit existed. The string is now redacted to `<redacted-password>` and a second `git filter-repo --replace-text` pass removed it from all history: 0 occurrences across `--all` **and** across the push range. Lesson recorded: always scan the exact range being published, immediately before publishing.
- **No force-push is required — the earlier advice was wrong.** `origin/master` is `7701f3c` (114 commits); local `master` is a strict superset (326 commits) and `7701f3c` is an ancestor of `HEAD`, so `git push origin master` is a plain fast-forward that discards nothing. (An earlier read of `git ls-remote` suggested divergence; ancestry proved otherwise. A full mirror clone also showed the remote holds 0 occurrences of the old password — the secret never reached GitHub, because this lineage was never pushed.)
- Local `master` is **211 commits ahead** of `origin/master`; publishing is the owner's call.
- Local tag `v1.0.0` and remote `v1.0.0` both point at `bdc4dbf` (pre-dates the secret), so no tag push is needed.

---

## Session 141 — 2026-10-27 (check-sweep fixes: secret leak in device payloads, POSIX path bug)

### RULE-ZERO
- **Read**: `server/src/routes/devices.js` — every response that returns a device row (list 123, detail 129, enroll 160, patch 180, flag-stolen 265, recover 343) plus the `SELECT *` / `RETURNING *` statements that produce them.
- **Read**: `server/src/routes/agent.js` — confirms `api_key_hash` is read server-side for device auth and must stay in the DB.
- **Read**: `agent/agent.py` — the 7 `PROGRAMDATA` sites (101, 208, 219, 2361, 2506, 2665, 3807) and the module-import-time `_log_dir.mkdir()` at line 101.
- **Read**: `.gitignore` (`agent/C:*` rule) and `agent/tests/` conventions.
**Finding**: (a) `api_key_hash` is returned to clients by five endpoints because the rows come from `SELECT *` / `RETURNING *` and are serialised directly — a SHA-256 of the device API key needs no client and only enables offline guessing. (b) `os.environ.get("PROGRAMDATA", "C:\\ProgramData")` runs on Linux with no fallback, so importing `agent.py` creates a literal `C:\ProgramData/LockdownAgent/` directory in the CWD; a test run left one at the repo root, and `.gitignore` only covers `agent/C:*`.

### IMPLEMENT (findings #1 and #2 from the S141 check sweep)
- `server/src/routes/devices.js` — `publicDevice()` strips `api_key_hash` at the serialisation boundary, applied to all 7 device-bearing responses (list, detail, enroll, patch, by-pbl, flag-stolen, recover). Enrollment still returns the plaintext `api_key` once. Extracted the two command-INSERT statements into named constants so the "validated positive integer, cannot inject" argument sits next to the SQL.
- `agent/agent.py` — `_programdata_dir()` replaces 7 copies of `os.environ.get("PROGRAMDATA", "C:\\ProgramData")`; POSIX now resolves to `$XDG_DATA_HOME` or `~/.local/share`, Windows behaviour unchanged.
- `.gitignore` — `C:\\ProgramData/` as belt-and-braces.
- `agent/hw_test_harness.py` — repaired three latent crashes: `tpm_seal.seal_data/unseal_data` (do not exist; real API is `seal_state`/`unseal_state`), `hp_uefi_lockdown._read_current_bios_settings` (does not exist; now uses `_check_sure_admin`/`_check_secure_boot`), and `retry_on_error` raising `None` after exhausting retries. Also wrapped three `json.loads(resp.read())` calls and the `ctypes.windll` access.
- `agent/simulate_lockdown.py` — narrow `command` with `isinstance(dict)` before `.get()`.
- New tests: `server/tests/devices.routes.test.js` (+5), `agent/tests/test_agent_paths.py` (5).

### VERIFY
- Server Jest **638 passed** (was 633; +5). Agent pytest **670 passed** (was 665; +5). `ruff check` + `ruff format --check` clean. `server eslint src/ tests/ --max-warnings=0` exit 0.
- `agent/tests/test_hw_harness.py` passes after the harness repairs.
- Live functional check of the fixed route: `/api/installer/agent-version` → 200 with hash/size (previously always 404).
- Verified each "pre-existing" lens finding against `git diff -U0` hunks before touching it; the 5 `no-sql-in-code-js` hits in devices.js are the integer-validated `commandExpirySql()` interpolation, addressed by extraction rather than suppression.

### Fog cleared
- The sweep's finding #1 and #2 are real and now fixed with regression tests.
- The hardware harness could never have passed E-TPM or captured an HP UEFI before-state — that is why those paths have no hardware artifact.
- `api_key_hash` was returned by seven endpoints, not the three I first reported.

### Fog remaining
- Findings #3 (`openapi.yaml` missing 32 endpoints), #4 (root `npm test` agent stage), #5 (AGENTS.md stale counts + electron description), #6 (firmware README "scaffold") are untouched.
- Playwright + Electron still cannot run on this host (`libnspr4.so` absent; no sudo, no xvfb). Worth a container-based job.
- The 30 pyright platform findings in `agent/agent.py` are exempted via a documented file-level pragma, not fixed; the real fix (narrow the key type before `.encrypt()`, initialise optional modules to `None`) is recorded in that comment.

### Debt items closed
- None (D-120, D-129, D-130 remain open; this session fixed shipping defects that had no ledger entry).

### Debt items still open
- D-120, D-129, D-130 and the 9 `verified-in-unit-test` enforcement paths.

### Blockers
- Hardware window (D-129) unchanged.
- CI cannot be executed locally; the release-permissions change from the previous session is still unverified until a tag push.

### Session artifacts
- Commits `2a984ed` (api_key_hash), `456cfe3` (POSIX data dir), `dd8fd17` (hw harness).
- Test counts: server 638, agent 670, dashboard 197, serverless 331, electron 30.
- Sweep evidence: pg-smoke 65/65, verify-env 60/0/2, API+agent E2E 10/10, installer ZIPs (27 MB Linux / 22.5 MB Windows) inspected.

### Failure attribution
- **Layer 4 — Verification feedback**: the harness's broken calls were invisible because `test_hw_harness.py` only exercises dry-run/unit paths; nothing executed the real E-TPM or HP-UEFI action bodies. Harness change needed: assert that every `module.function` referenced by the harness exists (a 10-line reflection test would have caught both).
- **Layer 2 — Context provision**: `api_key_hash` leaked because "rows come from SELECT *, serialise explicitly" was never written down. Fixed behaviourally via `publicDevice()` plus tests.

### Next session opening
Findings #3–#6 of the S141 sweep remain (openapi's 32 missing endpoints, the broken root `npm test` agent stage, and the stale AGENTS.md / firmware README claims) — start with #4 since it makes the documented verification command work again.

### S141 addendum — findings #4, #5, #6 closed; firmware build re-verified

- **#4 (root `npm test` broken).** `scripts/run-agent-tests.sh` is now the single place that picks the pytest interpreter (agent/.venv when present, python3 with an explicit warning otherwise) and forwards flags. package.json (`test:agent`, `test:agent:coverage`), the Makefile (`test-agent`, coverage) and AGENTS.md all delegate to it. Proof: `npm test` completes — 638 server + 670 agent tests.
- **#5 (AGENTS.md drift).** Counts corrected (388/603/191/54 → 638/670/197/331); `electron/` no longer described as bundling a server; verify-env summary 61/1 → 60/2; sweep section records pg-smoke 65/65, E2E 10/10, actionlint clean, and that Playwright/Electron cannot run on this host.
- **#6 (firmware README).** "Scaffold — all source files are stubs" replaced with the real status (27 modules, ~12.5k lines, 1.26 MB PblApp.efi, QEMU+swtpm verified at 10/0–16/0, D-129/D-130 outstanding), and the matching claim in `PblApp.c` corrected.
- **Firmware tooling.** `scripts/gen-firmware-compile-db.sh` emits a real EDK II `compile_commands.json` (27 TUs, incl. CryptoPkg and PblApp's generated `AutoGen.h`). Without it clangd reported `'Uefi.h' file not found` and 8 cascading type errors; PblApp.c is now at 0 diagnostics.
- **Firmware build re-verified** after this session's edits: `build-pbl.sh --arch X64 --toolchain GCC` completes, producing a 1,355,776-byte `PblApp.efi`.

Verified: server 638, agent 670, ruff + eslint clean, `bash -n` clean on the new scripts, PblApp.c and TpmClient.c at 0 diagnostics.

Still open from the sweep: **#3** — `openapi.yaml` documents 42 of 74 registered endpoints; all 28 `/v1/*` PBL routes and 4 `/api` routes are undocumented.

---

## Session 142 — 2026-10-27 (owned MeshCentral connector, read-only)

### RULE-ZERO
- **Read**: `server/src/index.js` — route require/mount pattern (`app.use('/api/<x>', dashboardLimiter, xRoutes)`, line 132-141).
- **Read**: `server/src/routes/health.js` — minimal router shape, logger usage, typed error returns.
- **Read**: `server/src/middleware/auth.js` — `requireAuth` / `requireRole(minRole)` and ROLE_HIERARCHY.
- **Read**: `docs/adr/INTEGRATION-OWNERSHIP.md` — the ownership rules this code must satisfy (connector not plugin, no hard dependency, authority never leaves our system).
- **Read**: `server/tests/helpers.js` — `createApp`, `makeToken`, `mockPool` conventions for route tests.
**Finding**: integration must be ours, so the connector lives in our server, exposes OUR route namespace and OUR normalized device shape, is off unless configured, and is read-only (inventory only — no lockdown/unlock is ever proxied to an upstream API; those stay in our command queue and audit log). No third-party client library: plain `fetch` with an abort timeout, credential never logged.

### IMPLEMENT (S142)
- `server/src/integrations/meshcentral.js` — READ-ONLY connector: plain `fetch` (no third-party client), 8s abort timeout, `ConnectorNotConfigured` vs `ConnectorUpstreamError`, and OUR normalized device shape (`source/id/name/online/lastSeenAt/platform/meshId`) rather than the upstream's.
- `server/src/routes/integrations.js` — our namespace: `GET /api/integrations` (cheap status, no upstream call) and `GET /api/integrations/meshcentral/devices` (200 / 502 / 503 with machine-readable codes). Auth: `requireAuth` + `requireRole('operator')`.
- `server/src/index.js` — mounted under `/api/integrations` behind the dashboard limiter.
- `server/tests/integrations.routes.test.js` — 8 tests, including an invariant that the connector exports **no mutating operation** (read-only by construction, per the ADR).
- `server/.env.example` — documents the optional vars and that the connector is off by default.
- `docs/openapi.yaml` — both endpoints documented (paths 36 → 38).

### VERIFY
- Server suite: **39 suites / 646 tests pass** (638 + 8 new). `eslint src/ tests/ --max-warnings=0` exit 0.
- Live smoke with no integration configured: `/api/integrations` → `{enabled:false, configured:false, mode:"read-only"}`; `/api/integrations/meshcentral/devices` → **503** `{"code":"NOT_CONFIGURED"}` — off by default, fails soft, no credential echoed.

### Fog cleared
- The connector can be built without any MeshCentral code or client library: their REST surface is two GET/POST calls, so ownership costs nothing in dependency terms.
- A read-only invariant is testable (export-surface check), not just a comment.

### Fog remaining
- No live MeshCentral instance was available, so the UpstreamError path is only exercised by mocked tests — the real `/login` and `/api/nodes` payload shapes should be confirmed against a real server before relying on it.
- `docs/openapi.yaml` still omits the 28 `/v1/*` PBL routes and 4 `/api` routes (sweep finding #3).
- The Hippocratic-2.1 dependency decision (react-leaflet) is still open.

### Debt items closed
- None.

### Debt items still open
- D-120, D-129, D-130; 9 enforcement paths unit-test-only; sweep finding #3.

### Blockers
- D-129 hardware window; Hippocratic licence decision; live MeshCentral instance for connector verification.

### Session artifacts
- Commits: `289f960` (licensing gate), plus this session's connector commit.
- `make check-licenses` exit 0 (964 packages, 0 copyleft); `--strict` fails on the react-leaflet decision.

### Next session opening
Confirm the connector against a real MeshCentral instance (or document it as untested), then close sweep finding #3 by documenting the 28 `/v1/*` PBL routes in `openapi.yaml`.

### S142 addendum — real-MeshCentral verification: the transport premise was wrong

Ran `scripts/verify-meshcentral-connector.sh` against a real
`ghcr.io/ylianst/meshcentral` **1.3.1** instance (account created via the CLI in a
one-off container, because the image ENTRYPOINT wraps commands and the server
must be stopped during account creation).

Result: **3 real error paths verified, and the happy path disproved the design.**

| Case | Outcome |
|---|---|
| not configured | `ConnectorNotConfigured` — PASS |
| unreachable host | `ConnectorUpstreamError`, real socket failure — PASS |
| upstream answers HTML/404 | `ConnectorUpstreamError`, actionable message — PASS |
| real inventory read | **SKIP** — this build has no REST API |

**Finding:** MeshCentral 1.3.1 has no REST API. Every `/api/*` path returns 404
HTML (the web-UI handler); `/api/` appears in the installed tree only inside
`authenticode.js`; and `meshctrl.js`, their own CLI, authenticates over
**WebSocket** (`wss://…/control.ashx`) with the `x-meshauth` header. The
connector's first implementation POSTed JSON to `/login` and read `/api/nodes`
— against the real server that produced `Unexpected token '<'`, then a 404.

Kept (still correct): our route contract, our normalized shape, read-only by
construction, fail-soft, feature-flagged off, and the `x-meshauth` credential
handling (which is the real scheme, just used against a path that does not
exist).

Changed: the connector now detects an HTML response and says so —
"this deployment has no REST API at that path. MeshCentral 1.3.x is
WebSocket-only" — instead of surfacing a JSON parse error. The harness relabels
the credentials case honestly (it proves fail-soft, not auth rejection) and
skips the inventory read while `MC_EXPECT_REST=0`.

Recorded as a decision in `docs/adr/INTEGRATION-OWNERSHIP.md`: (1) implement the
WebSocket protocol (needs `ws` or hand-rolled frames), (2) target a REST/Graph
upstream instead (Tactical RMM, Intune), or (3) require a REST-capable
MeshCentral build. Owner decision; connector stays off until then.

Verified: server suite 39 suites / 646 tests, eslint clean, harness
`ALL CHECKS PASSED`, container and volume removed.

### S142 continuation — Graph transport, OpenAPI 76/76, history published

**#1 Connector transport swapped (commit `d97a77c`).** The S142 finding was that
MeshCentral 1.3.x has no REST API, so the connector could never read inventory
from it. Instead of implementing their WebSocket protocol, the transport the ADR
pointed at is now in place:
- `server/src/integrations/errors.js` — shared ConnectorNotConfigured /
  ConnectorUpstreamError, so the route no longer imports a connector to catch
  its errors.
- `server/src/integrations/graph.js` — Microsoft Graph managedDevices, OAuth2
  client credentials with a cached token, `@odata.nextLink` pagination capped at
  20 pages, read-only by construction. Graph has no online flag, so `online`
  derives from last sync within 15 minutes (our heuristic, documented; contract
  unchanged).
- `server/src/integrations/index.js` — registry with a load-time shape check.
- `routes/integrations.js` — `GET /api/integrations/:id/devices` replaces the
  upstream-specific path; unknown ids answer 404 UNKNOWN_CONNECTOR with the
  available list. `/api/integrations/meshcentral/devices` still works.
- 11 tests (649 server total). The read-only invariant now checks the public
  surface only — my first version flagged `_resetTokenCache` because "reset"
  contains "set", which is a test-seam, not a mutation.

**#2 OpenAPI gap closed (commit `82e102e`).** 42 of 76 routes were documented.
- `scripts/check-openapi-routes.js` — mount-aware diff of the Express router
  against `docs/openapi.yaml` (handles the `/v1` wrapper mount and `:param` →
  `{param}`); exits 1 on any gap. Wired into `lint` and a CI job.
- 34 path entries added (76/76, 62 paths), summaries taken from each handler's
  own comment block (JSDoc and pbl.js's `// ---` banner style). Payload schemas
  are deliberately not invented — each says the shape is defined by the handler.
- Fixed two bugs of mine: the integration paths had been inserted after the
  "# Components" banner (valid YAML, wrong section), and the checker's first
  pass treated any column-0 line as the end of `paths`, hiding everything after
  the first banner.

**#3 History published.** `origin/master` was a strict ancestor, so this was a
plain fast-forward, not the force-push earlier assumed:
`7701f3c..82e102e  master -> master` (231 commits). Both our own pre-push gate
and `git merge-base --is-ancestor` were run *before* pushing.

### VERIFY
- Server **39 suites / 649 tests**; eslint `--max-warnings=0` clean.
- `make check-openapi` → `registered 76 / documented 76 — every registered route is documented`.
- `make pre-push-check` → fast-forward, no credential-shaped content in range.
- Remote verified in sync: `origin/master == HEAD == 82e102e`.
- actionlint clean on all workflows (6 lint jobs now).

### Fog cleared
- MeshCentral cannot provide inventory over REST; Graph is the working transport.
- The API spec now matches the router, and drift is mechanically impossible to
  reintroduce silently.

### Fog remaining
- Graph's happy path is unit-tested against its documented response shape only —
  no Azure tenant was available, so it has never spoken to live Graph.
- **Password rotation is still blocked**: both 192.168.1.40 and 192.168.1.219
  refuse port 22 from here.
- The Hippocratic-2.1 dependency decision (react-leaflet) and the repository
  licence choice remain owner decisions.

### Debt items closed
- None (sweep finding #3 closed, which was not a ledger item).

### Debt items still open
- D-120, D-129, D-130; 9 enforcement paths unit-test-only.

### Blockers
- D-129 hardware window (the dominant one); both SSH hosts offline; licence and
  Hippocratic decisions.

### Next session opening
Prep the hardware session: turn `firmware/PblPkg/HARDWARE-TEST-PLAN.md` plus the
harness into a step-by-step runbook with artifact capture, so the D-129 window
converts the 9 unit-tested enforcement paths into hardware-verified ones.

---

## Session 143 — 2026-10-27 (D-129 runbook, Phase A harness tests, I3 evidence integrity)

### RULE-ZERO
- **Read**: `firmware/PblPkg/HARDWARE-TEST-PLAN.md` (329 lines), `agent/hw_test_harness.py` registry + all 12 test classes + `HardwareTest` lifecycle, `.devin/skills/hw-test-harness-v2/SKILL.md`, `tests/conftest.py`, `tests/test_hw_harness.py`.
- **Read**: `.devin/graph/graph_assert.py` (I3 + full sweep), `graph_loader.py`, `GRAPH-SPEC.yaml` (13 enforcement nodes), `agent/tests/test_graph_assertions.py` (15 tests, none covering I3), all four `hw_test_artifact*.json`.
- **Read**: `scripts/pre-push-check.sh`, `scripts/prepush_secrets.py`, `Makefile` (`pre-push-check`, `hw-test*`, `test-coverage`), `lint.yml`, `ci.yml`; every agent entry function the new tests drive (`decrypt_folder`, `ack_command`, `write_pending_ack`, `drain_pending_ack`, `handle_unlock`, `handle_track`, `check_deadman`, `handle_lockdown`, `queue_offline`, `drain_offline_queue`, `check_for_update`, `download_update`, `verify_update_signature`).

**Finding 1 — the inherited plan was not achievable.** Of the 9 `verified-in-unit-test` paths, only `E-HP-UEFI` had a harness test. Measured: `--tag <path>` exits 1 (`No tests match tags`) for the other 8; `grep -ci` over the harness gave `deadman` 0, `track` 0, `offline_queue` 0, `auto_update` 0, `effectiveness` 0. The other 7 tests cover paths that are not graph nodes at all.

**Finding 2 — I3 was a string check.** `verified-on-hardware` needed only a non-empty `hardware_artifact_ref`; the file was never opened. `E-BCD` cited an artifact recording `E-BCD-01 FAIL`.

**Finding 3 — a second unread artifact schema, and it agrees.** `agent/hw_test_artifact_live_hp.json` (2026-08-21, real HP `HP-SPARE-TEST`, UUID 128028639200715) is a live lockdown→unlock run using an `enforcement_paths` map: `E-ENCRYPT/E-LOCK-SCREEN/E-GUARDIAN PASS`, **`E-BCD FAIL`**, **`E-HP-UEFI FAIL`** (`critical_applied=0`), `boot_lock_status: partial`, `lockdown_effective: false`, `active → stolen → locked → recovering → active`.

**Finding 4 — the secret gate existed but was never armed.** `scripts/pre-push-check.sh` was tracked 100644, so its own documented usage failed with "Permission denied"; `.git/hooks/pre-push` did not exist; no CI job ran the scanner.

**Already done, not work** (stale audit entries): E2E is wired (`make test-e2e`, `test-e2e-dashboard`, Playwright in `ci.yml:293`); the effectiveness loop is closed server-side (`integrity.agent-routes.test.js:204` asserts `lockdown_effective=false` when `critical_applied_total=0`) and rendered red in the dashboard.

**IMPLEMENT**
- `docs/D-129-HARDWARE-RUNBOOK.md` (new, ~495 lines) — two evidence streams (firmware serial log vs harness CTRF); per-path coverage/assertion table; window-day order (rotation → inventory → Secure Boot posture → firmware → safe → TPM → network → destructive → auto-update last); artifact naming and the `#TEST-ID` claim rule; abort/rollback keyed on `rolled_back`; exact `GRAPH-SPEC.yaml` edit shape.
- `agent/hw_test_harness.py` — 8 new tests (`E-DECRYPT-01`, `E-ACK-01`, `E-RECOVERY-01`, `E-TRACK-01`, `E-DEADMAN-01`, `E-EFFECTIVENESS-01`, `E-OFFLINE-QUEUE-01`, `E-AUTO-UPDATE-01`), registry 12 → 20, plus `_StubServer` (real `ThreadingHTTPServer`, records requests, per-path status/GET bodies), `_agent_cfg`, `_patch_agent_state` (mandatory isolation from live `C:\ProgramData\LockdownSystem`), `_Checks`/`_PhaseATest` (failures name themselves in the artifact). Retry semantics: `retries or self.default_retries` for network tests. `TestEnroll` reads `RLS_ADMIN_KEY`.
- `agent/agent.py` — `handle_lockdown` generates one `command_uuid` per command, persists it in the pending ACK and reuses it for every ACK of that command (both `failed` paths). Idempotent retry was previously false.
- `.devin/graph/graph_assert.py` — I3 check 3 `hardware_artifact_must_support_claim` + `artifact_supports_claim()`: repo-relative/absolute/`file#TEST-ID` refs, must exist, parses all three artifact schemas, requires a PASS for that path's own test id; non-JSON refs (serial logs) require the fragment.
- `.devin/graph/GRAPH-SPEC.yaml` — **E-BCD demoted** to `verified-in-unit-test`, FAIL artifact kept as evidence-of-attempt with `verification_note` and corrected `risk_notes`.
- `agent/tests/test_graph_assertions.py` — 15 new `TestI3ArtifactClaim` self-tests (PASS/FAIL/SKIP × 3 schemas, missing file, unreadable JSON, fragment present/absent/mismatched, non-JSON evidence, contradicted claim raises, demoted path may still cite its attempt). `agent/tests/test_hw_harness.py` — counts 12 → 20 + `test_every_graph_enforcement_path_has_a_harness_tag` + retry-semantics test.
- `.github/workflows/lint.yml` — `secrets` job: scans exactly the publish range (PR base → `github.event.before` → full history on purpose), `fetch-depth: 0`, SHA-pinned checkout.
- `scripts/pre-push-check.sh` — mode 100644 → 100755; `.git/hooks/pre-push` installed (local, unversioned).

**VERIFY**
- Harness: 8 new tags `--mode simulate` → **8 passed / 0 failed**, 81 assertions (8/17/14/10/6/7/7/12); full run **11 passed, 9 skipped, 0 failed, 0 errors** (was 5/7); dry-run 20 tests 0 errors; `--mode check` 8 ELIGIBLE.
- Graph: I3 fired on the real data (*"E-BCD marked 'verified-on-hardware' but the referenced artifact does not record a PASS (E-BCD-01=FAIL)"*), then **all invariants pass** after demotion. Convergence now honest at **3/13** (phases 17/17, debt 52/55).
- Tests: agent **689 passed** (+19), server **649 passed**; `ruff check` + `ruff format --check` clean; `actionlint` clean on all workflows; `bash -n` on the script.
- Scanner proven both directions on a throwaway repo: synthetic `AKIA…` commit → exit 1 with rule/file/commit and the value never echoed; clean range → exit 0.
- `make archive-trace` rotated 50 sessions (trace 3298 → 661 lines); `make gen-state` regenerated `current-state.md`.

**Failure attribution**
- **Layer 4 — Verification feedback.** I3 asserted the presence of an artifact reference, not its content, so a contradicted hardware claim survived every sweep, and `test_graph_assertions.py` had no I3 case. Harness change: 15 self-tests with pass *and* fail fixtures; the invariant now reads the evidence it cites.
- **Layer 3 — Execution environment.** The secret gate existed as a script but not as an installed hook or CI job, and the script was not executable, so the documented command could not run. Harness change: CI job + `--install` verification + `chmod +x` in git.
- **Layer 1 — Task specification.** The previous handover said the hardware window "converts the 9 unit-tested paths"; 8 had no test. Harness change: `test_every_graph_enforcement_path_has_a_harness_tag` makes coverage a checked property instead of an assumption.

### Fog cleared
- 8 of 9 enforcement paths had no harness coverage; all 13 graph paths now have a runnable tag.
- I3's rule was a string check; two independent hardware runs (Azure VM, HP SPARE-TEST) agree E-BCD applies nothing.
- The pending-ACK retry was not idempotent — it invented a new `command_uuid` per attempt.
- E2E wiring and the server/dashboard effectiveness loop were already complete (stale audit entries).

### Fog remaining
- None of the 8 new paths has run on Windows or the hardware target; Windows-bound collaborators are stubbed and named per class.
- `E-AUTO-UPDATE` verifies against a generated Ed25519 key, not a real signed build.
- Coverage never runs in CI (`make test-coverage` works locally; no workflow, no thresholds).
- react-leaflet / Hippocratic-2.1 still blocks `check-licenses-strict`.
- I3 now verifies hardware claims only; `verified-in-unit-test` / `verified-in-ci` remain unchecked strings.
- `~/rls-pre-scrub-20261027-110852.bundle` still holds the credential; deletion awaits owner confirmation.

### Debt items closed
- None. D-129 is *prepared* and Phase A is done; its close criteria still need a booted PblApp.efi on real hardware.

### Debt items still open
- D-120, D-129, D-130. Enforcement: 3/13 verified-on-hardware (4/13 included one contradicted claim).

### Blockers
- D-129 hardware window; credential rotation needs console access; no Azure tenant for live Graph; repository licence + react-leaflet decisions are owner calls.

### Session artifacts
- Files: `docs/D-129-HARDWARE-RUNBOOK.md` (new), `agent/hw_test_harness.py`, `agent/agent.py`, `.devin/graph/graph_assert.py`, `.devin/graph/GRAPH-SPEC.yaml`, `agent/tests/test_hw_harness.py`, `agent/tests/test_graph_assertions.py`, `.github/workflows/lint.yml`, `scripts/pre-push-check.sh` (mode), `docs/README.md`, `.devin/skills/hw-test-harness-v2/SKILL.md`.
- Artifacts: `/tmp/DESKTOP-G4PCDHH-20261027-phase-a.json`; runbook §3 and §7 tables.

### Next session opening
Wire `make test-coverage` into CI with per-component thresholds, then replace react-leaflet so `check-licenses-strict` can gate the build.

### S143 continuation — coverage gate wired into CI (the P0 audit item)

**RULE-ZERO.** Read all five coverage setups: `server/jest.config.js` and
`electron/jest.config.js` (collectCoverageFrom, reporters), `dashboard/vitest.config.js`
and `serverless/vitest.config.js` (v8 provider, reportsDirectory), `agent/pyproject.toml`
(`[tool.coverage.run]`/`[tool.coverage.report]`, `addopts`), the `test-coverage`
Makefile target, `scripts/run-agent-tests.sh` (forwards `"$@"` to the venv pytest),
`.gitignore` (coverage dirs already ignored), and the five test jobs in `ci.yml`.

**Baseline measured, not assumed** (`make test-coverage`, 2026-10-27):
server 68.18/64.06/71.85/69.06 · agent 61% stmts (3347/5465) · dashboard
60.61/70.15/52.38/60.61 · serverless 85.48/81.67/92.59/85.48 · electron
39.4/47.36/30.95/39.3.

**Finding — the first dashboard coverage run "failed", but not because of
coverage.** Five page-render tests hit their 15s timeout (collect 916s, 457s
wall) while the plain suite is green. The host was saturated by an unrelated
project (`clipforge` ffmpeg render + my own ast-grep/pyright/opengrep), load
average 26–46 on 8 cores. Re-run with `--testTimeout=60000`: **197/197 pass**.
So the failure was the timeout budget under load, not the instrumentation —
recorded here so it is not re-diagnosed as a vitest bug.

**IMPLEMENT**
- Floors declared per component, each ~2 points under the measurement and dated:
  `server/jest.config.js` 66/62/70/67 · `electron/jest.config.js` 37/45/29/37 ·
  `dashboard/vitest.config.js` 58/68/50/58 · `serverless/vitest.config.js`
  83/79/90/83 · `agent/pyproject.toml` `fail_under = 59`.
- `dashboard/package.json` — coverage script raises `--testTimeout=60000`, with
  the reason in `vitest.config.js`; the plain `test` script keeps 15s.
- `Makefile` — `test-coverage` now runs every component through the same script
  CI uses (`npm run test:coverage`, not bare `npx vitest`) and passes
  `--cov-fail-under=59` for the agent (pytest-cov decides on the flag, not on
  `fail_under`).
- `ci.yml` — the five per-component jobs run their coverage scripts **in place
  of** the plain test commands, so the gate costs no extra CI minutes and cannot
  drift from local. No duplicate workflow.
- `AGENTS.md` — coverage items in the harness audit corrected (server, agent,
  dashboard, cross-cutting theme 1, P0) plus `make test-coverage` in the
  verification command list. Also corrected two stale claims found while there:
  "E2E is orphaned" (it is wired) and "no conftest.py" (it exists).

**VERIFY**
- `make test-coverage` → **exit 0**, all five components under the gate:
  server 68.18/64.06/71.85/69.06 · agent 61% · dashboard 60.61/70.15/52.38/60.61
  (197/197) · serverless 85.48/81.67/92.59/85.48 (331/331) · electron
  39.4/47.36/30.95/39.3.
- Negative tests prove the gate fails closed, both providers:
  jest `--coverageThreshold '{"global":{"lines":99}}'` → *"Coverage for lines
  (39.3%) does not meet global threshold (99%)"*, exit 1 with 30/30 tests
  passing; vitest `--coverage.thresholds.lines=99` → *"ERROR: Coverage for lines
  (85.48%) does not meet global threshold (99%)"*, exit 1 with 331/331 passing.
- `actionlint` clean on `ci.yml` (12 jobs) and `lint.yml`; YAML parses.

**Fog remaining.** The graph/memory/firmware harnesses still have no coverage.
Agent coverage measures statements only (no `--cov-branch`). The `clipforge`
render makes wall-clock timings on this host unreliable — percentages are sound,
durations are not.

**Next session opening**
Replace react-leaflet + @react-leaflet/core (Hippocratic-2.1) with a small
in-repo wrapper over leaflet 1.9.4 (BSD-2-Clause) so `make check-licenses-strict`
can gate the build.

### S143 continuation — the ProLiant box: what it can and cannot do (measured)

**Context.** The owner offered a server for the blocked items. It is a **HP
ProLiant DL380p Gen8** (`debian`, 100.114.96.76 via Tailscale, Debian 13,
32 threads, 15 GB, 931 GB, Docker 29.9 + `/dev/kvm`, no sudo for the login user).

**Hardware verdict (measured on the box).**
- **No TPM at all** — `/sys/class/tpm/` exists but is empty, no `/dev/tpm*`.
  PBL issues 69 `TPM2_*` calls, so **Stream A / D-129 proper is impossible here**,
  and a Gen8 TPM kit is 1.2 anyway.
- Booting **legacy BIOS** (`/sys/firmware/efi` absent); BIOS P70 05/21/2018.
- No Windows installed, so the 12 Windows-bound agent paths cannot run here.
- `.40` and `.219` are dead from *this* box too (no ICMP, no ports) — the earlier
  "SSH refused" was not a routing quirk of my host; those machines are off.

**Path defect found (the real blocker).** The Tailscale path between this WSL
host and the server is a one-way blackhole above ~1 KB: 200 B and 800 B arrive,
1.6 KB arrives as 0 B; ssh, rsync and plain HTTP all stall identically, while
server→WSL moves 20 MB fine. Neither end grants sudo, so `ip link set
tailscale0 mtu`, `tailscale set --operator` and Taildrop were all unavailable.
Practical consequence: **nothing can be pushed to that box** — an 8-chunk
`cat >>` upload (700 B per chunk) did move a 3743 B file intact, which is the
only transfer mechanism that works. Recorded with the measured table and the fix
commands in `docs/LOAD_TESTING.md`.

**Real defect found and fixed in the server.** `config/env.js` required
`DB_HOST/DB_NAME/DB_USER/DB_PASSWORD` whenever `NODE_ENV=production` and no
`DATABASE_URL` — **without checking `USE_SQLITE`**. `docker-compose.test.yml`
sets exactly that combination, so the "quick local test stack" could never boot
(it exited with four `… is required … (production)` errors). That is why that
compose file had only ever been structurally validated. Fixed: SQLite mode skips
the Postgres requirement; two regression tests added to `tests/env.test.js`
(SQLite-in-production passes, non-SQLite-in-production still fails).

**Load testing: first executed run, ever.** Server booted in
`NODE_ENV=production` + `USE_SQLITE=true` (the fixed path), 200 devices seeded
via `scripts/seed-loadtest-devices.js`, k6 0.x in Docker on the 32-core box,
200 VUs / 60 s / 1 s poll. Result: **200 requests, 100 % timed out, p95 59.9 s,
thresholds breached** — caused by the path defect above, not the server (health
endpoint answered throughout). The harness itself now provably executes
end-to-end; its numbers are only meaningful once generator and server share a
healthy path.

**VERIFY**
- `curl /api/health` from the box → `{"status":"ok"}` before, during and after.
- Server suite **649 passed** after the `env.js` change; `npx jest tests/env.test.js`
  → 14 passed; `eslint src/ tests/ --max-warnings=0` clean.
- k6 container logs captured (timeout warnings, 100 % `http_req_failed`,
  threshold breach, and the `--summary-export` permission error that a
  read-only mount produces).

**Fog cleared.** The offered box cannot close D-129 (no TPM) or the Windows
paths (no Windows); it is a compute resource, not a test platform. The
`docker-compose.test.yml` stack was broken at config validation, not merely
unexercised.

**Fog remaining.** Whether the box is usable at all depends on the tailnet MTU
fix (owner action, needs sudo on this host or the server). Load-test numbers
remain unmeasured until then; k6 scripts still lack HMAC signing.

**Next session opening**
Once the owner lowers the tunnel MTU (or grants Taildrop), re-run
`k6-baseline.js` and persist the first real baseline; until then the next
codeable item is replacing react-leaflet so `check-licenses-strict` can gate the
build.

### S143 close-out — the two owner items I could actually do

- **Pre-scrub bundle deleted.** `~/rls-pre-scrub-20261027-110852.bundle` (3,930,088 B)
  `shred -u`'d after verifying which refs are unique to it: its pre-rewrite
  master tip `b0bd0b3` was the **only** content not already reachable in the
  current repo (task branch `8f5152b`, stash `c6d678b` and `origin/*` all resolve
  locally). Checked the remaining `-S` hit for `RLS_SSH_PASSWORD`: the single
  match is commit `1353c13`, the one that *removed* the hardcoded credentials and
  introduced the env-var name — a name, not a value.
- **Platform `.pem` ignored.** `a0baa8a3-…-RemoteLockdownPlatformKey.pem` contains
  1 `BEGIN CERTIFICATE` and 0 `PRIVATE KEY` blocks (public cert, not a secret).
  Added `*-RemoteLockdownPlatformKey.pem` to `.gitignore` with the reason and the
  place to put it if it should ever be tracked (`firmware/PblPkg/`, next to
  `pbl-test-signing.crt`); `git check-ignore` confirms it is now ignored.

- **Not doable by me, with evidence:** `sudo -n` → *"interactive authentication is
  required"* (user is in the `sudo` group, so the owner can run it; no `pkexec`
  on this host), so `ip link set tailscale0 mtu` and `tailscale set --operator`
  are owner actions. No GitHub API credential exists anywhere here (no `gh` CLI,
  no `~/.config/gh`, no `GITHUB_TOKEN`/`GH_TOKEN`, no credential helper, remote is
  `git@github.com:Unccllin/remote-lockdown-system.git`), so a runner registration
  token cannot be minted from this host. The repository licence is a grant of
  rights and belongs to the copyright holder — implementable by me in one edit,
  not decidable by me.

## Session 144 — 2026-10-28 (load testing executed for the first time; two real defects)

### RULE-ZERO
- **Read**: `tests/load/k6-{baseline,lockdown-spike,mixed}.js`, `server/src/middleware/hmacAuth.js`
  (signing scheme, per-device key requirement), `scripts/seed-loadtest-devices.js`,
  `docker-compose.test.yml`, `server/src/config/env.js`, `server/src/index.js` boot order,
  `docs/LOAD_TESTING.md`.
- **Finding 1**: the tailnet path to the owner's ProLiant is one-way broken above ~800 B
  (client→server), so nothing can be pushed; server→client moves 20 MB fine.
- **Finding 2**: `docker-compose.test.yml` could never boot — `env.js` demanded Postgres vars
  in production without checking `USE_SQLITE` (fixed this session, see S143).
- **Finding 3**: the schedulers start before migrations, so every fresh DB logs two errors.

### IMPLEMENT
- `docs/LOAD_TESTING.md` — measured baseline table, `K6_AGENT_KEY` trap, generator-placement
  rule, path-requirements section with the measured byte-size table.
- `server/src/index.js` — retention + alert schedulers moved into the post-`runMigrations()`
  `.then()`; they were started at module load and hit a non-existent schema on every fresh DB.
- `tests/load/results/k6-{baseline,lockdown-spike}-dl380p-20261028.json` — committed artifacts.

### VERIFY
- **First executed load test in the project's history**, on the DL380p Gen8 (32 threads,
  SQLite, `REQUIRE_HMAC=false`, 200 seeded devices), generator on the dev host:
  - `k6-baseline.js` 200 VUs / 60 s → **10,225 req, 168 req/s, p95 355 ms, 0.00 % errors, exit 0**.
  - `k6-lockdown-spike.js` 200 VUs / 60 s → **10,842 req, 178 req/s, p95 302 ms, 0.00 % errors,
    exit 0**, and all 200 lockdown commands fetched + ACKed (`ack ok` 200/0).
  - Server log: 2 errors, both startup (now fixed); no `SQLITE_BUSY`; 33 k warnings, all
    `hmacAuth: unsigned request` — proof the k6 scripts still do not sign HMAC.
- Fresh-DB boot after the scheduler fix: `Migrations complete.` → `Server running`, **zero**
  `level:50` lines (was two).
- Server suite **39 suites / 651 tests pass**; `eslint src/ tests/ --max-warnings=0` clean.

### Fog cleared
- The load harness executes end to end and its thresholds are enforced by exit code
  (a failing run exits 99; the JSON export's `"thresholds": false` is a reporting quirk).
- The two sudo commands the owner was asked for are **not needed** for this work: inverting
  which side runs the server removes the dependency entirely.
- Small-payload chunked upload over `ControlMaster` works (700 B chunks, 184 KB in 86 s,
  md5-verified) — the only transfer that survives this path.

### Fog remaining
- Real fleet-scale numbers (1000 VUs) are unmeasured; 200 VUs was chosen to keep the SUT
  honest on SQLite.
- k6 scripts still lack HMAC signing (now quantified: ~1 warning per request).
- The box still cannot close D-129 (no TPM) or run the Windows paths (no Windows).
- The owner's MTU fix would let the repo be rsynced whole and a self-hosted runner be
  registered; neither is blocking anything I can do.

### Debt items closed
- None.

### Debt items still open
- D-120, D-129, D-130; enforcement 3/13.

### Blockers
- D-129 hardware (TPM 2.0 + a Windows target); Azure tenant for Graph; owner decisions on
  licence / react-leaflet.

### Next session opening
Replace react-leaflet + @react-leaflet/core (Hippocratic-2.1) with a wrapper over leaflet
1.9.4 (BSD-2-Clause) so `make check-licenses-strict` can gate the build.

### S144 continuation — the repo is on the box, and the load tests now sign HMAC

**Owner said the chunk commands were mine to run.** They were, so I ran them.
`dd bs=700 | ssh` was tried first and failed (0 bytes in 2.5 min — ssh coalesces
stdio writes into oversized packets), so per-invocation 700 B chunks over a
`ControlMaster` remain the only transfer. 7,934,939 B / 11,336 chunks, **md5
identical on both sides** (`9ca13a45…`), extracted to `~/repo`.

**IMPLEMENT — HMAC signing for the load scripts (the audit's open P2 item).**
Per-device keys derived from one secret (`tests/load/lib/sign.js`), fresh nonce
per request, `authHeaders()` as the single entry point; the seeder stores
`api_key_hash` via the server's own `hashApiKey()` so the pepper cannot drift;
all three scripts sign per request; `tests/load/hmac-probe.js` proves enforcement
one property at a time. Full detail in `docs/LOAD_TESTING.md`.

**VERIFY** — local verifier accepts the derivation and rejects tampered body /
wrong key / stale timestamp / bad nonce; `k6 inspect` resolves the import; signed
spike under `REQUIRE_HMAC=true` → **10,138 req, 166 req/s, p95 337 ms, 0.00 %
failures, exit 0**; probe 5/5 (correct 200, corrupted signature 401, stale 401,
unknown key 401, replay 401); full repo boots on the box with 0 errors.

**Correction worth keeping.** A wrong `K6_HMAC_SECRET` yields 100 % failures for
the *wrong* reason — an unknown `x-agent-key` is rejected by `agentAuth` before
the signature is examined. Only the probe distinguishes "signature enforced" from
"unknown key rejected".

**Fog remaining.** 1000-VU runs still unmeasured (200 was chosen so SQLite
remains the honest SUT). `k6-mixed.js` admin-scenario paths are wired for signing
but not exercised (need an admin token seeded).

### S144 close-out — mixed load scenario, and what "admin token" actually means

**Owner asked which admin token was needed ("is it the ssh root or …").** It is
**not** a system credential: `k6-mixed.js` sends `Authorization: Bearer
<K6_ADMIN_TOKEN>` to `/api/devices` and `/api/audit`, so it needs an *application*
JWT. Nothing about SSH, the ProLiant's user, or root is involved, and the owner
had nothing to supply.

Minted it myself against a throwaway DB via the first-admin bootstrap:
`POST /api/setup/create-admin` → 201 (super-admin; the route 403s permanently once
any admin exists), then `POST /api/auth/login` → 252-char JWT. Token written to a
0600 temp file, used, deleted.

**VERIFY — third and last scenario now executed (signed + admin traffic):**
`k6-mixed.js`, 100 VUs / 60 s, server enforcing `REQUIRE_HMAC=true`:
**5,357 requests, 88 req/s, p95 72 ms, 0.00 % failures, k6 exit 0**, and all 11
checks green — `p(95)<800` ✓ 72.24 ms, `rate<0.02` ✓ 0.00 %, `GET /api/devices`
200, `GET /api/audit` 200, `checkin status is 200`, `ack status is 200`.
Artifact: `tests/load/results/k6-mixed-signed-dl380p-20261028.json`.
Server on the box stopped afterwards; nothing left running.

**All three load scenarios have now been executed** — baseline, lockdown spike,
mixed — the first two unsigned and then the spike and mixed signed under
enforcement. `docs/LOAD_TESTING.md` carries the measured tables plus the
first-admin bootstrap recipe.

## Session 145 — 2026-10-28 (Devin co-author credit removed; push guards fixed)

**Asked for:** remove Devin AI as a contributor. Investigation showed **no
attribution in any tracked file** — every "Devin" string outside `.devin/` is a
path reference to this project's own harness directory. The credit existed only
in git history: 259 `Co-Authored-By: Devin <…devin-ai-integration[bot]@…>`
trailers plus 257 `Generated with [Devin](https://devin.ai)` lines (two message
variants; the first pass only caught the trailer form, the second pass removed
the markdown-link form). Author/committer was always `unccllin`; the bot was
never an author.

**Safety:**
- Full bundle of every ref: `~/rls-pre-contrib-rewrite-20261028-084955.bundle`
  (15 MB, 346 commits, HEAD `0b823d8` = the pre-rewrite remote tip).
- 5 stashes exported to `/tmp/stash-patches/stash-*.patch` first.
- 79 uncommitted files from the session committed before touching history.
- Two `git filter-repo --force --message-callback` passes (trailer form, then
  attribution-line form). `--message-callback` only rewrites messages, so **file
  content is provably untouched**: the tree hash of the pre-rewrite tip
  (`63a4fde02dcb…`) is identical to the tree of its rewritten counterpart.

**Evidence repair (the risk that mattered):** every SHA from `3b55d22` onward
changed, so 18 cited commit references in `trace.md` and `DEBT-LEDGER.md` would
have pointed at commits that no longer exist — and I2 only checks that a
`commit_ref` is a **non-empty string**, so the rot would have been silent.
Repointed all 17 by matching (author date, subject) against the bundle clone,
plus the stash reference (`6990763` → `c6d678b`). Verified: every repaired
reference resolves; **zero** references broken by this rewrite remain.

**Found while verifying:** 17 other cited hashes in the same files were **already
dangling before this rewrite** — casualties of the S140 credential scrub
(`4ed2f48`, `60c0a78`, `d111ada`, `ee311de`, `7311c68`, `58f5ac4`, …). They do
not resolve in the pre-rewrite bundle either, so those commits exist nowhere and
cannot be repaired, only annotated. Not caused by this session.

**State:** 348 commits, clean tree, branches `master` + `task/installer-security`,
tag `v1.0.0` retargeted, `origin` re-added (filter-repo removes it).
`git log --all` → 0 trailers, 0 attribution mentions, 0 `devin.ai` /
`devin-ai-integration` strings. Graph invariants pass; `current-state.md`
regenerated.

**Not done, deliberately:** the force-push. GitHub still shows the old history
(`refs/heads/master` = `0b823d8`, `refs/tags/v1.0.0` = `21ac6ce`) until the owner
pushes; the old objects stay reachable by SHA until GitHub GCs them.

### S144 — contributor credit rewritten and PUSHED; two guards fixed on the way

**Pushed** (authorized with "proceed", SSH auth confirmed as `Unccllin`):
- `master`: `0b823d8… → c998b08…` forced (348 → 349 commits).
- `v1.0.0`: `21ac6ce… → bdc4dbf…` forced — without this the tag keeps the purged
  chain reachable, which is the usual way this half-works.

**The push guard blocked twice, correctly, and both were real work:**
1. `assigned-secret: scripts/verify-environment.sh` → the value is
   `base64("test-api-key")` in an NSIS verify fixture. Fixed with a scoped,
   justified entry in the new `.prepush-allow.txt` (the scanner's documented
   mechanism: rule + path, never values).
2. Three `assigned-secret` FAILs in `agent/installer_gui.py`,
   `dashboard/src/pages/EnrollPage.jsx`, `dashboard/src/pages/SetupPage.jsx` —
   inspected line by line and are all non-values: a function-signature type
   annotation, two JSON/object keys whose values are runtime variables, an
   empty-string form field, and a human-readable validation message that merely
   starts with the word "Password". All false positives; three more scoped
   entries, each with the reason inline.

   **The S140 lesson bit again inside this very entry.** The first version of the
   paragraph above quoted each matched string verbatim — and the guard then
   blocked the push because `.devin/graph/trace.md` and the generated
   `current-state.md` had become the leak. Quoting the string to prove it is safe
   is the same mistake as quoting it to prove it leaked. Descriptions only, never
   the value.
   `--allow-rewrite` was run deliberately and separately from the push.

**Real bug found in our own hook.** `.git/hooks/pre-push` forwarded git's
positional hook args (`<remote-name> <remote-url>`) into `pre-push-check.sh`,
whose parser rejects unknown arguments — so **every tag push was blocked** with
`unknown argument: origin`. Fixed in the `--install` template (args are no longer
forwarded, with a comment saying why), reinstalled, and verified by invoking the
hook exactly as git does: exit 0.

**Verification after the push:** remote `refs/heads/master` and `refs/tags/v1.0.0`
both point at rewritten commits; a fresh mirror clone of the remote scans **0**
Devin trailers, **0** attribution lines, and only `.devin/` path references
remain (the project's own harness directory, unrelated to the vendor).

**Kept:** `~/rls-pre-contrib-rewrite-20261028-084955.bundle` (15 MB) — the only
copy of the pre-rewrite history, i.e. the only rollback path. Delete on request.

### S144 — failure attribution: three failed pushes, one hook bug, one bad report

**Failure attribution — Layer 4 (Verification feedback) and Layer 2 (Context
provision).** I reported "push exit=0" and "guard exit=0" for commands that had
in fact failed. Cause: I wrote `git push … | tail -6; echo "exit=$?"`, which
reports **tail's** status, not git's. Every success claim was later re-verified
without a pipe, but the intermediate messages were wrong, and the pipeline
pattern is the reason. Harness change: capture `$?` immediately after the git
command, never after the pipe.

Git operations that genuinely failed, and their resolution:
1. `git push --force origin refs/tags/v1.0.0` → `[BLOCK] unknown argument: origin`.
   The installed pre-push hook forwarded git's positional hook args into
   `pre-push-check.sh`, whose parser rejects them, so **every tag push was
   blocked**. Fixed in the `--install` template, reinstalled, retested through the
   real hook (exit 0).
2. `git push origin master` → the scanner flagged the session-log files. The
   block was correct: my own trace entry had quoted the strings it was describing.
   Reworded to describe, never reproduce.
3. Retry → blocked again on the earlier unpushed commit that still held them.
   Resolved by collapsing both unpushed commits into one, not by allowlisting
   `.devin/graph/*` (the exact path S140 leaked through).
4. `git ls-remote origin` after each filter-repo pass → origin is removed by
   filter-repo; re-added each time.
5. Stash patch export came out empty for one stash: its content lives in the
   untracked-files parent, which `show -p` omits. Re-exported with
   `--include-untracked` (607 lines).

**Post-hoc audit (pipes avoided):** `git fsck` clean; no in-progress operations;
`master` local == remote (`fe76548`, 351 commits each); tag `v1.0.0` local ==
remote (`bdc4dbf`); linked worktree `/home/cllin/lockdown-installer-security` on
`8f5152b`, clean, tree matches HEAD; 5 stashes intact; `git bundle verify` →
"records a complete history".

### Fog cleared
- Devin AI no longer appears as a contributor: 261 attribution lines stripped from
  347 commits, verified by a **fresh mirror clone from GitHub** (0 trailers, 0
  attribution lines, 0 bot handle / devin.ai strings). Content is provably
  unchanged — the pre/post tree hash for the old tip is identical.
- Our own pre-push hook was blocking **every tag push** (forwarded git's hook args
  into a flag parser). Fixed in the `--install` template and retested through the
  real git path.
- The secret scanner's allow-list is now used as designed: four scoped entries
  (rule + path + inline reason), no values, no blanket exemptions.

### Fog remaining
- GitHub's contributor list recalculates on its own schedule, and the pre-rewrite
  objects stay reachable by SHA until it GCs them. Nothing further to do locally.
- 17 commit hashes cited in `trace.md` / `DEBT-LEDGER.md` were already dangling
  before today (S140 casualties) and cannot be repaired — those commits exist
  nowhere, including the backup bundle.
- `task/installer-security` exists only locally; the linked worktree is clean but
  unpushed.

### Debt items closed
- None.

### Debt items still open
- D-120, D-129, D-130; enforcement paths still 3/13 verified on hardware.

### Blockers
- D-129 needs a machine with TPM 2.0 **and** a Windows target; the available
  ProLiant has neither (no TPM module, Debian only).
- Owner decisions outstanding: repository licence, react-leaflet (Hippocratic-2.1).

### Next session opening
Replace react-leaflet and @react-leaflet/core (Hippocratic-2.1) with a small
in-repo wrapper over leaflet 1.9.4 (BSD-2-Clause) so `make check-licenses-strict`
can gate the build.

### S145 addendum — deeper audit found nothing broken, one thing still open

Re-ran the audit with stricter checks after the owner asked twice:
- `git fsck --full --strict` → clean, **0 dangling objects**; no `refs/original`;
  every ref (`master`, `task/installer-security`, `origin/*`, `refs/stash`,
  `v1.0.0`) points at post-rewrite commits.
- **No commit was lost.** Comparing (author date, subject) multisets with embedded
  hashes normalised: 346 pre-rewrite → 346 present, 0 missing. The 8 additions are
  6 of this session's commits plus 2 stash commits the bundle clone never fetched.
  Four commits looked "changed" only because their messages cite commit hashes and
  the rewrite remapped those hashes inside the subject — verified per commit (old
  resolved in the bundle, new resolves now, identical apart from the hash).
- Corrected a flaw in my own check: the first comparison script matched two lines
  containing `D-210` and reported a false miss.

**Still open, and now measured rather than assumed:** the pre-rewrite tip
`0b823d8` is **still fetchable from GitHub by SHA** (`git fetch --depth=1 origin
<sha>` succeeds). So the attribution is gone from every ref and from the
contributor list's input, but the objects persist on GitHub until it garbage
collects unreachable commits — a schedule it does not publish. Prompt removal
requires a support request (same route as a secret purge). A local tree cannot
change that.

**Also unverifiable from here:** whether GitHub's contributor list has already
recalculated. No API token exists on this host, so that is a browser check.

### S145 — CI failures: one cause found and fixed, and a mistake of mine

Owner reported "most workflows have failed". I cannot read Actions runs from this
host (private repo, no API token: `api.github.com/.../actions/runs` → 404), so I
worked from what my pushes actually triggered:

| Triggered by my pushes | Jobs | Note |
|---|---|---|
| `ci.yml` (push to master, 4 times) | 12 | 5 of them now run coverage gates I added |
| `lint.yml` (same pushes) | 7 | includes the new `secrets` job |
| `codeql.yml` | 1 | |
| `release.yml` | 7 | **fired by the `v1.0.0` tag force-push**; needs 3 `AZURE_TRUSTED_SIGNING_*` + 5 `APPLE_*` secrets |

**Definite cause, found and fixed.** `python3 scripts/prepush_secrets.py --all`
(the path the `secrets` job takes when a force-push leaves no reachable base
commit) exited 1 on `.prepush-allow.txt` — my own allow-list comments quoted the
patterns they were describing, so the allow-list itself became the finding,
including in the historical blob. Fixed by describing findings without quoting
them, and by collapsing my four unpushed commits into one so no commit in the new
history carries the quoted text. Verified: `--all` → exit 0, and the scan over the
new history alone → 0 FAILs.

**My mistake, recovered.** I first tried to scrub that historical blob with
`git filter-repo --replace-text`, which is **not path-scoped** — it rewrote the
literals in every blob, including `dashboard/src/pages/EnrollPage.jsx` and
`SetupPage.jsx`, i.e. it corrupted real source. It was unpushed, so
`git reset --hard origin/master` restored the exact code (verified: validation
line present, api_key line present, no replacement text anywhere, and a fresh
clone of the remote confirms). The correct fix needed no blob surgery at all.
Lesson: `--replace-text` is global; use a path-checked blob callback, or fix the
file and rewrite the small number of unpushed commits.

**Not verifiable from here:** whether the other CI jobs fail, and why. The
`release.yml` jobs are the most likely broad failure — a tag push triggers them
and they require signing secrets this repo may not have. Suite-level checks all
pass locally with 2 points of slack, so the coverage gates I added are a
possibility but not a demonstrated cause.

## Session 146 — 2026-10-28 (completing the test suite; two silent harness failures)

**RULE-ZERO.** Read `Makefile` (`test`, `full-verify`), the five component test
commands, `scripts/test_memory.py` / `test_graph_session.py`, the CI
`script-tests` job, and `scripts/prepush_secrets.py`'s invocation.

**Bug 1 — `full-verify` lied about coverage.** Its own comment said "Tests (all 5
test suites)"; `test` ran server, agent and dashboard only. Worker (331 tests) and
electron (30) were never part of the local sweep. `test` now includes them plus a
new `test-scripts` target, so the local sweep matches CI.

**Bug 2 — a test command that could not fail.** `scripts/test_memory.py` contains
44 pytest-style tests and had **no `__main__` block**. Running it directly imported
those functions, executed none, and exited 0 — which is exactly how the CI
`script-tests` job ran it (`python3 scripts/test_memory.py`). That job has never
tested the memory harness. Added a runner (`pytest.main`, with an explicit error
if pytest is absent) and made CI install pytest — it previously installed only
pyyaml, so even a correct runner could not have worked there. Verified:
44 passed.

**Gaps closed with tests that provably fail.**
- `server/tests/loadSigning.test.js` (11 tests) — the load-test signing contract
  (`tests/load/lib/sign.js` cannot be imported into Jest, so the contract is
  locked against `hashApiKey`/`verifyApiKey`/`verifyHmac`): key derivation is
  deterministic and 44-char base64, hashes to an accepted `api_key_hash`, a
  sign.js-shaped request verifies, and six single-field tampers are rejected.
  Previously the only evidence was a manual probe against a live server.
- `server/tests/bootOrder.test.js` (1 test) — spawns the real entry point against
  a throwaway SQLite DB and asserts no `no such table` errors, that migrations
  complete before the server listens, and that the DB file was created. Proved it
  has teeth by reintroducing the bug in an isolated copy of `server/`: the test
  failed with both original errors (`no such table: devices`,
  `no such table: location_reports`).

**Sweep result — `make full-verify`, exit 0, "FULL VERIFICATION PASSED":**
graph-check ✓ · lint (eslint ×2, ruff + format, tsc worker, OpenAPI 76/76) ✓ ·
server 663 (41 suites) ✓ · agent 689 ✓ · dashboard 197 ✓ · worker 331 ✓ ·
electron 30 ✓ · script harness 27 + 44 ✓ · API E2E 10 ✓ · verify-env
**60 PASS / 0 FAIL / 2 SKIP** ✓ · docker live validation ✓ · artifacts ✓.

Note: the agent suite's summary line does not print — `pyproject.toml` adds `-q`
and `run-agent-tests.sh` adds another, so pytest runs at `-qq` and emits dots
only. Countable (9×72+41 = 689) but it makes the log look truncated; left as-is.

**AGENTS.md** test counts corrected (638→663 server, 670→689 agent) and the
sweep's real coverage recorded, with both harness bugs named.

### Fog cleared
- The local sweep now actually runs every component suite; `full-verify`'s claim
  matches what it does.
- The memory harness has 44 real, executing tests — and they pass.
- The load-test signing scheme and the boot order are both covered by tests that
  fail when the behaviour regresses (both verified by reintroducing the fault).
- `make full-verify` is green end to end: exit 0, verify-env 60 PASS / 0 FAIL /
  2 SKIP, E2E 10/10, docker live validation passed.

### Fog remaining
- CI run status is still unreadable from this host (private repo, no API token);
  whether the jobs fail, and why, remains unverified. `release.yml` is the most
  likely broad failure (7 jobs needing Azure + Apple signing secrets, fired by the
  `v1.0.0` tag push).
- The hardware-backed enforcement paths remain 3/13 verified on hardware — no
  test change can move that.
- The agent suite prints no summary line under `-qq`; countable but opaque.

### Debt items closed
- None.

### Debt items still open
- D-120, D-129, D-130; enforcement 3/13 on hardware.

### Blockers
- D-129 needs a machine with TPM 2.0 and a Windows target; the ProLiant has
  neither.
- Owner decisions: repository licence; react-leaflet (Hippocratic-2.1).
- CI failures need either a fine-grained token (Actions: read) or the failing job
  names.

### Next session opening
Replace react-leaflet and @react-leaflet/core (Hippocratic-2.1) with a small
in-repo wrapper over leaflet 1.9.4 (BSD-2-Clause) so `make check-licenses-strict`
can gate the build.
