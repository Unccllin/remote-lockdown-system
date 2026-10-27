#!/usr/bin/env bash
# run-pg-smoke.sh — run the real-PostgreSQL smoke test.
#
# The Jest suite runs entirely on SQLite (via sqlitePool), so PG dialect bugs
# are invisible to it. tests/pg-smoke/pg-smoke.js exercises the lockdown →
# recover flow against a real PostgreSQL server, but until S140 it could not
# even start (`Cannot find module 'express'`) and was never wired into CI.
#
# Usage:
#   scripts/run-pg-smoke.sh                 # ephemeral docker postgres:16
#   PG_SMOKE_URL=postgres://... scripts/run-pg-smoke.sh   # use your own server
#
# Exit codes: 0 pass, 1 failure (including "docker not available").

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
err()  { printf "${RED}[FAIL]${NC} %s\n" "$1"; }
info() { printf "${YELLOW}[..]${NC} %s\n" "$1"; }

CONTAINER="rls-pg-smoke"
PORT="${PG_SMOKE_PORT:-55432}"
DB_NAME="lockdown_db"
DB_USER="postgres"
DB_PASS="pg-smoke-password"

cleanup() {
  if [ "${USING_DOCKER:-0}" = "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -n "${PG_SMOKE_URL:-}" ]; then
  DATABASE_URL="$PG_SMOKE_URL"
  info "Using PG_SMOKE_URL (no container will be started)"
else
  if ! command -v docker >/dev/null 2>&1; then
    err "docker not found and PG_SMOKE_URL is unset"
    echo "    Either install Docker or provide PG_SMOKE_URL=postgres://user:pass@host:port/db"
    exit 1
  fi

  USING_DOCKER=1
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  info "Starting ephemeral postgres:16 on port $PORT"
  if ! docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$DB_PASS" \
    -e POSTGRES_DB="$DB_NAME" \
    -p "$PORT:5432" \
    postgres:16-alpine >/dev/null 2>&1; then
    err "could not start postgres:16 (is the daemon running?)"
    exit 1
  fi

  ready=0
  for _ in $(seq 1 40); do
    if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != "1" ]; then
    err "postgres did not become ready within 40s"
    exit 1
  fi
  ok "postgres ready"

  DATABASE_URL="postgres://${DB_USER}:${DB_PASS}@127.0.0.1:${PORT}/${DB_NAME}"
fi

# pg-smoke sets USE_SQLITE=false itself; pass the rest explicitly.
export DATABASE_URL
export DB_SSL=false
export DB_SSL_VERIFY=false

info "Applying migrations (PostgreSQL dialect)"
if ! (cd "$PROJECT_ROOT/server" && node src/db/migrate.js >/tmp/pg-smoke-migrate.log 2>&1); then
  err "migrations failed — see /tmp/pg-smoke-migrate.log"
  tail -5 /tmp/pg-smoke-migrate.log
  exit 1
fi
ok "migrations applied"

info "Running pg-smoke (lockdown → recover, HMAC, JSONB, encryption)"
if (cd "$PROJECT_ROOT/tests/pg-smoke" && node pg-smoke.js); then
  ok "pg-smoke passed"
else
  err "pg-smoke failed"
  exit 1
fi
