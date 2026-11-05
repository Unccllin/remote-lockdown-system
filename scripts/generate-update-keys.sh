#!/usr/bin/env bash
# generate-update-keys.sh — create the Ed25519 keypair that pins agent updates.
#
# Why this exists
# ---------------
# The agent verifies a detached Ed25519 signature over "v1:{version}:{sha256}"
# before it will apply an update (B-006). That verification only happens when the
# device has a pinned public key; without one it accepts an update whose sole
# check is the SHA-256 served beside the binary — a hash delivered by the same
# origin as the bytes, which proves nothing about who produced them.
#
# This script produces the pair:
#   update_signing.key — PRIVATE. Never distribute. It signs releases (CI secret
#                        UPDATE_SIGNING_KEY, or the Worker's `agent_release`
#                        metadata published at release time).
#   update_signing.pub — PUBLIC. Ship it WITH the installer. The installers stage
#                        it beside config.json, and the agent then names it as
#                        update_public_key and refuses unsigned updates.
#
# The update key is a separate domain from the recovery key: agent.py warns when
# the two files hold the same key material.
#
# Usage:
#   scripts/generate-update-keys.sh [--out DIR] [--force]
#
# Then:
#   1. Put update_signing.pub next to the agent binaries before building an
#      installer (agent/build.ps1 -> agent/dist, or STAGE=... for
#      scripts/build-generic-installer.sh).
#   2. Keep update_signing.key offline; sign the release metadata in CI.
#   3. Self-hosted server: UPDATE_PUBLIC_KEY_PEM=<path to update_signing.pub>
#      so the per-device installers stage it too.
#
# Copyright (c) 2026 Remote Lockdown System. All rights reserved.

set -euo pipefail

# Default OUTSIDE the working copy: run from the repository root, the old default
# (pwd) dropped a private key into a tree where only agent/dist/ was ignored, so a
# `git add -A` could have published it (S242).
OUT_DIR="${HOME}/.lockdown-secrets"
FORCE=0

info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)   OUT_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown argument: $1"; exit 2 ;;
  esac
done

if ! command -v openssl >/dev/null 2>&1; then
  err "openssl not found — it is required to generate the Ed25519 keypair"
  exit 1
fi

mkdir -p "$OUT_DIR"
KEY="$OUT_DIR/update_signing.key"
PUB="$OUT_DIR/update_signing.pub"

if [[ -e "$KEY" && "$FORCE" -ne 1 ]]; then
  err "$KEY already exists — refusing to overwrite a live signing key (use --force to rotate)"
  exit 1
fi

info "generating Ed25519 update-signing keypair"
openssl genpkey -algorithm ed25519 -out "$KEY"
openssl pkey -in "$KEY" -pubout -out "$PUB"

# The private key must not be readable by others.
chmod 600 "$KEY"
chmod 644 "$PUB"

ok "private key: $KEY (mode 600 — keep offline, never ship it)"
ok "public key:  $PUB"
echo
info "the public key must reach every device; the private key must not:"
info "  1. copy $(basename "$PUB") next to the agent binaries before building an installer"
info "  2. sign release metadata in CI with $(basename "$KEY") (UPDATE_SIGNING_KEY)"
info "  3. self-hosted: UPDATE_PUBLIC_KEY_PEM=$(basename "$PUB")'s path on the server"
info "devices without the pin report 'sha256-only' update verification at check-in"
