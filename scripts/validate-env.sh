#!/usr/bin/env bash
#
# validate-env.sh — Validate environment variables for the Remote Lockdown System.
#
# Verifies that required env vars are present and that secrets meet minimum
# strength requirements. Designed to be called from server startup (refuse to
# start in production with missing/weak secrets) and from CI as a standalone
# check.
#
# Usage:
#   ./scripts/validate-env.sh [options]
#
# Options:
#   --check-required   Verify all required env vars are set
#   --check-strength   Verify secrets meet minimum length (32+ chars)
#   --env-file <path>  Load a specific .env file before validating
#   --production       Strict mode: fail on any missing var
#   --json             Output validation results as JSON
#   -h, --help         Show this help message
#
# Exit codes:
#   0 — valid
#   1 — missing required vars
#   2 — weak secrets (present but below strength threshold)
#  64 — usage error

set -uo pipefail

# --- Configuration ----------------------------------------------------------
# Required env vars (excluding secrets handled by --check-strength).
REQUIRED_VARS=(
  "CORS_ORIGIN"
)

# Database: either DATABASE_URL or the DB_* group must be present.
DB_GROUP_VARS=("DB_HOST" "DB_PORT" "DB_NAME" "DB_USER" "DB_PASSWORD")

# Secret env vars subject to strength checks.
SECRET_VARS=(
  "JWT_SECRET"
  "AGENT_SHARED_KEY"
  "AGENT_KEY_PEPPER"
  "FIELD_ENCRYPTION_KEY"
  "LOCATION_FIELD_KEY"
)

# Minimum length for a secret (chars). 32 bytes -> 64 hex chars; we accept
# any 32+ char string as "strong enough" for a generic check.
MIN_SECRET_LEN=32

# --- Defaults / state -------------------------------------------------------
CHECK_REQUIRED=0
CHECK_STRENGTH=0
ENV_FILE=""
PRODUCTION=0
JSON=0

# Validation result collections.
declare -a MISSING=()
declare -a WEAK=()
declare -A VALUES=()

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-required) CHECK_REQUIRED=1; shift ;;
    --check-strength) CHECK_STRENGTH=1; shift ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a path argument}"
      shift 2
      ;;
    --production) PRODUCTION=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) usage ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 64
      ;;
  esac
done

# Default behavior: if neither check flag is given, run both.
if [[ $CHECK_REQUIRED -eq 0 && $CHECK_STRENGTH -eq 0 ]]; then
  CHECK_REQUIRED=1
  CHECK_STRENGTH=1
fi

# --- Load .env file if requested -------------------------------------------
# We source a sanitized version: strip comments/blank lines and export vars.
# This mirrors how dotenv loads a file without requiring node.
if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 64
  fi
  set -a
  # shellcheck disable=SC1090
  # Parse line-by-line to avoid executing arbitrary commands in the file.
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip blank lines and comments.
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip surrounding whitespace.
    line="${line#"${line%%[![:space:]]*}"}"
    # Only accept KEY=VALUE form.
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      key="${line%%=*}"
      val="${line#*=}"
      # Strip surrounding quotes from value.
      val="${val#\"}"; val="${val%\"}"
      val="${val#\'}"; val="${val%\'}"
      export "$key=$val"
    fi
  done < "$ENV_FILE"
  set +a
fi

# In production strict mode, required check is implied.
if [[ $PRODUCTION -eq 1 ]]; then
  CHECK_REQUIRED=1
  CHECK_STRENGTH=1
fi

# --- Helpers ----------------------------------------------------------------
get_var() {
  # Echo the value of an env var, empty if unset.
  local name="$1"
  printf '%s' "${!name:-}"
}

var_is_set() {
  local name="$1"
  local val
  val="$(get_var "$name")"
  [[ -n "$val" ]]
}

