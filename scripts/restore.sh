#!/usr/bin/env bash
#
# restore.sh — Restore the Remote Lockdown System from an encrypted backup.
#
# Decrypts a backup produced by scripts/backup.sh, extracts the archive,
# and restores:
#   - Database (PostgreSQL via pg_restore --clean --if-exists, or SQLite copy)
#   - secrets/ directory
#   - .env files
#   - Config files
#
# For safety, restore refuses to overwrite an existing populated database
# unless --force is given.
#
# Usage:
#   ./scripts/restore.sh [options]
#
# Options:
#   --input <path>       Backup file to restore from (required).
#   --decrypt-key <key>  GPG recipient (for asymmetric) OR openssl passphrase.
#                        The method is auto-detected: if the backup was made
#                        with GPG (recipient looks like an email/fingerprint),
#                        gpg --decrypt is used; otherwise openssl.
#   --force              Overwrite existing data without prompting.
#   --db-url <url>       Override the PostgreSQL DATABASE_URL to restore into.
#   --secrets-only       Only restore the secrets/ directory and env files,
#                        skip the database restore.
#   -h, --help           Show this help message.
#
# Exit codes:
#   0 — success
#   1 — error
#
# Environment variables read:
#   DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
#   USE_SQLITE, SQLITE_PATH

set -euo pipefail

# --- Defaults ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT=""
DECRYPT_KEY=""
FORCE=0
DB_URL_OVERRIDE=""
SECRETS_ONLY=0

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Logging ----------------------------------------------------------------
log() {
  local color=""
  case "$1" in
    INFO)  color="\033[0;36m" ;;
    OK)    color="\033[0;32m" ;;
    WARN)  color="\033[0;33m" ;;
    ERROR) color="\033[0;31m" ;;
  esac
  printf "${color}[%s]\033[0m %s\n" "$1" "$2"
}

die() {
  log ERROR "$1" >&2
  exit 1
}

confirm() {
  if [[ "${FORCE}" -eq 1 ]]; then
    return 0
  fi
  local prompt="$1"
  read -r -p "${prompt} [y/N] " ans
  [[ "${ans}" =~ ^[Yy]$ ]]
}

# --- Arg parsing ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)        INPUT="$2"; shift 2 ;;
    --decrypt-key)  DECRYPT_KEY="$2"; shift 2 ;;
    --force)        FORCE=1; shift ;;
    --db-url)       DB_URL_OVERRIDE="$2"; shift 2 ;;
    --secrets-only) SECRETS_ONLY=1; shift ;;
    -h|--help)      usage ;;
    *) die "Unknown option: $1 (run with --help for usage)" ;;
  esac
done

[[ -z "${INPUT}" ]] && die "--input <path> is required"
[[ -f "${INPUT}" ]] || die "Backup file not found: ${INPUT}"

# --- Preflight --------------------------------------------------------------
command -v tar >/dev/null 2>&1 || die "tar is required but not found"
command -v openssl >/dev/null 2>&1 || die "openssl is required but not found"

# --- Work directory ---------------------------------------------------------
WORK_DIR="$(mktemp -d -t lockdown-restore-XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

# --- 1. Decrypt -------------------------------------------------------------
log INFO "Decrypting backup: ${INPUT}"

# Auto-detect encryption method. Try GPG first if the key looks like a
# recipient; otherwise use openssl symmetric.
DECRYPTED="${WORK_DIR}/backup.tar.gz"
decrypt_succeeded=0

if [[ -n "${DECRYPT_KEY}" && "${DECRYPT_KEY}" == *@* ]] && command -v gpg >/dev/null 2>&1; then
  log INFO "Attempting GPG decryption (recipient: ${DECRYPT_KEY})"
  if gpg --batch --decrypt --output "${DECRYPTED}" "${INPUT}" 2>"${WORK_DIR}/gpg.err"; then
    decrypt_succeeded=1
  else
    log WARN "GPG decryption failed, falling back to openssl"
    cat "${WORK_DIR}/gpg.err" >&2 || true
  fi
