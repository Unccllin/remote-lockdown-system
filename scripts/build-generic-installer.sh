#!/usr/bin/env bash
# build-generic-installer.sh — compile the ONE generic NSIS agent installer.
#
# Why this exists
# ---------------
# The self-hosted server builds an installer per device (config baked in). A
# Cloudflare Worker cannot run `makensis`, so the serverless deployment ships a
# single generic installer whose config is claimed at install time from a
# 15-minute enrolment token — see installer/generic/lockdown-installer.nsi.
#
# This script stages the PyInstaller outputs and runs makensis. Upload the result
# to the backend's installer slot:
#
#   npx wrangler kv key put --binding=LOCKDOWN_KV binary:installer \
#       --path installer/generic/dist/lockdown-installer.exe
#
# The .nsi only packages; enrolment, config.json, persistence and check-in all
# run through lockdown-installer.exe (agent/installer.py), so this build needs
# that binary, not just the agent. Both come from agent/build.ps1
# (agent.spec + installer.spec).
#
# Usage:
#   scripts/build-generic-installer.sh [--out DIR] [--version X.Y.Z] \
#                                      [--stage DIR] [--server-url URL]
#   NSISDIR=/path/to/nsis/share scripts/build-generic-installer.sh
#
# Requires: makensis (system, ~/.local/nsis, or NSISDIR pointing at one) and the
# staged binaries. Never invents either one: a missing mandatory binary is a
# failed build, not an installer with a hole in it.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERIC_DIR="$REPO/installer/generic"
STAGE="${STAGE:-$REPO/agent/dist}"
OUT_DIR="$GENERIC_DIR/dist"
VERSION=""
SERVER_URL=""

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)        OUT_DIR="$2"; shift 2 ;;
    --version)    VERSION="$2"; shift 2 ;;
    --stage)      STAGE="$2"; shift 2 ;;
    --server-url) SERVER_URL="$2"; shift 2 ;;
    -h|--help)    sed -n '3,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown argument: $1"; exit 2 ;;
  esac
done

# Default the version to the agent's own version string when not given, so the
# installer never advertises a version the binaries do not have.
if [ -z "$VERSION" ]; then
  VERSION="$(grep -m1 '^AGENT_VERSION' "$REPO/agent/agent.py" 2>/dev/null \
    | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  VERSION="${VERSION:-1.0.0}"
fi

# Default the backend URL to the one agent/installer.py defaults to, so the URL
# the installer pre-fills and the URL the installer would fall back to on a
# silent run cannot disagree.
if [ -z "$SERVER_URL" ]; then
  # `-n ... p` with `[^"]*` (zero or more): a non-matching line must produce nothing.
  # With `[^"]+` an EMPTY default -- which is what installer.py has held since S213, when
  # the baked Worker URL was removed for misdirecting enrolments -- did not match, so sed
  # passed the whole source line through and the build happily baked
  # `DEFAULT_SERVER_URL = ""` as the server URL.
  SERVER_URL="$(grep -m1 '^DEFAULT_SERVER_URL' "$REPO/agent/installer.py" 2>/dev/null \
    | sed -nE 's/^[^"]*"([^"]*)".*/\1/p' || true)"
  if [ -z "$SERVER_URL" ]; then
    err "no server URL: agent/installer.py has no default, so pass --server-url <url>"
    exit 1
  fi
fi

# A URL without a scheme is never right, and this is the check that would have caught the
# empty-default extraction above.
case "$SERVER_URL" in
  http://*|https://*) ;;
  *)
    err "server URL must start with http:// or https:// (got '$SERVER_URL')"
    exit 1
    ;;
esac

# Mandatory: the agent, and the installer the wrapper delegates to.
AGENT_EXE="$STAGE/lockdown-agent.exe"
INSTALLER_EXE="$STAGE/lockdown-installer.exe"
for f in "$AGENT_EXE" "$INSTALLER_EXE"; do
  [ -f "$f" ] || {
    err "missing $f — build the agent first: pwsh agent/build.ps1 (needs agent.spec + installer.spec)"
    exit 1
  }
done

# Optional: the wrapper stages these with File /nonfatal, and the product
# degrades gracefully without them (lock screen falls back to LockWorkStation,
# the watchdog probe falls back to inline PowerShell).
for f in "$STAGE/lockdown-watchdog.exe" "$STAGE/lockdown-lockscreen.exe"; do
  [ -f "$f" ] || info "optional companion not staged: $(basename "$f")"
done

# The update-signing public key. Without it the installed agent verifies updates
# by SHA-256 only (unauthenticated) and says so at check-in; with it, unsigned
# updates are refused. See scripts/generate-update-keys.sh.
if [ -f "$STAGE/update_signing.pub" ]; then
  info "update key staged: ${STAGE}/update_signing.pub (updates will be signature-verified)"
else
  info "no update_signing.pub staged — installed agents will accept SHA-256-only updates"
fi

# makensis: system, then the local unpacked tree (which needs NSISDIR because its
# stubs live beside it, not in /usr/share/nsis).
MAKENSIS=""
NSIS_SHARE="${NSISDIR:-}"
if command -v makensis >/dev/null 2>&1; then
  MAKENSIS="$(command -v makensis)"
elif [ -x "$HOME/.local/nsis/usr/bin/makensis" ]; then
  MAKENSIS="$HOME/.local/nsis/usr/bin/makensis"
  NSIS_SHARE="${NSIS_SHARE:-$HOME/.local/nsis/usr/share/nsis}"
elif [ -n "$NSIS_SHARE" ] && [ -x "$NSIS_SHARE/../bin/makensis" ]; then
  MAKENSIS="$NSIS_SHARE/../bin/makensis"
else
  err "makensis not found (install nsis, or unpack it to ~/.local/nsis)"
  exit 1
fi
[ -n "$NSIS_SHARE" ] && export NSISDIR="$NSIS_SHARE"

mkdir -p "$OUT_DIR"

info "building generic installer"
info "  version:    $VERSION"
info "  server-url: $SERVER_URL"
info "  stage:      $STAGE"
info "  out:        $OUT_DIR"
[ -n "$NSIS_SHARE" ] && info "  NSISDIR:    $NSIS_SHARE"

(
  cd "$GENERIC_DIR"
  # makensis resolves File paths relative to the script's directory, so the
  # build runs from here and passes the staging dir as an absolute path.
  "$MAKENSIS" -V2 \
    -DSTAGE="$STAGE" \
    -DPRODUCT_VERSION="$VERSION" \
    -DDEFAULT_SERVER_URL="$SERVER_URL" \
    lockdown-installer.nsi
)

BUILT="$GENERIC_DIR/lockdown-installer.exe"
[ -f "$BUILT" ] || { err "makensis reported success but produced no .exe"; exit 1; }
mv -f "$BUILT" "$OUT_DIR/lockdown-installer.exe"

ok "built $OUT_DIR/lockdown-installer.exe ($(du -h "$OUT_DIR/lockdown-installer.exe" | cut -f1))"
ok "sha256 $(sha256sum "$OUT_DIR/lockdown-installer.exe" | cut -d' ' -f1)"
info "upload with:"
info "  npx wrangler kv key put --binding=LOCKDOWN_KV binary:installer --path $OUT_DIR/lockdown-installer.exe"
