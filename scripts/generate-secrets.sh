#!/usr/bin/env bash
#
# generate-secrets.sh — Generate cryptographic secrets for the Remote Lockdown System.
#
# Produces the four Docker secret files referenced by docker-compose.yml:
#   - jwt_secret.txt
#   - agent_key_pepper.txt
#   - field_encryption_key.txt
#   - location_field_key.txt
#
# Each secret is 32 bytes of entropy rendered as hex (64 hex chars) via
# `openssl rand -hex 32`. The script also prints the env-var equivalents
# (e.g. JWT_SECRET=<value>) so they can be copied into a .env file or a
# secrets manager.
#
# Usage:
#   ./scripts/generate-secrets.sh [options]
#
# Options:
#   --output <dir>   Output directory (default: ./secrets/)
#   --dry-run        Show what would be generated without writing files
#   --stdout         Print secrets to stdout (for piping to other tools)
#   --force          Overwrite existing secrets (default: refuse to overwrite)
#   -h, --help       Show this help message
#
# Notes:
#   - Rotation of FIELD_ENCRYPTION_KEY / LOCATION_FIELD_KEY requires
#     re-encrypting all DB data — that is a separate feature and is NOT
#     handled here. Re-running this script with --force will break
#     existing encrypted data unless you re-encrypt.
#   - AGENT_SHARED_KEY is a legacy pre-shared key not mounted as a Docker
#     secret; it is intentionally not written to a file here. Generate it
#     manually with `openssl rand -hex 32` if needed.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------
OUTPUT_DIR="./secrets"
DRY_RUN=0
STDOUT_MODE=0
FORCE=0

# Secret definitions: file basename -> env var name.
# Order matches docker-compose.yml for readability.
declare -a SECRET_FILES=(
  "jwt_secret"
  "agent_key_pepper"
  "field_encryption_key"
  "location_field_key"
)
declare -A SECRET_ENV=(
  ["jwt_secret"]="JWT_SECRET"
  ["agent_key_pepper"]="AGENT_KEY_PEPPER"
  ["field_encryption_key"]="FIELD_ENCRYPTION_KEY"
  ["location_field_key"]="LOCATION_FIELD_KEY"
)

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT_DIR="${2:?--output requires a directory argument}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --stdout)
      STDOUT_MODE=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 64
      ;;
  esac
done

# --- Preflight checks -------------------------------------------------------
command -v openssl >/dev/null 2>&1 || {
  echo "ERROR: openssl is required but not found in PATH." >&2
  exit 127
}

# --- Determine mode ---------------------------------------------------------
# --stdout takes precedence: print secrets to stdout for piping and do not
# write any files unless --output is also given (in which case we both write
# and print). --dry-run never writes.

WRITE_FILES=0
if [[ $DRY_RUN -eq 0 && $STDOUT_MODE -eq 0 ]]; then
  WRITE_FILES=1
elif [[ $DRY_RUN -eq 0 && $STDOUT_MODE -eq 1 ]]; then
  # stdout mode: write only if output dir is explicitly usable; but to keep
  # semantics simple, stdout mode prints and also writes when not dry-run.
  WRITE_FILES=1
fi

# --- Check for existing files ----------------------------------------------
if [[ $WRITE_FILES -eq 1 ]]; then
  existing=()
  for name in "${SECRET_FILES[@]}"; do
    f="$OUTPUT_DIR/$name.txt"
    [[ -f "$f" ]] && existing+=("$f")
  done
  if [[ ${#existing[@]} -gt 0 && $FORCE -eq 0 ]]; then
    echo "ERROR: Refusing to overwrite existing secret files:" >&2
    printf '  %s\n' "${existing[@]}" >&2
    echo "Use --force to overwrite." >&2
    echo "WARNING: Overwriting FIELD_ENCRYPTION_KEY or LOCATION_FIELD_KEY will" >&2
    echo "         make existing encrypted DB data undecryptable." >&2
    exit 1
  fi
fi

# --- Create output directory ------------------------------------------------
if [[ $WRITE_FILES -eq 1 ]]; then
  mkdir -p "$OUTPUT_DIR"
  chmod 700 "$OUTPUT_DIR" 2>/dev/null || true
fi

# --- Generate secrets -------------------------------------------------------
# Generate all secrets up front so a failure aborts before writing anything.
declare -A VALUES=()
for name in "${SECRET_FILES[@]}"; do
  VALUES["$name"]="$(openssl rand -hex 32)"
done

# --- Validate entropy -------------------------------------------------------
# Each secret must be exactly 64 hex chars (32 bytes). Abort if any fail.
for name in "${SECRET_FILES[@]}"; do
  val="${VALUES[$name]}"
  if [[ ! "$val" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: Secret '$name' failed entropy validation (expected 64 hex chars, got ${#val})." >&2
    exit 1
  fi
done

# --- Output -----------------------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY RUN — no files will be written." >&2
  echo "Output directory: $OUTPUT_DIR" >&2
  echo >&2
fi

# File contents + env-var equivalents.
for name in "${SECRET_FILES[@]}"; do
  val="${VALUES[$name]}"
  env_name="${SECRET_ENV[$name]}"
  file_path="$OUTPUT_DIR/$name.txt"

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "Would write: $file_path" >&2
    echo "  $env_name=$val" >&2
  else
    if [[ $WRITE_FILES -eq 1 ]]; then
      printf '%s\n' "$val" > "$file_path"
      chmod 600 "$file_path"
    fi
    # In stdout mode, print env-var form to stdout for piping.
    if [[ $STDOUT_MODE -eq 1 ]]; then
      printf '%s=%s\n' "$env_name" "$val"
    fi
  fi
done

# --- Summary ----------------------------------------------------------------
# Summary goes to stderr so it doesn't pollute piped stdout.
if [[ $STDOUT_MODE -eq 0 ]]; then
  echo >&2
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "Dry run complete. Re-run without --dry-run to write files." >&2
  else
    echo "Generated ${#SECRET_FILES[@]} secret(s) in $OUTPUT_DIR:" >&2
    for name in "${SECRET_FILES[@]}"; do
      echo "  - $OUTPUT_DIR/$name.txt  (${SECRET_ENV[$name]})" >&2
    done
    echo >&2
    echo "Env-var equivalents (copy into .env or secrets manager):" >&2
    for name in "${SECRET_FILES[@]}"; do
      echo "  ${SECRET_ENV[$name]}=${VALUES[$name]}" >&2
    done
    echo >&2
    echo "WARNING: Keep these files private. Do not commit to git." >&2
    echo "WARNING: Rotating FIELD_ENCRYPTION_KEY / LOCATION_FIELD_KEY" >&2
    echo "         requires re-encrypting all existing DB data." >&2
  fi
fi

exit 0