fi

if [[ "${decrypt_succeeded}" -eq 0 ]]; then
  if [[ -z "${DECRYPT_KEY}" ]]; then
    die "No --decrypt-key provided. The backup is encrypted and cannot be read without the key."
  fi
  log INFO "Attempting openssl decryption (aes-256-cbc)"
  if ! openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"${DECRYPT_KEY}" \
        -in "${INPUT}" -out "${DECRYPTED}" 2>"${WORK_DIR}/openssl.err"; then
    log ERROR "openssl decryption failed:" >&2
    cat "${WORK_DIR}/openssl.err" >&2
    die "Decryption failed — wrong key or corrupted backup?"
  fi
  decrypt_succeeded=1
fi

[[ -s "${DECRYPTED}" ]] || die "Decryption produced an empty file — wrong key?"
log OK "Decryption complete ($(du -h "${DECRYPTED}" | cut -f1))"

# --- 2. Extract -------------------------------------------------------------
EXTRACT_DIR="${WORK_DIR}/extracted"
mkdir -p "${EXTRACT_DIR}"
if ! tar -xzf "${DECRYPTED}" -C "${EXTRACT_DIR}" 2>"${WORK_DIR}/tar.err"; then
  log ERROR "tar extraction failed:" >&2
  cat "${WORK_DIR}/tar.err" >&2
  die "Backup archive is corrupted"
fi

# The backup tar contains a top-level "staging/" directory.
STAGING="${EXTRACT_DIR}/staging"
[[ -d "${STAGING}" ]] || STAGING="${EXTRACT_DIR}"
[[ -f "${STAGING}/MANIFEST.txt" ]] || die "Backup is missing MANIFEST.txt — not a valid lockdown backup"
log OK "Archive extracted"
log INFO "Backup manifest:"
sed 's/^/    /' "${STAGING}/MANIFEST.txt}"

# --- Read db_type from manifest --------------------------------------------
DB_TYPE=""
if grep -q '^db_type=postgres' "${STAGING}/MANIFEST.txt" 2>/dev/null; then
  DB_TYPE="postgres"
elif grep -q '^db_type=sqlite' "${STAGING}/MANIFEST.txt" 2>/dev/null; then
  DB_TYPE="sqlite"
else
  # Fall back to runtime detection.
  if [[ -f "${STAGING}/database.dump" ]]; then
    DB_TYPE="postgres"
  elif [[ -f "${STAGING}/database.db" ]]; then
    DB_TYPE="sqlite"
  fi
fi
[[ -n "${DB_TYPE}" ]] || die "Could not determine database type from backup"
log INFO "Backup database type: ${DB_TYPE}"

# --- Resolve PostgreSQL connection string -----------------------------------
resolve_pg_url() {
  if [[ -n "${DB_URL_OVERRIDE}" ]]; then
    printf '%s' "${DB_URL_OVERRIDE}"; return
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    printf '%s' "${DATABASE_URL}"; return
  fi
  local host="${DB_HOST:-localhost}"
  local port="${DB_PORT:-5432}"
  local name="${DB_NAME:-lockdown_db}"
  local user="${DB_USER:-postgres}"
  local pass="${DB_PASSWORD:-}"
  if [[ -n "${pass}" ]]; then
    printf 'postgres://%s:%s@%s:%s/%s' "${user}" "${pass}" "${host}" "${port}" "${name}"
  else
    printf 'postgres://%s@%s:%s/%s' "${user}" "${host}" "${port}" "${name}"
  fi
}

# --- Resolve SQLite path ----------------------------------------------------
resolve_sqlite_path() {
  if [[ -n "${SQLITE_PATH:-}" && "${SQLITE_PATH}" != ":memory:" ]]; then
    printf '%s' "${SQLITE_PATH}"; return
  fi
  printf '%s' "${PROJECT_ROOT}/server/.sqlite-data/lockdown.db"
}

