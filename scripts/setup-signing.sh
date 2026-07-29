#!/usr/bin/env bash
#
# setup-signing.sh — Configure code-signing credentials for the Remote Lockdown
# System.
#
# Collects signing credentials interactively and writes them to a gitignored
# `.signing.env` file. The generated file can be sourced before running
# electron-builder, or the same values can be configured as GitHub Secrets for
# CI/CD signing.
#
# Usage:
#   ./scripts/setup-signing.sh [options]
#
# Options:
#   --platform <windows|macos|both>  Which platform to configure (default: both)
#   --method <azure|pfx|developer-id> Signing method
#                                    - windows: azure (Azure Trusted Signing) or pfx (PFX certificate)
#                                    - macos:   developer-id (Apple Developer ID + notarization)
#   --non-interactive                Read values from existing env / stdin prompts without TTY
#   -h, --help                       Show this help message
#
# Exit codes:
#   0   configuration written successfully
#   1   missing/invalid arguments
#   2   required values not provided
#  64   usage error

set -uo pipefail

# --- Defaults ---------------------------------------------------------------
PLATFORM="both"
METHOD=""
NON_INTERACTIVE=0
ENV_FILE=".signing.env"

# --- Helpers ----------------------------------------------------------------
usage() {
  sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

err()  { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m[INFO]\033[0m  %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m    %s\n' "$*"; }
warn() { printf '\033[33m[WARN]\033[0m  %s\n' "$*"; }

# Prompt for a value. If the env var is already set, use it as the default.
# Usage: prompt <VAR_NAME> <label> [--secret]
prompt() {
  local var="$1"
  local label="$2"
  local secret=0
  [[ "${3:-}" == "--secret" ]] && secret=1

  local default="${!var:-}"
  local display_default=""
  [[ -n "$default" ]] && display_default=" [current: ${secret:+***}${secret:-$default}]"

  local value
  if (( secret )); then
    # Read silently for secrets.
    if [[ -n "$default" ]]; then
      value="$default"
      printf '%s%s: ' "$label" "$display_default" >&2
      # Only re-prompt if interactive; otherwise keep current.
      if [[ -t 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
        read -rs value </dev/tty || value="$default"
        [[ -z "$value" ]] && value="$default"
      fi
    else
      printf '%s: ' "$label" >&2
      if [[ -t 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
        read -rs value </dev/tty || value=""
      else
        read -rs value || value=""
      fi
    fi
    printf '\n' >&2
  else
    printf '%s%s: ' "$label" "$display_default" >&2
    if [[ -t 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
      read -r value </dev/tty || value="$default"
      [[ -z "$value" ]] && value="$default"
    else
      read -r value || value="$default"
      [[ -z "$value" ]] && value="$default"
    fi
  fi

  # Export so we can write all collected vars at the end.
  printf -v "$var" '%s' "$value"
  export "$var"
}

require() {
  local var="$1"
  local label="$2"
  if [[ -z "${!var:-}" ]]; then
    err "Missing required value: $label (env var: $var)"
    return 1
  fi
}

# --- Argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="$2"; shift 2 ;;
    --platform=*)
      PLATFORM="${1#*=}"; shift ;;
    --method)
      METHOD="$2"; shift 2 ;;
    --method=*)
      METHOD="${1#*=}"; shift ;;
    --non-interactive)
      NON_INTERACTIVE=1; shift ;;
    -h|--help)
      usage ;;
    *)
      err "Unknown argument: $1"; usage ;;
  esac
done

case "$PLATFORM" in
  windows|macos|both) ;;
  *) err "Invalid --platform: $PLATFORM (expected: windows|macos|both)"; exit 1 ;;
esac

# --- Determine method -------------------------------------------------------
configure_windows() {
  if [[ -z "$METHOD" ]]; then
    info "Windows signing methods:"
    info "  azure  — Azure Trusted Signing (recommended, no hardware token)"
    info "  pfx    — Local PFX code-signing certificate"
    if [[ -t 0 && "$NON_INTERACTIVE" -eq 0 ]]; then
      printf 'Select method [azure/pfx]: ' >&2
      read -r METHOD </dev/tty || METHOD="azure"
    else
      METHOD="azure"
    fi
  fi

  case "$METHOD" in
    azure)
      info "Configuring Windows signing via Azure Trusted Signing."
      info "See: https://learn.microsoft.com/en-us/azure/trusted-signing/"
      echo
      prompt AZURE_TRUSTED_SIGNING_TENANT_ID          "Azure Tenant ID"
      prompt AZURE_TRUSTED_SIGNING_ACCOUNT_NAME        "Azure Trusted Signing Account Name"
      prompt AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE "Certificate Profile Name"
      echo
      require AZURE_TRUSTED_SIGNING_TENANT_ID          "Azure Tenant ID"           || return 2
      require AZURE_TRUSTED_SIGNING_ACCOUNT_NAME        "Azure Signing Account Name" || return 2
      require AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE "Certificate Profile Name"  || return 2
      ok "Azure Trusted Signing values collected."
      ;;
    pfx)
      info "Configuring Windows signing via local PFX certificate."
      echo
      prompt CSC_LINK         "Path to PFX certificate file"
      prompt CSC_KEY_PASSWORD "PFX password" --secret
      echo
      require CSC_LINK         "PFX certificate path" || return 2
      require CSC_KEY_PASSWORD "PFX password"         || return 2
      if [[ ! -f "${CSC_LINK:-}" ]]; then
        warn "PFX file not found at: $CSC_LINK (will be resolved at build time)"
      fi
      ok "PFX signing values collected."
      ;;
    *)
      err "Invalid Windows --method: $METHOD (expected: azure|pfx)"
      return 1
      ;;
  esac
}