# --- Required-var checks ----------------------------------------------------
check_required() {
  # Core required vars.
  for v in "${REQUIRED_VARS[@]}"; do
    if ! var_is_set "$v"; then
      MISSING+=("$v")
    fi
  done

  # Database: DATABASE_URL OR the full DB_* group OR USE_SQLITE=true.
  if ! var_is_set "DATABASE_URL" && ! var_is_set "USE_SQLITE"; then
    db_missing=0
    for v in "${DB_GROUP_VARS[@]}"; do
      if ! var_is_set "$v"; then
        MISSING+=("$v")
        db_missing=1
      fi
    done
    if [[ $db_missing -eq 1 ]]; then
      MISSING+=("DATABASE_URL")
    fi
  fi

  # Secrets are "required" in the sense that they must be set; strength is
  # checked separately. We list them as required so missing secrets are
  # reported under --check-required too.
  for v in "${SECRET_VARS[@]}"; do
    if ! var_is_set "$v"; then
      MISSING+=("$v")
    fi
  done
}

# --- Strength checks --------------------------------------------------------
check_strength() {
  for v in "${SECRET_VARS[@]}"; do
    local val
    val="$(get_var "$v")"
    # Only flag weak if the var is set but too short. Missing vars are
    # reported by --check-required.
    if [[ -n "$val" && ${#val} -lt $MIN_SECRET_LEN ]]; then
      WEAK+=("$v (${#val} chars, need >= ${MIN_SECRET_LEN})")
    fi
  done
}

# --- Run checks -------------------------------------------------------------
if [[ $CHECK_REQUIRED -eq 1 ]]; then
  check_required
fi
if [[ $CHECK_STRENGTH -eq 1 ]]; then
  check_strength
fi

# --- Determine exit code ----------------------------------------------------
EXIT_CODE=0
if [[ ${#MISSING[@]} -gt 0 ]]; then
  EXIT_CODE=1
fi
if [[ ${#WEAK[@]} -gt 0 ]]; then
  # Weak secrets take precedence over missing for the 2 code, but if both
  # are present we report missing (1) first since it's more fundamental.
  if [[ $EXIT_CODE -eq 0 ]]; then
    EXIT_CODE=2
  fi
fi

# --- Output -----------------------------------------------------------------
emit_text() {
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    echo "MISSING required environment variables:"
    printf '  - %s\n' "${MISSING[@]}"
  else
    echo "OK: all required environment variables are set."
  fi

  if [[ $CHECK_STRENGTH -eq 1 ]]; then
    if [[ ${#WEAK[@]} -gt 0 ]]; then
      echo "WEAK secrets (below ${MIN_SECRET_LEN} chars):"
      printf '  - %s\n' "${WEAK[@]}"
    else
      echo "OK: all secrets meet minimum strength (${MIN_SECRET_LEN}+ chars)."
    fi
  fi

  if [[ $PRODUCTION -eq 1 && $EXIT_CODE -ne 0 ]]; then
    echo "FAIL: production strict mode — refusing to start with env errors."
  fi
}

emit_json() {
  # Build JSON arrays manually (no jq dependency).
  json_missing="[]"
  if [[ ${#MISSING[@]} -gt 0 ]]; then
    json_missing=$(printf '"%s",' "${MISSING[@]}")
    json_missing="[${json_missing%,}]"
  fi
  json_weak="[]"
  if [[ ${#WEAK[@]} -gt 0 ]]; then
    # Weak entries contain descriptive text; strip to var name for JSON.
    json_weak=$(printf '"%s",' "${WEAK[@]}")
    json_weak="[${json_weak%,}]"
  fi
  cat <<EOF
{
  "valid": $([[ $EXIT_CODE -eq 0 ]] && echo true || echo false),
  "exit_code": $EXIT_CODE,
  "missing": $json_missing,
  "weak": $json_weak,
  "production": $([[ $PRODUCTION -eq 1 ]] && echo true || echo false)
}
EOF
}

if [[ $JSON -eq 1 ]]; then
  emit_json
else
  emit_text
fi

exit $EXIT_CODE
