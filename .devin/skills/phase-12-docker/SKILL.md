# Skill Domain: Phase 12 — Docker Compose Validation

## Context
docker-compose.prod.yml exists for production deployment but has never been tested end-to-end. Secrets files don't exist, Caddy config is untested, and the full stack (Postgres + server + Caddy) hasn't been validated.

## Current State
- docker-compose.prod.yml — Postgres + server + Caddy
- docker-compose.yml — dev/test with Docker secrets
- .env.prod.example — production env template
- Caddyfile — Caddy reverse proxy config
- Dockerfile.server — server image
- scripts/generate-secrets.sh — generates secrets (Phase 1)

## Research Findings
### Docker Compose Prod Stack
- PostgreSQL 14+ with volume
- Node.js server (Dockerfile.server)
- Caddy for auto-HTTPS + reverse proxy
- Secrets via Docker secrets or env vars

### Validation Steps
1. Generate secrets using scripts/generate-secrets.sh
2. Create .env.prod from .env.prod.example
3. `docker compose -f docker-compose.prod.yml config` — validate compose syntax
4. `docker compose -f docker-compose.prod.yml up -d` — start stack
5. Verify health: `curl http://localhost/health`
6. Create admin: `POST /api/setup/create-admin`
7. Login, enroll device, verify API works
8. `docker compose -f docker-compose.prod.yml down` — clean shutdown

### Test Script Design
- Can't run actual Docker in this environment
- But CAN validate: compose file syntax, env var completeness, Caddyfile syntax, Dockerfile syntax
- Create a validation script that checks everything except actual Docker execution

## Reasoning Questions
1. **Should the test script actually run Docker?**
   - Answer: No — Docker may not be available. The script should validate config files and optionally run Docker if available (`--live` flag).

2. **Should we add a docker-compose.test.yml?**
   - Answer: Yes — a test-specific compose file that uses SQLite instead of Postgres, no Caddy, just the server. For quick local validation.

## Implementation Guidelines
### scripts/validate-docker.sh
- `--config` — validate compose file syntax (`docker compose config` if available)
- `--env` — validate all required env vars are present in .env.prod
- `--caddy` — validate Caddyfile syntax
- `--dockerfile` — validate Dockerfile syntax (hadolint if available)
- `--live` — actually start stack, health check, clean up (requires Docker)
- `--all` — run all checks
- Exit 0 if all pass, 1 if any fail

### docker-compose.test.yml
- Just the server with SQLite mode
- No Postgres, no Caddy
- For quick local testing
- Maps port 3001

### docs/DEPLOYMENT.md
- Step-by-step production deployment guide
- Prerequisites (Docker, domain, DNS)
- Secret generation
- Docker compose commands
- Health verification
- Troubleshooting

## File Boundaries
- CREATE: `scripts/validate-docker.sh`, `docker-compose.test.yml`, `docs/DEPLOYMENT.md`
- DO NOT EDIT: `docker-compose.prod.yml`, `docker-compose.yml`, `Caddyfile`, `Dockerfile.server`
