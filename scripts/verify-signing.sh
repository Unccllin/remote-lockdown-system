#!/usr/bin/env bash
#
# verify-signing.sh — Verify code signatures on built Electron apps/installers
# and agent binaries.
#
# Detects the host platform and runs the appropriate verification tool:
#   - Windows: signtool verify /pa /v <path>
#   - macOS:   codesign --verify --deep --strict <path> + spctl --assess
#   - Linux:   signing not required (skipped with a message)
#
# Usage:
#   ./scripts/verify-signing.sh [options]
#
# Options:
#   --app <path>     Path to built Electron app/installer (.exe/.msi/.dmg/.app)
#   --agent <path>   Path to agent binary (optional)
#   -h, --help       Show this help message
#
# Exit codes:
#   0 — all checked artifacts are signed and valid
#   1 — one or more artifacts are unsigned
#   2 — one or more artifacts have an invalid signature
#  64 — usage error

set -uo pipefail

# --- Helpers ----------------------------------------------------------------
usage() {
  sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
warn() { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }

# Track the worst exit code across all artifacts.
WORST_RC=0
bump_rc() {
  local rc="$1"
  (( rc > WORST_RC )) && WORST_RC="$rc"
}

# --- Arguments --------------------------------------------------------------
APP=""
AGENT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="$2"; shift 2 ;;
    --app=*)
      APP="${1#*=}"; shift ;;
    --agent)
      AGENT="$2"; shift 2 ;;
    --agent=*)
      AGENT="${1#*=}"; shift ;;
    -h|--help)
      usage ;;
    *)
      err "Unknown argument: $1"; usage ;;
  esac
done

if [[ -z "$APP" && -z "$AGENT" ]]; then
  err "At least one of --app or --agent must be provided."
  usage
fi

# --- Platform detection -----------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*|*Windows*) echo "windows" ;;
    Darwin)                          echo "macos" ;;
    Linux)                           echo "linux" ;;
    *)                               echo "unknown" ;;
  esac
}

OS="$(detect_os)"

# --- Per-artifact verification ---------------------------------------------
verify_app() {
  local path="$1"
  info "Verifying Electron app/installer: $path"
  if [[ ! -e "$path" ]]; then
    err "File not found: $path"
    bump_rc 2
    return
  fi

  case "$OS" in
    windows) verify_windows "$path" ;;
    macos)   verify_macos   "$path" ;;
    linux)   verify_linux   "$path" ;;
    *)
      err "Unsupported OS for verification: $OS"
      bump_rc 2
      ;;
  esac
}

verify_agent() {
  local path="$1"
  info "Verifying agent binary: $path"
  if [[ ! -e "$path" ]]; then
    err "File not found: $path"
    bump_rc 2
    return
  fi

  case "$OS" in
    windows) verify_windows "$path" ;;
    macos)   verify_macos   "$path" ;;
    linux)   verify_linux   "$path" ;;
    *)
      err "Unsupported OS for agent verification: $OS"
      bump_rc 2
      ;;
  esac
}

# --- Windows ----------------------------------------------------------------
verify_windows() {
  local path="$1"
  local signtool=""
  local candidates=(
    "/c/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64/signtool.exe"
    "/c/Program Files (x86)/Windows Kits/10/bin/10.0.22000.0/x64/signtool.exe"
    "/c/Program Files (x86)/Windows Kits/10/bin/x64/signtool.exe"
    "signtool.exe"
    "signtool"
  )
  for c in "${candidates[@]}"; do
    if command -v "$c" >/dev/null 2>&1 || [[ -x "$c" ]]; then
      signtool="$c"
      break
    fi
  done

  if [[ -z "$signtool" ]]; then
    warn "signtool not found on PATH or Windows Kits. Cannot verify signature."
    warn "Install the Windows SDK or run on a Windows host with signtool available."
    warn "Skipping verification (treated as unsigned)."
    bump_rc 1
    return
  fi

  info "Using signtool: $signtool"
  local output
  if output=$("$signtool" verify /pa /v "$path" 2>&1); then
    ok "Signature valid (Authenticode, /pa policy)."
    # Extract publisher line if present.
    local publisher
    publisher=$(printf '%s\n' "$output" | grep -iE "Issued to|Subject:" | head -n1 || true)
    [[ -n "$publisher" ]] && info "Publisher: $publisher"
    printf '%s\n' "$output"
    bump_rc 0
  else
    # Distinguish "unsigned" from "invalid". signtool returns different exit
    # codes; we inspect stderr for hints.
    if printf '%s\n' "$output" | grep -qiE "no signature|not signed|0x80092013|0x800B0100"; then
      warn "Artifact is NOT signed."
      bump_rc 1
    else
      err "Signature present but INVALID:"
      printf '%s\n' "$output" >&2
      bump_rc 2
    fi
  fi
}

# --- macOS ------------------------------------------------------------------
verify_macos() {
  local path="$1"

  if ! command -v codesign >/dev/null 2>&1; then
    warn "codesign not available. Cannot verify macOS signature."
    warn "Run on a macOS host to verify code signatures."
    bump_rc 1
    return
  fi

  # codesign --verify: 0 = valid, 1 = unsigned/invalid (we disambiguate below).
  local cs_out
  if cs_out=$(codesign --verify --deep --strict "$path" 2>&1); then
    ok "codesign verification passed (signature valid)."
    local identity
    identity=$(codesign -dv --verbose=2 "$path" 2>&1 | grep -iE "^Authority|^TeamIdentifier|^Identifier" || true)
    [[ -n "$identity" ]] && info "Identity:\n$identity"
  else
    if printf '%s\n' "$cs_out" | grep -qiE "not signed|no signature"; then
      warn "Artifact is NOT signed."
      bump_rc 1
    else
      err "codesign verification FAILED:"
      printf '%s\n' "$cs_out" >&2
      bump_rc 2
    fi
    return
  fi

  # spctl Gatekeeper assessment (only meaningful for .app bundles / installers).
  if command -v spctl >/dev/null 2>&1; then
    local sp_out
    if sp_out=$(spctl --assess --type execute "$path" 2>&1); then
      ok "Gatekeeper assessment passed (notarized & stapled)."
    else
      warn "Gatekeeper assessment failed (may not be notarized/stapled):"
      printf '%s\n' "$sp_out" >&2
      # Treat as invalid rather than unsigned, since the signature itself was OK.
      bump_rc 2
    fi
  else
    warn "spctl not available; skipping Gatekeeper assessment."
  fi
}

# --- Linux ------------------------------------------------------------------
verify_linux() {
  local path="$1"
  info "Signing is not required on Linux for: $path"
  info "Linux packages (AppImage/deb/rpm) do not use code signatures."
  ok "Skipped (Linux)."
  bump_rc 0
}

# --- Run --------------------------------------------------------------------
[[ -n "$APP"   ]] && verify_app   "$APP"
[[ -n "$AGENT" ]] && verify_agent "$AGENT"

echo
case "$WORST_RC" in
  0) ok "All checked artifacts are signed and valid." ;;
  1) warn "One or more artifacts are UNSIGNED." ;;
  2) err "One or more artifacts have INVALID signatures." ;;
esac

exit "$WORST_RC"