# --- 3. Detect existing DB & guard with --force -----------------------------
db_has_data() {
  if [[ "${DB_TYPE}" == "postgres" ]]; then
    command -v psql >/dev/null 2>&1 || return 1
    local url
    url="$(resolve_pg_url)"
    # Count rows in a few core tables; if any exist, consider DB populated.
    local total
    total="$(psql --no-password --dbname="${url}" -t -A -c \
      "SELECT COALESCE(SUM(n_live_tup),0) FROM pg_stat_user_tables;" 2>/dev/null || echo 0)"
    total="$(echo "${total}" | tr -d '[:space:]')"
    [[ "${total}" -gt 0 ]] 2>/dev/null && return 0 || return 1
  else
    local dbpath
    dbpath="$(resolve_sqlite_path)"
    [[ -f "${dbpath}" ]] || return 1
    command -v sqlite3 >/dev/null 2>&1 || return 1
    local total
    total="$(sqlite3 "${dbpath}" \
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" 2>/dev/null || echo 0)"
    total="$(echo "${total}" | tr -d '[:space:]')"
    [[ "${total}" -gt 0 ]] 2>/dev/null && return 0 || return 1
  fi
}

# --- 4. Database restore ----------------------------------------------------
if [[ "${SECRETS_ONLY}" -eq 1 ]]; then
  log INFO "Skipping database restore (--secrets-only)"
else
  # Guard: refuse to overwrite existing data without --force.
  if db_has_data; then
    if [[ "${FORCE}" -eq 0 ]]; then
      log ERROR "Target database already contains data." >&2
      log ERROR "Refusing to overwrite without --force. Re-run with --force to proceed." >&2
      die "Existing data detected and --force not set"
    fi
      log WARN "Target database contains data — --force set, proceeding with overwrite"
  fi

  if [[ "${DB_TYPE}" == "postgres" ]]; then
    command -v pg_restore >/dev/null 2>&1 || die "pg_restore is required for PostgreSQL restore but not found"
    [[ -f "${STAGING}/database.dump" ]] || die "Backup is missing database.dump (PostgreSQL)"
    PG_URL="$(resolve_pg_url)"
    [[ -z "${PG_URL}" ]] && die "Could not resolve PostgreSQL connection URL"
    log INFO "Running pg_restore --clean --if-exists into target database..."
    if ! PGPASSWORD="${DB_PASSWORD:-}" pg_restore --no-password --clean --if-exists \
          --dbname="${PG_URL}" "${STAGING}/database.dump" 2>"${WORK_DIR}/pgrestore.err"; then
      # pg_restore --clean emits non-fatal errors for missing objects; only
      # treat a totally empty restore as failure.
      if ! grep -qiE 'could not|fatal|permission denied' "${WORK_DIR}/pgrestore.err" \
          || grep -qiE 'restored|processing' "${WORK_DIR}/pgrestore.err"; then
        log WARN "pg_restore reported warnings (common with --clean on partial DBs):"
        sed 's/^/    /' "${WORK_DIR}/pgrestore.err" | head -20 >&2
      else
        log ERROR "pg_restore failed:" >&2
        cat "${WORK_DIR}/pgrestore.err" >&2
        die "Database restore failed"
      fi
    fi
    log OK "PostgreSQL restore complete"
  elif [[ "${DB_TYPE}" == "sqlite" ]]; then
    [[ -f "${STAGING}/database.db" ]] || die "Backup is missing database.db (SQLite)"
    SQLITE_PATH="$(resolve_sqlite_path)"
    SQLITE_DIR="$(dirname "${SQLITE_PATH}")"
    mkdir -p "${SQLITE_DIR}"
    if [[ -f "${SQLITE_PATH}" ]]; then
      if [[ "${FORCE}" -eq 0 ]]; then
        # db_has_data already guards this, but double-check.
        log ERROR "Existing SQLite DB at ${SQLITE_PATH} — use --force to overwrite" >&2
        die "Refusing to overwrite existing SQLite DB without --force"
      fi
      # Back up the existing file before overwriting.
      cp "${SQLITE_PATH}" "${SQLITE_PATH}.pre-restore.$(date +%Y%m%d%H%M%S)"
      log INFO "Existing SQLite DB backed up alongside new file"
    fi
    log INFO "Copying database.db → ${SQLITE_PATH}"
    cp "${STAGING}/database.db" "${SQLITE_PATH}"
    log OK "SQLite restore complete"
  else
    die "Unknown database type: ${DB_TYPE}"
  fi
