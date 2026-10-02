#!/usr/bin/env bash
# smoke-worker.sh — post-deploy smoke check for the serverless Worker.
#
# Catches the two failure modes that escaped vitest in S137:
#   1. STALE DEPLOY  — new endpoints missing on live (404 where code exists)
#   2. RUNTIME CRASH — Workers-specific limits (e.g. PBKDF2 100k cap → error 1101)
#      that only surface on a real request, not in Node/WebCrypto tests.
#
# Usage:
#   scripts/smoke-worker.sh [BASE_URL]
#   BASE_URL defaults to $VITE_API_URL minus /api, or the production worker.
#
# Exit 0 = all probes healthy. Exit 1 = a probe failed.

set -euo pipefail

BASE_URL="${1:-${WORKER_URL:-https://lockdown-serverless.mainacollins196.workers.dev}}"
BASE_URL="${BASE_URL%/}"          # strip trailing slash
BASE_URL="${BASE_URL%/api}"       # strip /api if caller passed it
API="${BASE_URL}/api"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[31m[FAIL]\033[0m %s — %s\n' "$1" "$2"; }

# probe <name> <path> <expected-code> [auth-header]
probe() {
  local name="$1" path="$2" want="$3" auth="${4:-}"
  local args=(-s -o /tmp/smoke_body.json -w '%{http_code}')
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  local code
  code=$(curl "${args[@]}" "${API}${path}" 2>/dev/null || echo "000")
  if [ "$code" = "$want" ]; then
    ok "$name (HTTP $code)"
  else
    fail "$name" "expected HTTP $want, got $code"
    [ -s /tmp/smoke_body.json ] && head -c 300 /tmp/smoke_body.json | sed 's/^/      body: /'
  fi
}

echo "=== Worker post-deploy smoke ==="
echo "Target: $API"
echo

# --- Unauthenticated endpoints (must be 200, proves Worker is alive) ---
probe "health"            "/health"          200
probe "health/detailed"   "/health/detailed" 200
probe "setup/status"      "/setup/status"    200

# --- Auth-gated endpoints (must be 401, NOT 404/500) ---
# 404 = the route isn't deployed (stale build). 500/1101 = runtime crash.
for ep in admins devices audit; do
  probe "auth-gated /$ep" "/$ep" 401
done

# --- Login endpoint reachable (400 on empty body, not 404/500) ---
code=$(curl -s -o /tmp/smoke_body.json -w '%{http_code}' \
  -X POST "${API}/auth/login" -H 'Content-Type: application/json' -d '{}')
if [ "$code" = "400" ] || [ "$code" = "401" ]; then
  ok "auth/login reachable (HTTP $code)"
else
  fail "auth/login" "expected 400/401, got $code (stale or crashed)"
fi

echo
printf '  \033[32mPASS\033[0m: %d  \033[31mFAIL\033[0m: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && echo "Worker smoke: all probes healthy." || { echo "Worker smoke: FAILURES — do not rely on this deploy."; exit 1; }
