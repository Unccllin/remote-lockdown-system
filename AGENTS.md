# AGENTS.md — Remote Lockdown System

Project-specific guidance for AI agents working in this repo.

## Project Layout

- `server/` — Node.js / Express API + PostgreSQL/SQLite (CommonJS, Jest)
- `dashboard/` — React + Vite + Tailwind admin UI (ESM, Vitest)
- `agent/` — Python background agent (pytest, ruff)
- `electron/` — Electron desktop app bundling server + dashboard + agent
- `scripts/` — single source of truth for build/verify logic (wrapped by Makefile)
- `.devin/skills/phase-N-*` — knowledge base for the 16 production-readiness phases

## Environment

- Node.js lives at `~/.local/node/bin` (NOT on default PATH). Prefix commands with
  `export PATH="/home/cllin/.local/node/bin:$PATH"` or add it to your shell rc.
- Python 3.14 is the interpreter (`python3`). Agent dev deps live in `agent/.venv`.
- Docker is NOT installed in this environment — docker-compose configs are validated
  structurally only (via `scripts/validate-docker.sh`).

## Verification Commands (clean sweep)

```bash
# Everything (unified runner): server Jest + agent pytest
export PATH="/home/cllin/.local/node/bin:$PATH"
npm test

# Per-component
cd server   && npm test                       # 283 Jest tests
cd agent    && python3 -m pytest tests/ -q    # 137 pytest tests
cd dashboard && npx vitest run                # 21 Vitest tests

# Lint
cd server    && npx eslint .                  # exit 0 = clean
cd dashboard && npx eslint .                  # exit 0 = clean
cd agent     && python3 -m ruff check .       # exit 0 = clean
cd agent     && python3 -m ruff format --check .

# Build
cd dashboard && npx vite build                # outputs dashboard/dist
cd electron  && node --check main.js preload.js server-starter.js config.js updater.js

# Syntax sweep of all .js (not .jsx — JSX needs vite/vitest to validate)
find server/src electron -name '*.js' | grep -v node_modules | xargs -I{} node --check {}

# Shell scripts
bash -n scripts/*.sh

# Full environment + artifact verification (56 checks)
make verify-env
make check-structure      # non-fatal; electron/dist-electron is expected missing locally

# Full build (dashboard + agent + electron) — slow, needs PyInstaller + electron-builder
make build
```

## Known Local-Only Skip (not a failure)

- `installer-windows-execpolicy` — by design. The PS1 script intentionally does
  not set `ExecutionPolicy` internally; the caller invokes it with
  `-ExecutionPolicy Bypass`. Hardcoding `Set-ExecutionPolicy` inside an installer
  is bad practice. The script's PowerShell syntax is validated separately and passes.

## Docker (installed on this machine)

- Docker 29.1.3 + compose v2.40.3 installed via apt (`docker.io`, `docker-compose-v2`).
- The `docker` group was added to user `cllin`, but a new login session is needed
  for it to take effect. Until then, `sudo chmod 666 /var/run/docker.sock` grants
  socket access for the session (resets on reboot).
- The prod stack is started with `--env-file .env.prod` (required — Docker Compose
  only auto-loads `.env`, not `.env.prod`):
  ```bash
  docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
  ```

## Conventions

- Server is CommonJS (`require`/`module.exports`); dashboard is ESM (`"type": "module"`).
- **Frontend + backend are merged** — the server serves both the API (`/api/*`)
  and the built dashboard (static files + SPA fallback) from one Express process.
  CORS is only enabled when `CORS_ORIGIN` is set (dev with Vite on :5173).
- Agent Python is ruff-governed (`agent/ruff.toml`); 108 lint errors were previously
  driven to 0 — keep it that way.
- Do not duplicate build logic in the Makefile — delegate to `scripts/`.
- PS1 files are PowerShell, not bash — do not `bash -n` them (use `pwsh -NoProfile`
  if available; `verify-environment.sh` already does this).
- Caddyfile and `Dockerfile.server` are NOT YAML — do not YAML-validate them.
- `server/lockdown.db` is a dev artifact — never commit it (in `.gitignore`).

## Diagnostic Sweep Results (2026-08-04)

All green: 283 server tests, 137 agent tests, 21 dashboard tests, eslint clean on
server + dashboard, ruff clean + formatted on agent, vite build OK, all shell scripts
`bash -n` OK, all YAML configs valid, all local imports resolve, git tree clean.
`verify-environment.sh` final: **61 PASS / 0 FAIL / 1 SKIP** (the 1 skip is the
intentional `installer-windows-execpolicy` by-design skip).

### Bugs found and fixed during the sweep

1. **`verify-environment.sh` nsis-compile guard bug** — `has node` (PATH-based
   `command -v`) ran before the `~/.local/node/bin/node` fallback, making the
   fallback unreachable. Fixed: guard now accepts either PATH node or the fallback.
2. **Docker Compose `.env.prod` not loaded** — `docker-compose.prod.yml` uses
   `${POSTGRES_PASSWORD}` interpolation, but Docker Compose only auto-loads `.env`,
   not `.env.prod`. The README and `validate-docker.sh` were missing `--env-file
   .env.prod`, so `docker compose up` failed with "superuser password not specified".
   Fixed: added `--env-file .env.prod` to both `README.md` and `validate-docker.sh`.
3. **`DB_SSL_VERIFY=false` still negotiated SSL** — `server/src/db/pool.js` treated
   `DB_SSL_VERIFY=false` as "use SSL but don't verify certs", but the docker-compose
   internal network has no SSL at all. The `pg` driver still tried to negotiate SSL
   and failed with "The server does not support SSL connections". Fixed: added a
   `DB_SSL` env var (`DB_SSL=false` disables SSL entirely); updated
   `docker-compose.prod.yml` to use `DB_SSL: "false"`.
4. **`verify-environment.sh` docker-live pipe race** — the live check used
   `"$validate_script" --live 2>&1 | grep -qi "pass|ok|healthy"`, but the large
   Docker build output on stderr caused a pipe race where grep sometimes missed
   the PASS line. Fixed: capture output to a variable first, then grep.
5. **Prod stack dashboard not served** — `Dockerfile.server` built and copied
   `dashboard/dist` into the image, but `server/src/index.js` had no
   `express.static` middleware. The dashboard was inaccessible in production.
   Fixed: added static serving + SPA fallback with proper cache headers
   (immutable for hashed assets, no-cache for index.html). Also made CORS
   conditional (only when `CORS_ORIGIN` is set) and added a 404 JSON handler
   for unmatched `/api/*` routes.
