#!/usr/bin/env bash
# verify-worker.sh — prove the Cloudflare Worker bundles and serves its routes.
#
# Why this exists
# ---------------
# The Worker is the API the agent and the Electron app talk to in the serverless
# deployment: agent check-in, enrolment, command ACK, and the PBL `/v1/*` CBOR
# routes. `serverless/*.test.ts` exercises the handler in Vitest by calling
# `worker.fetch()` directly, which never runs the bundle through esbuild, never
# boots workerd, and never proves a route is reachable over HTTP.
#
# This script covers both halves that a unit test cannot:
#   1. `wrangler deploy --dry-run` — the bundle actually builds, and the route
#      table survives bundling (asserted by grepping the output);
#   2. `wrangler dev` — workerd serves it, and the routes answer with the right
#      status codes over real HTTP.
#
# It needs no Cloudflare account: local mode uses workerd + a local KV directory.
# Publishing is the one step this cannot do, and it is the one step that needs
# your `wrangler login`.
#
# Usage:
#   scripts/verify-worker.sh              # bundle + serve + smoke, then stop
#   scripts/verify-worker.sh --keep       # leave wrangler dev running
#   WORKER_PORT=8799 scripts/verify-worker.sh
#
# Exit code: 0 all checks passed, 1 any failure.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

# shellcheck disable=SC2317  # cleanup() is invoked only through `trap ... EXIT`
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 2

PORT="${WORKER_PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
ADMIN_TOKEN="smoke-break-glass-token-${PORT}"
KEEP=0
FAILED=0

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
fail() { printf '\033[31m[FAIL]\033[0m  %s\n' "$*" >&2; FAILED=1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)    KEEP=1; shift ;;
    -h|--help) sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

export PATH="/home/cllin/.local/node/bin:$PATH"
command -v node >/dev/null || { fail "node not found"; exit 1; }
[ -f serverless/wrangler.toml ] || { fail "serverless/wrangler.toml missing"; exit 1; }

WORK="$(mktemp -d)"
DEV_PID=""
cleanup() {
  if [ -n "$DEV_PID" ]; then
    # wrangler spawns workerd as a child; kill the whole group so no listener is
    # left behind holding the port on the next run.
    kill -TERM "-${DEV_PID}" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "-${DEV_PID}" 2>/dev/null || true
  fi
  if [ "$KEEP" = "1" ]; then
    info "leaving wrangler dev running on ${BASE} (state in ${WORK})"
    return
  fi
  rm -rf "$WORK"
}
# shellcheck disable=SC2317  # invoked indirectly, via trap ... EXIT
trap cleanup EXIT

status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || echo 000; }
body()   { curl -s --max-time 10 "$@" || true; }

# === 1. Bundle ==============================================================
info "bundling (wrangler deploy --dry-run — no account needed)"
if ! ( cd serverless && npx wrangler deploy --dry-run --outdir "$WORK/out" ) \
     >"$WORK/bundle.log" 2>&1; then
  fail "bundle failed — see $WORK/bundle.log"
  tail -20 "$WORK/bundle.log" >&2
  exit 1
fi
BUNDLE="$WORK/out/worker.js"
if [ -s "$BUNDLE" ]; then
  ok "bundle built: $(du -h "$BUNDLE" | cut -f1) worker.js"
else
  fail "bundle output missing or empty ($BUNDLE)"
  ls -la "$WORK/out" >&2 || true
  exit 1
fi

# A bundle that dropped its route table would still be a valid JS file, so assert
# the paths are actually in it — this is the cheap half of "did tree-shaking eat
# the router".
for route in '/v1/verdict' '/api/agent/checkin' '/api/enroll' '/api/download/agent'; do
  if grep -qF "$route" "$BUNDLE"; then
    ok "bundle contains ${route}"
  else
    fail "bundle does NOT contain ${route} (route table lost in bundling)"
  fi
done

# === 2. Serve ===============================================================
info "starting wrangler dev on ${BASE} (local workerd, local KV in the work dir)"
# --var provides the break-glass admin token and JWT secret locally; nothing here
# leaves the machine. setsid gives us a process group to kill cleanly.
( cd serverless && exec setsid npx wrangler dev \
    --port "$PORT" --ip 127.0.0.1 \
    --persist-to "$WORK/kv" \
    --var "ADMIN_TOKEN:${ADMIN_TOKEN}" \
    --var "JWT_SECRET:local-smoke-jwt-secret-at-least-32-chars" \
) >"$WORK/dev.log" 2>&1 &
DEV_PID=$!

