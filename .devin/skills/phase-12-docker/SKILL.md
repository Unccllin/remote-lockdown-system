---
name: phase-12-docker
description: Docker Compose validation, test compose file, and production deployment documentation
---

# Phase 12 — Docker Compose Validation

## Context

docker-compose.prod.yml exists for production deployment. This phase validates
the full stack (Postgres + server + Caddy) and provides deployment documentation.

## Current State

### Docker Files
- `docker-compose.prod.yml` — Postgres + server + Caddy production stack
- `docker-compose.yml` — dev/test with Docker secrets
- `docker-compose.test.yml` — test-specific compose file (SQLite mode, no Postgres, no Caddy, port 3001)
- `.env.prod.example` — production env template
- `Caddyfile` — Caddy reverse proxy config (auto-HTTPS)
- `Dockerfile.server` — server image (builds and copies dashboard/dist, serves static + SPA fallback)

### Validation Script
- `scripts/validate-docker.sh` — comprehensive Docker validation
  - `--config` — validate compose file syntax (`docker compose config` if available)
  - `--env` — validate all required env vars are present in .env.prod
  - `--caddy` — validate Caddyfile syntax
  - `--dockerfile` — validate Dockerfile syntax (hadolint if available)
  - `--live` — actually start stack, health check, clean up (requires Docker)
  - `--all` — run all checks
  - Exit 0 if all pass, 1 if any fail
  - Uses `--env-file .env.prod` for Docker Compose (required — Docker Compose only auto-loads `.env`, not `.env.prod`)

### Deployment Documentation
- `docs/DEPLOYMENT.md` — step-by-step production deployment guide
  - Prerequisites (Docker, domain, DNS)
  - Secret generation
  - Docker compose commands (with `--env-file .env.prod`)
  - Health verification
  - Troubleshooting

### Docker Compose Prod Stack
- PostgreSQL 14+ with volume
- Node.js server (Dockerfile.server)
- Caddy for auto-HTTPS + reverse proxy
- Secrets via Docker secrets or env vars
- `DB_SSL: "false"` for internal network (no SSL on docker-compose internal network)

## Verification

```bash
# Validate Docker config (all checks)
scripts/validate-docker.sh --all

# Validate individual aspects
scripts/validate-docker.sh --config
scripts/validate-docker.sh --env
scripts/validate-docker.sh --caddy
scripts/validate-docker.sh --dockerfile

# Live validation (requires Docker running)
scripts/validate-docker.sh --live

# Verify test compose file exists
ls docker-compose.test.yml

# Verify deployment docs exist
ls docs/DEPLOYMENT.md

# Full environment verification (includes Docker validation)
make verify-env

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify validate-docker.sh supports --live flag**: `grep -c "\-\-live" scripts/validate-docker.sh`
2. **Verify docker-compose.test.yml uses SQLite (no Postgres)**: `grep -i "sqlite\|postgres" docker-compose.test.yml`
3. **Validate compose file syntax**: `docker compose -f docker-compose.prod.yml config --quiet 2>/dev/null || echo "Docker not available"`
4. **Verify --env-file .env.prod is documented**: `grep -r "env-file.*env.prod" scripts/validate-docker.sh docs/DEPLOYMENT.md`
5. **Verify DB_SSL=false is set in prod compose**: `grep "DB_SSL" docker-compose.prod.yml`

## Gotchas

- Docker Compose only auto-loads `.env`, NOT `.env.prod` — must use `--env-file .env.prod` explicitly
- `DB_SSL_VERIFY=false` still negotiated SSL — `DB_SSL=false` disables SSL entirely (needed for docker-compose internal network with no SSL)
- `Dockerfile.server` builds and copies `dashboard/dist` into the image — server serves both API (`/api/*`) and built dashboard (static files + SPA fallback)
- Caddyfile and `Dockerfile.server` are NOT YAML — do not YAML-validate them
- `validate-docker.sh` validates config files and optionally runs Docker if available (`--live` flag)

## Graph Integration

**Phase node**: `P12` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P12` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-DOCKER

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: — (none)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