fi

# --- 5. Restore secrets/ ----------------------------------------------------
if [[ -d "${STAGING}/secrets" ]]; then
  if [[ -d "${PROJECT_ROOT}/secrets" ]]; then
    if [[ "${FORCE}" -eq 0 ]] && [[ -n "$(ls -A "${PROJECT_ROOT}/secrets" 2>/dev/null)" ]]; then
      if ! confirm "Overwrite existing ${PROJECT_ROOT}/secrets/ ?"; then
        log WARN "Skipping secrets restore (user declined)"
      else
        rm -rf "${PROJECT_ROOT}/secrets"
        cp -a "${STAGING}/secrets" "${PROJECT_ROOT}/secrets"
        log OK "Secrets restored to ${PROJECT_ROOT}/secrets/"
      fi
    else
      rm -rf "${PROJECT_ROOT}/secrets"
      cp -a "${STAGING}/secrets" "${PROJECT_ROOT}/secrets"
      log OK "Secrets restored to ${PROJECT_ROOT}/secrets/"
    fi
  else
    cp -a "${STAGING}/secrets" "${PROJECT_ROOT}/secrets"
    log OK "Secrets restored to ${PROJECT_ROOT}/secrets/"
  fi
else
  log WARN "Backup did not contain a secrets/ directory"
fi

# --- 6. Restore .env files --------------------------------------------------
if [[ -d "${STAGING}/env" ]]; then
  log INFO "Restoring .env files"
  (cd "${STAGING}/env" && find . -type f | while IFS= read -r f; do
    rel="${f#./}"
    dest="${PROJECT_ROOT}/${rel}"
    if [[ -f "${dest}" ]] && [[ "${FORCE}" -eq 0 ]]; then
      if confirm "Overwrite ${rel}?"; then
        cp "${STAGING}/env/${rel}" "${dest}"
        log OK "Restored ${rel}"
      else
        log WARN "Skipped ${rel}"
      fi
    else
      mkdir -p "$(dirname "${dest}")"
      cp "${STAGING}/env/${rel}" "${dest}"
      log OK "Restored ${rel}"
    fi
  done)
fi

# --- 7. Print restore summary (table row counts) ---------------------------
print_summary() {
  if [[ "${SECRETS_ONLY}" -eq 1 ]]; then
    log OK "Restore complete (secrets only — database not touched)"
    return
  fi
  log OK "Restore complete. Database row counts:"
  if [[ "${DB_TYPE}" == "postgres" ]]; then
    command -v psql >/dev/null 2>&1 || { log WARN "psql not available — cannot print summary"; return; }
    local url
    url="$(resolve_pg_url)"
    psql --no-password --dbname="${url}" -c \
      "SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables ORDER BY relname;" 2>/dev/null \
      | sed 's/^/    /' || log WARN "Could not query row counts"
  else
    command -v sqlite3 >/dev/null 2>&1 || { log WARN "sqlite3 not available — cannot print summary"; return; }
    local dbpath
    dbpath="$(resolve_sqlite_path)"
    sqlite3 "${dbpath}" \
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" 2>/dev/null \
      | while IFS= read -r tbl; do
          cnt="$(sqlite3 "${dbpath}" "SELECT COUNT(*) FROM \"${tbl}\";" 2>/dev/null)"
          printf '    %s\t%s\n' "${tbl}" "${cnt}"
        done
  fi
}

print_summary

# --- Done -------------------------------------------------------------------
log OK "Restore finished successfully"
exit 0
