#!/usr/bin/env bash
# verify-docker-stack.sh — bring the production stack up locally and smoke it.
#
# Why this exists
# ---------------
# The API E2E harness (`tests/e2e/`) boots Express **in-process on SQLite**
# through supertest. It never exercises what actually ships: the Node container,
# PostgreSQL 16, the built dashboard served statically, and the compose wiring
# (env-var secrets, healthchecks, DATABASE_URL). `validate-docker.sh` only checks
# the files structurally — it validates YAML and Dockerfile shape, not that the
# stack runs.
#
# So "the tests pass" and "the deployment works" were separate claims, and only
# the first was ever executed. This script executes the second:
#
#   build the real image -> start postgres + server -> wait for DB readiness
#   -> drive the public API over HTTP (unauthenticated 401, first-admin signup,
#      authenticated device list, device creation) -> tear down
#
# Usage:
#   scripts/verify-docker-stack.sh              # build, run, smoke, tear down
#   scripts/verify-docker-stack.sh --keep       # leave the stack running
#   scripts/verify-docker-stack.sh --no-build   # reuse an existing image
#   VERIFY_PORT=3101 scripts/verify-docker-stack.sh
#
# Requirements: docker + compose v2, .env.prod present (see .env.prod.example).
# Exit code: 0 all smoke checks passed, 1 any failure (logs are printed).
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 2

PROJECT="pbl-verify"
PORT="${VERIFY_PORT:-3001}"
BASE="http://127.0.0.1:${PORT}"
KEEP=0
BUILD=1
BODY_OK=0

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
fail() { printf '\033[31m[FAIL]\033[0m  %s\n' "$*" >&2; BODY_OK=1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)     KEEP=1; shift ;;
    --no-build) BUILD=0; shift ;;
    -h|--help)  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f .env.prod ] || { fail ".env.prod is missing — copy .env.prod.example and fill it in"; exit 1; }
docker compose version >/dev/null 2>&1 || { fail "docker compose v2 not available"; exit 1; }

# The server publishes no ports in the production file (Caddy fronts it), so a
# verification-only override publishes it on loopback. Nothing else changes: the
# stack still runs the production image, the production env wiring and the real
# PostgreSQL — the point is to test those, not a test-only variant of them.
OVERRIDE="$(mktemp -d)/override.yml"
cat > "$OVERRIDE" <<YAML
services:
  server:
    ports:
      - "127.0.0.1:${PORT}:3001"
YAML

COMPOSE=(docker compose -p "$PROJECT" --env-file .env.prod
         -f docker-compose.prod.yml -f "$OVERRIDE")

# shellcheck disable=SC2317  # invoked indirectly, via trap ... EXIT
cleanup() {
  if [ "$KEEP" = "1" ]; then
    info "stack left running (project $PROJECT) — stop with:"
    info "  docker compose -p $PROJECT --env-file .env.prod -f docker-compose.prod.yml down -v"
    return
  fi
  info "tearing down (project $PROJECT, volumes included)"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Probe helpers ---------------------------------------------------------------
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || echo 000; }
json_field() { python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }

# 1. Build ------------------------------------------------------------------
if [ "$BUILD" = "1" ]; then
  info "building the server image (dashboard + API) — this is the slow part"
  if ! "${COMPOSE[@]}" build server >/tmp/pbl-verify-build.log 2>&1; then
    fail "image build failed — see /tmp/pbl-verify-build.log"
    tail -20 /tmp/pbl-verify-build.log >&2
    exit 1
  fi
  ok "image built"
else
  info "skipping build (--no-build)"
fi

# 2. Start ------------------------------------------------------------------
info "starting postgres + server"
if ! "${COMPOSE[@]}" up -d postgres server >/tmp/pbl-verify-up.log 2>&1; then
  fail "compose up failed — see /tmp/pbl-verify-up.log"
  tail -20 /tmp/pbl-verify-up.log >&2
  exit 1
fi

# 3. Wait for readiness ------------------------------------------------------
info "waiting for ${BASE}/api/health/ready (DB-backed, up to 90s)"
READY=0
for _ in $(seq 1 45); do
  if [ "$(status "${BASE}/api/health/ready")" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  fail "server never became ready"
  "${COMPOSE[@]}" logs --tail 40 server >&2 || true
  exit 1
fi
ok "server ready with PostgreSQL reachable"

# 4. Smoke -------------------------------------------------------------------
echo
info "smoke: unauthenticated endpoints"

HEALTH=$(status "${BASE}/api/health")
if [ "$HEALTH" = "200" ]; then ok "GET /api/health -> 200"; else fail "GET /api/health -> ${HEALTH}"; fi

ANON=$(status "${BASE}/api/devices")
if [ "$ANON" = "401" ]; then
  ok "GET /api/devices without a token -> 401 (auth enforced in the container)"
else
  fail "GET /api/devices without a token -> ${ANON} (expected 401)"
fi

# The dashboard is served by the same process in production; if the image did not
# copy dashboard/dist, this is where it shows.
DASH_STATUS=$(status "${BASE}/")
DASH_TYPE=$(curl -s -o /dev/null -w '%{content_type}' --max-time 10 "${BASE}/")
if [ "$DASH_STATUS" = "200" ] && printf '%s' "$DASH_TYPE" | grep -qi 'text/html'; then
  ok "GET / -> 200 ${DASH_TYPE} (built dashboard served)"
else
  fail "GET / -> ${DASH_STATUS} ${DASH_TYPE} (expected 200 text/html)"
fi

echo
info "smoke: first-admin bootstrap + authenticated API"
ADMIN_USER="smoke-admin-$$"
ADMIN_PASS="SmokeTest-Passw0rd-$$"
# create-admin deliberately does NOT return a token (it is a one-time bootstrap
# endpoint, not a login). The smoke signs in through the same route an operator
# uses, which also proves the JWT secret reached the container.
SETUP_CODE=$(status -X POST "${BASE}/api/setup/create-admin" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
case "$SETUP_CODE" in
  200|201) ok "POST /api/setup/create-admin -> ${SETUP_CODE} (admin row written to PostgreSQL)" ;;
  *)       fail "POST /api/setup/create-admin -> ${SETUP_CODE} (expected 200/201)" ;;
