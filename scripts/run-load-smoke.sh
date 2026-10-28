#!/usr/bin/env bash
# run-load-smoke.sh — run a tiny, signed k6 load scenario against a throwaway
# server, so the load harness is executed by CI instead of only by hand.
#
# Why this exists: tests/load/*.js had never run anywhere automated. The signing
# contract was covered by server/tests/loadSigning.test.js, but nothing proved the
# k6 scripts themselves still parse, authenticate and complete against a live
# server — a broken script or a rotated header would only show up during a manual
# load test, i.e. never.
#
# What it does:
#   1. starts the server in SQLite mode on a free port with a temp database
#   2. seeds a handful of devices WITH per-device HMAC keys and pending commands
#   3. runs a k6 scenario with signing ENABLED (REQUIRE_HMAC=true), so the real
#      agent auth path is exercised rather than the legacy shared-key fallback
#   4. fails if k6 exits non-zero (its thresholds are the assertion), or if the
#      server logged an error, or if no request was actually made
#
# Usage:
#   scripts/run-load-smoke.sh                       # signed lockdown spike, 5 VUs / 10s
#   VUS=20 DURATION=20s scripts/run-load-smoke.sh
#   SCENARIO=tests/load/k6-baseline.js scripts/run-load-smoke.sh
#   K6_BIN=/path/to/k6 scripts/run-load-smoke.sh    # CI downloads a release binary
#
# Exit: 0 pass, 1 assertion failed, 2 setup problem.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 2

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
fail() { printf "${RED}[FAIL]${NC} %s\n" "$1"; }
info() { printf "${YELLOW}[..]${NC} %s\n" "$1"; }

K6_BIN="${K6_BIN:-k6}"
PORT="${PORT:-3302}"
VUS="${VUS:-5}"
DURATION="${DURATION:-10s}"
SCENARIO="${SCENARIO:-tests/load/k6-lockdown-spike.js}"
HMAC_SEED="${K6_HMAC_SECRET:-load-smoke-secret}"
PEPPER="smoke_test_pepper_do_not_use_in_production_00000000000000"

command -v "$K6_BIN" >/dev/null 2>&1 || { fail "k6 not found (set K6_BIN=/path/to/k6)"; exit 2; }
[ -f "$SCENARIO" ] || { fail "scenario not found: $SCENARIO"; exit 2; }
[ -d server/node_modules ] || { fail "server/node_modules missing — run 'cd server && npm ci' first"; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/load-smoke-XXXXXX")"
DB="$WORK/smoke.db"
LOG="$WORK/server.log"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

info "starting server on :$PORT (sqlite, REQUIRE_HMAC=true)"
(
  cd server || exit 1
  NODE_ENV=production \
  USE_SQLITE=true \
  SQLITE_PATH="$DB" \
  PORT="$PORT" \
  JWT_SECRET=smoke_test_jwt_secret_do_not_use_in_production_0000000000 \
  AGENT_SHARED_KEY=smoke_test_shared_key_do_not_use_in_production_0000 \
  AGENT_KEY_PEPPER="$PEPPER" \
  FIELD_ENCRYPTION_KEY=smoke_test_field_key_do_not_use_in_production_000000 \
  LOCATION_FIELD_KEY=smoke_test_location_key_do_not_use_in_production_000 \
  REQUIRE_HMAC=true \
  LOCATION_RETENTION_DAYS=7 \
  COMMAND_EXPIRY_DAYS=7 \
  node src/index.js >"$LOG" 2>&1 &
  echo $! > "$WORK/pid"
)
sleep 1
SERVER_PID="$(cat "$WORK/pid" 2>/dev/null || true)"
if [ -z "$SERVER_PID" ]; then fail "server did not start"; exit 2; fi

info "waiting for /api/health"
for _ in $(seq 1 40); do
  if curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ok "server healthy (pid $SERVER_PID)"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "server exited during startup"; tail -20 "$LOG"; exit 2
  fi
  sleep 1
done
curl -sf --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
  || { fail "server never became healthy"; tail -20 "$LOG"; exit 2; }

info "seeding devices with per-device HMAC keys and pending commands"
AGENT_KEY_PEPPER="$PEPPER" node scripts/seed-loadtest-devices.js \
  --count 20 --commands --hmac-secret "$HMAC_SEED" --db "$DB" >"$WORK/seed.log" 2>&1 \
  || { fail "seeding failed"; tail -10 "$WORK/seed.log"; exit 2; }
ok "seeded 20 devices"

info "running $SCENARIO with $VUS VUs for $DURATION (signed)"
K6_BASE_URL="http://127.0.0.1:$PORT" \
K6_HMAC_SECRET="$HMAC_SEED" \
K6_VUS="$VUS" \
K6_DURATION="$DURATION" \
MIXED_VUS="$VUS" \
MIXED_DURATION="$DURATION" \
K6_POLL_INTERVAL=1 \
  "$K6_BIN" run "$SCENARIO" >"$WORK/k6.log" 2>&1
K6_EXIT=$?

# Surface the numbers either way — a silent smoke test teaches nothing.
grep -E "http_reqs|http_req_failed|http_req_duration|thresholds" "$WORK/k6.log" | tail -6 || true

FAILED=0
if [ "$K6_EXIT" -ne 0 ]; then
  fail "k6 exited $K6_EXIT (thresholds crossed or script error)"
  tail -25 "$WORK/k6.log"
  FAILED=1
fi

# A signed request that never reached the server would still look like "k6 exit 0"
# with zero traffic, so assert traffic happened.
REQS="$(grep -oE 'http_reqs[. ]*:[[:space:]]*[0-9]+' "$WORK/k6.log" | grep -oE '[0-9]+$' | head -1)"
if [ -z "${REQS:-}" ] || [ "${REQS:-0}" -lt 1 ]; then
  fail "no requests recorded — the scenario did not exercise the server"
  FAILED=1
else
  ok "$REQS requests issued"
fi

# Fail-soft paths must not hide server-side errors.
ERRORS="$(grep -c '"level":50' "$LOG" 2>/dev/null | tr -d '[:space:]')"
if [ "${ERRORS:-0}" -ne 0 ]; then
  fail "server logged $ERRORS error-level line(s) during the run"
  grep '"level":50' "$LOG" | head -3
  FAILED=1
else
  ok "server logged no errors during the run"
fi

# And the server must have actually seen signed traffic.
if grep -q "hmacAuth: unsigned request" "$LOG" 2>/dev/null; then
  fail "requests arrived unsigned despite K6_HMAC_SECRET being set"
  FAILED=1
else
  ok "all requests were HMAC-signed"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  fail "load smoke FAILED"
  exit 1
fi
ok "load smoke passed"