configure_macos() {
  local m="${METHOD:-developer-id}"
  if [[ "$m" != "developer-id" && "$m" != "pfx" ]]; then
    # Treat any non-windows method as developer-id for macOS.
    m="developer-id"
  fi
  info "Configuring macOS signing via Apple Developer ID + notarization."
  info "See: https://developer.apple.com/developer-id/"
  echo
  prompt APPLE_CERTIFICATE_P12         "Path to Developer ID P12 certificate"
  prompt APPLE_CERTIFICATE_PASSWORD    "P12 password" --secret
  prompt APPLE_ID                      "Apple ID (email)"
  prompt APPLE_APP_SPECIFIC_PASSWORD   "App-Specific Password" --secret
  prompt APPLE_TEAM_ID                 "Apple Team ID"
  echo
  require APPLE_CERTIFICATE_P12         "P12 certificate path"      || return 2
  require APPLE_CERTIFICATE_PASSWORD    "P12 password"              || return 2
  require APPLE_ID                      "Apple ID"                  || return 2
  require APPLE_APP_SPECIFIC_PASSWORD   "App-Specific Password"     || return 2
  require APPLE_TEAM_ID                 "Apple Team ID"             || return 2
  if [[ ! -f "${APPLE_CERTIFICATE_P12:-}" ]]; then
    warn "P12 file not found at: $APPLE_CERTIFICATE_P12 (will be resolved at build time)"
  fi
  ok "Apple Developer ID signing values collected."
}

# --- Collect values ---------------------------------------------------------
WINDOWS_VARS=(
  AZURE_TRUSTED_SIGNING_TENANT_ID
  AZURE_TRUSTED_SIGNING_ACCOUNT_NAME
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE
  CSC_LINK
  CSC_KEY_PASSWORD
)
MACOS_VARS=(
  APPLE_CERTIFICATE_P12
  APPLE_CERTIFICATE_PASSWORD
  APPLE_ID
  APPLE_APP_SPECIFIC_PASSWORD
  APPLE_TEAM_ID
)

case "$PLATFORM" in
  windows) configure_windows || exit $? ;;
  macos)   configure_macos   || exit $? ;;
  both)
    configure_windows || exit $?
    echo
    configure_macos   || exit $?
    ;;
esac

# --- Write .signing.env -----------------------------------------------------
info "Writing configuration to $ENV_FILE"