esac

LOGIN_BODY=$(curl -s --max-time 15 -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")
TOKEN=$(printf '%s' "$LOGIN_BODY" | json_field token)
if [ -n "$TOKEN" ]; then
  ok "POST /api/auth/login -> JWT issued (JWT_SECRET reached the container)"
else
  fail "POST /api/auth/login did not return a token: $(printf '%s' "$LOGIN_BODY" | head -c 200)"
fi

if [ -n "${TOKEN:-}" ]; then
  DEV_STATUS=$(status -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/devices")
  if [ "$DEV_STATUS" = "200" ]; then
    ok "GET /api/devices with token -> 200"
  else
    fail "GET /api/devices with token -> ${DEV_STATUS} (expected 200)"
  fi

  HOST="smoke-dev-$$"
  ENROLL_BODY=$(curl -s --max-time 15 -X POST "${BASE}/api/devices" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d "{\"hostname\":\"${HOST}\",\"owner_name\":\"smoke\"}")
  AGENT_KEY=$(printf '%s' "$ENROLL_BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('agent_key') or d.get('api_key') or (d.get('device') or {}).get('agent_key',''))
" 2>/dev/null)
  if [ -n "$AGENT_KEY" ]; then
    ok "POST /api/devices -> device enrolled, agent key issued (write committed)"
  else
    fail "POST /api/devices did not issue an agent key: $(printf '%s' "$ENROLL_BODY" | head -c 200)"
  fi

  # The agent's own ingress, with the key it was just given. This is the path a
  # real device uses; a container that cannot serve it is not deployable.
  if [ -n "${AGENT_KEY:-}" ]; then
    # The device key travels in x-agent-key, not in the body (routes/agent.js:34).
    # HMAC headers are optional here because REQUIRE_HMAC is unset, i.e. the
    # transition regime this deployment ships in.
    CHK_STATUS=$(status -X POST "${BASE}/api/agent/checkin" \
      -H 'Content-Type: application/json' \
      -H "x-agent-key: ${AGENT_KEY}" \
      -d "{\"hostname\":\"${HOST}\",\"status\":\"online\",\"agent_version\":\"smoke\"}")
    case "$CHK_STATUS" in
      200|201) ok "POST /api/agent/checkin with the device key -> ${CHK_STATUS} (agent path works)" ;;
      401)     fail "POST /api/agent/checkin with a fresh device key -> 401 (key not accepted)" ;;
      404)     fail "POST /api/agent/checkin -> 404 (route missing?)" ;;
      *)       fail "POST /api/agent/checkin -> ${CHK_STATUS}" ;;
    esac

    # Without this, the positive check is worthless: an endpoint that accepts
    # everything would pass it too.
    BAD_STATUS=$(status -X POST "${BASE}/api/agent/checkin" \
      -H 'Content-Type: application/json' \
      -H 'x-agent-key: not-a-real-device-key' \
      -d '{"hostname":"impostor","status":"online"}')
    if [ "$BAD_STATUS" = "401" ]; then
      ok "POST /api/agent/checkin with a bogus key -> 401 (device keys are verified)"
    else
      fail "POST /api/agent/checkin with a bogus key -> ${BAD_STATUS} (expected 401)"
    fi
  fi

  # A duplicate first-admin must be refused — the setup guard is what stops a
  # second operator taking over a live deployment.
  DUP_STATUS=$(status -X POST "${BASE}/api/setup/create-admin" \
    -H 'Content-Type: application/json' \
    -d '{"username":"intruder","password":"dummy-intruder-password"}')
  if [ "$DUP_STATUS" = "403" ] || [ "$DUP_STATUS" = "409" ]; then
    ok "second /api/setup/create-admin -> ${DUP_STATUS} (first-admin guard holds)"
  else
    fail "second /api/setup/create-admin -> ${DUP_STATUS} (expected 403/409)"
  fi
fi

echo
if [ "$BODY_OK" = "0" ]; then
  ok "deployment verification PASSED — the production stack serves the API, the"
  ok "dashboard, and the agent ingress on real PostgreSQL"
else
  fail "deployment verification FAILED"
  info "container logs:"
  "${COMPOSE[@]}" logs --tail 40 server 2>&1 | tail -40 >&2 || true
fi
exit "$BODY_OK"
