#!/usr/bin/env bash
# verify-meshcentral-connector.sh — stand up a real MeshCentral and exercise the
# connector against it, so its error paths stop being mock-only.
#
# Sessions S142 recorded "the UPSTREAM_ERROR path is only covered by mocks" as
# fog remaining. This closes it: a real container, real login endpoint, real
# 4xx on bad credentials, real socket failure on an unreachable host.
#
# What it does:
#   1. creates a data volume and an admin account (MeshCentral requires the
#      server to be stopped while creating accounts, so this runs in a one-off
#      container before the server starts);
#   2. starts MeshCentral on 127.0.0.1:${MC_PORT} and waits for it;
#   3. runs scripts/verify-meshcentral-connector.mjs against it;
#   4. tears the container down (the volume is kept; pass --wipe to drop it).
#
# TLS note: MeshCentral serves a self-signed certificate out of the box, so the
# verification process sets NODE_TLS_REJECT_UNAUTHORIZED=0. That is acceptable
# for a throwaway local instance and is NOT how the connector should be run in
# production — there, a valid certificate is required.
#
# Usage:
#   scripts/verify-meshcentral-connector.sh
#   MC_PORT=9443 scripts/verify-meshcentral-connector.sh
#   scripts/verify-meshcentral-connector.sh --wipe     # also remove the volume

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MC_IMAGE="${MC_IMAGE:-ghcr.io/ylianst/meshcentral:latest}"
MC_PORT="${MC_PORT:-8443}"
MC_USER="${MC_USER:-admin}"
MC_PASS="${MC_PASS:-meshcentral-verify-pass}"
CONTAINER="rls-mc-verify"
VOLUME="rls-mc-verify-data"
DATA_MOUNT="/opt/meshcentral/meshcentral-data"
# The image ENTRYPOINT wraps whatever you pass it (it appends args to the
# server), so CLI subcommands must run with --entrypoint node.
MC_APP="/opt/meshcentral/meshcentral/meshcentral.js"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { printf "${GREEN}[OK]${NC} %s\n" "$1"; }
err()  { printf "${RED}[FAIL]${NC} %s\n" "$1"; }
info() { printf "${YELLOW}[..]${NC} %s\n" "$1"; }

WIPE=0
[ "${1:-}" = "--wipe" ] && WIPE=1

if ! command -v docker >/dev/null 2>&1; then
  err "docker not found"; exit 2
fi

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$WIPE" = "1" ]; then
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

info "image: $MC_IMAGE"
docker volume create "$VOLUME" >/dev/null || { err "cannot create volume"; exit 1; }

# MeshCentral refuses account creation while the server is running, so create
# the admin in a one-off container against the same data volume first.
info "creating admin account (server stopped)"
if ! docker run --rm --entrypoint node -v "${VOLUME}:${DATA_MOUNT}" "$MC_IMAGE" \
      "$MC_APP" --createaccount "$MC_USER" --pass "$MC_PASS" 2>&1 | tail -3; then
  err "account creation failed"; exit 1
fi
docker run --rm --entrypoint node -v "${VOLUME}:${DATA_MOUNT}" "$MC_IMAGE" \
  "$MC_APP" --adminaccount "$MC_USER" 2>&1 | tail -2 || true

info "starting MeshCentral on 127.0.0.1:${MC_PORT}"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:${MC_PORT}:443" \
  -v "${VOLUME}:${DATA_MOUNT}" \
  "$MC_IMAGE" >/dev/null || { err "cannot start container"; exit 1; }

ready=0
for _ in $(seq 1 60); do
  if curl -sk -o /dev/null -m 3 "https://127.0.0.1:${MC_PORT}/"; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  err "MeshCentral did not answer within 120s"
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /'
  exit 1
fi
ok "MeshCentral is answering"

# Self-signed cert: acceptable for a throwaway local instance only.
export NODE_TLS_REJECT_UNAUTHORIZED=0
# MeshCentral 1.3.x is WebSocket-only, so the inventory read is expected to be
# blocked. Set MC_EXPECT_REST=1 once an upstream with a REST API is targeted and
# the happy path becomes assertable (see the S142 addendum in the ADR).
MC_BASE="https://127.0.0.1:${MC_PORT}" MC_USER="$MC_USER" MC_PASS="$MC_PASS" \
  MC_EXPECT_REST="${MC_EXPECT_REST:-0}" \
  node "$PROJECT_ROOT/scripts/verify-meshcentral-connector.mjs"
status=$?

if [ "$status" = "0" ]; then ok "connector verified against a real MeshCentral"; else err "connector verification failed"; fi
exit "$status"