{
  printf '# Generated by scripts/setup-signing.sh\n'
  printf '# DO NOT COMMIT THIS FILE — it contains signing credentials.\n'
  printf '# Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# Source this file before building, or set the same values as\n'
  printf '# GitHub Secrets for CI/CD signing.\n\n'

  if [[ "$PLATFORM" == "windows" || "$PLATFORM" == "both" ]]; then
    if [[ "${METHOD:-}" == "azure" || ( "$PLATFORM" == "both" && -n "${AZURE_TRUSTED_SIGNING_ACCOUNT_NAME:-}" ) ]]; then
      printf '# --- Windows: Azure Trusted Signing ---\n'
      [[ -n "${AZURE_TRUSTED_SIGNING_TENANT_ID:-}" ]]           && printf 'export AZURE_TRUSTED_SIGNING_TENANT_ID=%q\n'           "$AZURE_TRUSTED_SIGNING_TENANT_ID"
      [[ -n "${AZURE_TRUSTED_SIGNING_ACCOUNT_NAME:-}" ]]        && printf 'export AZURE_TRUSTED_SIGNING_ACCOUNT_NAME=%q\n'        "$AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"
      [[ -n "${AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE:-}" ]] && printf 'export AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE=%q\n' "$AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE"
      printf '\n'
    fi
    if [[ -n "${CSC_LINK:-}" ]]; then
      printf '# --- Windows: PFX certificate ---\n'
      printf 'export CSC_LINK=%q\n'         "$CSC_LINK"
      printf 'export CSC_KEY_PASSWORD=%q\n' "$CSC_KEY_PASSWORD"
      printf '\n'
    fi
  fi

  if [[ "$PLATFORM" == "macos" || "$PLATFORM" == "both" ]]; then
    if [[ -n "${APPLE_CERTIFICATE_P12:-}" ]]; then
      printf '# --- macOS: Apple Developer ID + notarization ---\n'
      printf 'export APPLE_CERTIFICATE_P12=%q\n'         "$APPLE_CERTIFICATE_P12"
      printf 'export APPLE_CERTIFICATE_PASSWORD=%q\n'    "$APPLE_CERTIFICATE_PASSWORD"
      printf 'export APPLE_ID=%q\n'                      "$APPLE_ID"
      printf 'export APPLE_APP_SPECIFIC_PASSWORD=%q\n'   "$APPLE_APP_SPECIFIC_PASSWORD"
      printf 'export APPLE_TEAM_ID=%q\n'                 "$APPLE_TEAM_ID"
      printf '\n'
    fi
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE (mode 600)"

# --- Validate ---------------------------------------------------------------
info "Validating configuration..."
VALID=1
if [[ "$PLATFORM" == "windows" || "$PLATFORM" == "both" ]]; then
  if [[ "${METHOD:-}" == "pfx" ]]; then
    for v in CSC_LINK CSC_KEY_PASSWORD; do
      [[ -z "${!v:-}" ]] && { err "Missing $v"; VALID=0; }
    done
  else
    for v in AZURE_TRUSTED_SIGNING_TENANT_ID AZURE_TRUSTED_SIGNING_ACCOUNT_NAME AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE; do
      [[ -z "${!v:-}" ]] && { err "Missing $v"; VALID=0; }
    done
  fi
fi
if [[ "$PLATFORM" == "macos" || "$PLATFORM" == "both" ]]; then
  for v in APPLE_CERTIFICATE_P12 APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
    [[ -z "${!v:-}" ]] && { err "Missing $v"; VALID=0; }
  done
fi

if (( VALID )); then
  ok "Configuration validated successfully."
else
  err "Configuration incomplete — some required values are missing."
  exit 2
fi

# --- Next steps -------------------------------------------------------------
cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Next steps
────────────────────────────────────────────────────────────────────────────────

1. Source the file before building locally:
     source $ENV_FILE
     cd electron && npm run build:win   # or build:mac

2. For CI/CD (GitHub Actions), add the same values as GitHub Secrets:
     https://github.com/<owner>/<repo>/settings/secrets/actions

EOF

if [[ "$PLATFORM" == "windows" || "$PLATFORM" == "both" ]]; then
  if [[ "${METHOD:-}" == "pfx" ]]; then
    cat <<EOF
   Windows (PFX):
     CSC_LINK            → path or base64-encoded PFX
     CSC_KEY_PASSWORD    → PFX password
EOF
  else
    cat <<'EOF'
   Windows (Azure Trusted Signing):
     AZURE_TRUSTED_SIGNING_TENANT_ID
     AZURE_TRUSTED_SIGNING_ACCOUNT_NAME
     AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE
     AZURE_TRUSTED_SIGNING_CLIENT_ID        (service principal)
     AZURE_TRUSTED_SIGNING_CLIENT_SECRET    (service principal)
EOF
  fi
fi

if [[ "$PLATFORM" == "macos" || "$PLATFORM" == "both" ]]; then
  cat <<'EOF'
   macOS (Apple Developer ID + notarization):
     APPLE_CERTIFICATE_P12         → base64-encoded Developer ID P12
     APPLE_CERTIFICATE_PASSWORD    → P12 password
     APPLE_ID                      → Apple ID email
     APPLE_APP_SPECIFIC_PASSWORD   → app-specific password (appleid.apple.com)
     APPLE_TEAM_ID                 → Apple Developer Team ID
EOF
fi

cat <<EOF

3. Verify the signature after building:
     ./scripts/verify-signing.sh --app electron/dist-electron/<installer>

4. The $ENV_FILE file is gitignored — never commit real credentials.
────────────────────────────────────────────────────────────────────────────────
EOF

exit 0