READY=0
for _ in $(seq 1 40); do
  if [ "$(status "${BASE}/api/health")" = "200" ]; then READY=1; break; fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  fail "worker never answered on ${BASE}/api/health"
  tail -30 "$WORK/dev.log" >&2
  exit 1
fi
ok "workerd serving"

# === 3. Smoke ===============================================================
echo
info "smoke: public + protected routes"

CODE=$(status "${BASE}/api/setup/status")
if [ "$CODE" = "200" ]; then
  ok "GET /api/setup/status -> 200"
else
  fail "GET /api/setup/status -> ${CODE} (expected 200)"
fi

CODE=$(status "${BASE}/api/devices")
if [ "$CODE" = "401" ]; then
  ok "GET /api/devices without a token -> 401"
else
  fail "GET /api/devices without a token -> ${CODE} (expected 401)"
fi

CODE=$(status -H "Authorization: Bearer ${ADMIN_TOKEN}" "${BASE}/api/devices")
if [ "$CODE" = "200" ]; then
  ok "GET /api/devices with the break-glass ADMIN_TOKEN -> 200"
else
  fail "GET /api/devices with ADMIN_TOKEN -> ${CODE} (expected 200)"
fi

CODE=$(status -H "Authorization: Bearer definitely-not-the-token" "${BASE}/api/devices")
if [ "$CODE" = "401" ]; then
  ok "GET /api/devices with a bogus token -> 401"
else
  fail "GET /api/devices with a bogus token -> ${CODE} (expected 401)"
fi

CODE=$(status "${BASE}/this-route-does-not-exist")
if [ "$CODE" = "404" ]; then
  ok "GET /this-route-does-not-exist -> 404"
else
  fail "GET /this-route-does-not-exist -> ${CODE} (expected 404)"
fi

echo
info "smoke: PBL /v1 routes (CBOR wire format, no agent auth)"
# These must route and reject bad input cleanly. A 5xx here means the PBL handler
# is wired but broken, which is exactly what unit tests calling fetch() can hide.
CODE=$(status -X POST "${BASE}/v1/verdict" -H 'Content-Type: application/cbor' --data-binary 'not-cbor')
case "$CODE" in
  4??) ok "POST /v1/verdict with a junk body -> ${CODE} (routed, rejected cleanly)" ;;
  5??) fail "POST /v1/verdict with a junk body -> ${CODE} (handler error, not validation)" ;;
  *)   fail "POST /v1/verdict with a junk body -> ${CODE} (unexpected)" ;;
esac

CODE=$(status "${BASE}/v1/policy/1")
case "$CODE" in
  200)     ok "GET /v1/policy/1 -> 200 (routed; a policy blob is served from local KV or the built-in default)" ;;
  404)     ok "GET /v1/policy/1 -> 404 (routed; no policy version 1 in local KV)" ;;
  5??)     fail "GET /v1/policy/1 -> ${CODE} (handler error)" ;;
  *)       fail "GET /v1/policy/1 -> ${CODE} (unexpected)" ;;
esac

echo
info "smoke: binary download endpoints (KV-backed)"
CODE=$(status "${BASE}/api/download/agent")
case "$CODE" in
  200|404|503) ok "GET /api/download/agent -> ${CODE} (routed; no binary in local KV)" ;;
  5??)         fail "GET /api/download/agent -> ${CODE} (server error)" ;;
  *)           fail "GET /api/download/agent -> ${CODE} (unexpected)" ;;
esac

echo
if [ "$FAILED" = "0" ]; then
  ok "worker verification PASSED — the bundle builds and every checked route answers"
  ok "publishing is the one step left, and it needs your \`wrangler login\`:"
  ok "  cd serverless && npx wrangler deploy"
else
  fail "worker verification FAILED"
  info "wrangler dev log (tail):"
  tail -30 "$WORK/dev.log" >&2 || true
fi
exit "$FAILED"
