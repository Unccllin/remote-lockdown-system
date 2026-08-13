#!/usr/bin/env bash
#
# backup.sh — Create an encrypted backup of the Remote Lockdown System.
#
# Backs up:
#   - Database (PostgreSQL via pg_dump --format=custom, or SQLite file copy)
#   - secrets/ directory (FIELD_ENCRYPTION_KEY, LOCATION_FIELD_KEY, etc.)
#   - .env file (if present)
#   - Config files (docker-compose*.yml, Caddyfile, .env.prod.example)
#
# The database dump, secrets, and config files are tar'd into a single
# archive and then encrypted with either GPG (asymmetric, public key) or
# openssl (symmetric, passphrase).
#
# Usage:
#   ./scripts/backup.sh [options]
#
# Options:
#   --output <path>      Output file (default: lockdown-backup-YYYYMMDD-HHMMSS.tar.gz.enc)
#   --encrypt-key <key>  GPG recipient (email/fingerprint) OR openssl passphrase.
#                        If the value looks like an email/fingerprint and gpg is
#                        available, GPG asymmetric encryption is used. Otherwise
#                        openssl symmetric encryption (aes-256-cbc) is used and
#                        the value is treated as the passphrase.
#   --db-url <url>       Override the PostgreSQL DATABASE_URL.
#   --verify             After backup, restore to a temp DB and compare row counts.
#   --cron               Machine-friendly output (no prompts, no color).
#   --retain-days <n>    Delete backups older than N days from the output directory.
#   -h, --help           Show this help message.
#
# Exit codes:
#   0 — success
#   1 — error
#
# Environment variables read:
#   DATABASE_URL, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL,
#   DB_SSL_VERIFY  — PostgreSQL connection (see server/.env.example)
#   USE_SQLITE, SQLITE_PATH  — SQLite mode (see electron/server-starter.js)
#   BACKUP_ENCRYPT_KEY       — default encrypt key if --encrypt-key not given
#   BACKUP_GPG_RECIPIENT     — default GPG recipient

set -euo pipefail

# --- Defaults ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEFAULT_OUTPUT="${PROJECT_ROOT}/lockdown-backup-${TIMESTAMP}.tar.gz.enc"

OUTPUT=""
ENCRYPT_KEY="${BACKUP_ENCRYPT_KEY:-}"
DB_URL_OVERRIDE=""
VERIFY=0
CRON=0
RETAIN_DAYS=0

# --- Internal verify mode ---------------------------------------------------
# When the script re-invokes itself with --verify-internal, it jumps straight
# into the verification routine and exits. This keeps all logic in one file
# while avoiding arg-parsing conflicts with the public options.
if [[ "${1:-}" == "--verify-internal" ]]; then
  V_BACKUP="$2"
  V_KEY="$3"
  V_DBTYPE="$4"
  vlog() { printf '[VERIFY] %s\n' "$*"; }

  V_WORK="$(mktemp -d -t lockdown-verify-XXXXXX)"
  trap 'rm -rf "${V_WORK}"' EXIT

  # Decrypt
  if [[ -n "${V_KEY}" && "${V_KEY}" == *@* ]] && command -v gpg >/dev/null 2>&1; then
    gpg --batch --decrypt --output "${V_WORK}/decrypted.tar.gz" "${V_BACKUP}" 2>/dev/null
  else
    openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"${V_KEY}" \
      -in "${V_BACKUP}" -out "${V_WORK}/decrypted.tar.gz" 2>/dev/null
  fi

  if [[ ! -s "${V_WORK}/decrypted.tar.gz" ]]; then
    vlog "ERROR: decryption failed or produced empty output"
    exit 1
  fi

  tar -xzf "${V_WORK}/decrypted.tar.gz" -C "${V_WORK}" 2>/dev/null
  STG="${V_WORK}/staging"

  if [[ "${V_DBTYPE}" == "postgres" ]]; then
    command -v pg_restore >/dev/null 2>&1 || { vlog "ERROR: pg_restore not found"; exit 1; }
    command -v psql >/dev/null 2>&1 || { vlog "ERROR: psql not found"; exit 1; }
    # Derive a temp DB URL by appending a suffix to the db name.
    PG_URL="${DATABASE_URL:-}"
    [[ -z "${PG_URL}" ]] && PG_URL="${DB_URL_OVERRIDE:-}"
    if [[ -z "${PG_URL}" ]]; then
      vlog "ERROR: cannot verify without a PostgreSQL URL"
      exit 1
    fi
    # Replace the db name in the URL (strip query string first).
    BASE_URL="${PG_URL%%\?*}"
    TMP_URL="${BASE_URL}_verify_$$"
    createdb --no-password "${TMP_URL}" 2>/dev/null || true
    if ! pg_restore --no-password --dbname="${TMP_URL}" --clean --if-exists \
          "${STG}/database.dump" >"${V_WORK}/restore.log" 2>&1; then
      vlog "WARN: pg_restore reported errors (may be benign for --clean); continuing"
    fi
    counts="$(psql --no-password --dbname="${TMP_URL}" -t -A -F$'\t' -c \
      "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;" 2>/dev/null || true)"
    dropdb --no-password "${TMP_URL}" 2>/dev/null || true
  else
    command -v sqlite3 >/dev/null 2>&1 || { vlog "ERROR: sqlite3 not found"; exit 1; }
    if [[ ! -f "${STG}/database.db" ]]; then
      vlog "ERROR: no database.db in backup"
      exit 1
    fi
    counts="$(sqlite3 "${STG}/database.db" \
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" 2>/dev/null \
      | while IFS= read -r tbl; do
          cnt="$(sqlite3 "${STG}/database.db" "SELECT COUNT(*) FROM \"${tbl}\";" 2>/dev/null)"
          printf '%s\t%s\n' "${tbl}" "${cnt}"
        done)"
  fi

  if [[ -z "${counts}" ]]; then
    vlog "ERROR: could not retrieve row counts from restored temp DB"
    exit 1
  fi

  vlog "OK: restored to temp DB successfully. Row counts:"
  printf '%s\n' "${counts}"
  exit 0
fi

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Logging ----------------------------------------------------------------
log() {
  if [[ "${CRON}" -eq 1 ]]; then
    printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2"
  else
    local color=""
    case "$1" in
      INFO)  color="\033[0;36m" ;;
      OK)    color="\033[0;32m" ;;
      WARN)  color="\033[0;33m" ;;
      ERROR) color="\033[0;31m" ;;
    esac
    printf "${color}[%s]\033[0m %s\n" "$1" "$2"
  fi
}

die() {
  log ERROR "$1" >&2
  exit 1
}

# --- Arg parsing ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)       OUTPUT="$2"; shift 2 ;;
    --encrypt-key)  ENCRYPT_KEY="$2"; shift 2 ;;
    --db-url)       DB_URL_OVERRIDE="$2"; shift 2 ;;
    --verify)       VERIFY=1; shift ;;
    --cron)         CRON=1; shift ;;
    --retain-days)  RETAIN_DAYS="$2"; shift 2 ;;
    -h|--help)      usage ;;
    *) die "Unknown option: $1 (run with --help for usage)" ;;
  esac
done

[[ -z "${OUTPUT}" ]] && OUTPUT="${DEFAULT_OUTPUT}"

# --- Preflight checks -------------------------------------------------------
command -v tar >/dev/null 2>&1 || die "tar is required but not found"
command -v openssl >/dev/null 2>&1 || die "openssl is required but not found"

# --- Detect DB type ---------------------------------------------------------
# PostgreSQL if: DATABASE_URL set, or DB_* vars set, or --db-url given.
# SQLite if:     USE_SQLITE=true, or SQLITE_PATH set, or Electron mode.
detect_db_type() {
  if [[ -n "${DB_URL_OVERRIDE}" ]]; then
    echo "postgres"; return
  fi
  if [[ "${USE_SQLITE:-}" == "true" || -n "${SQLITE_PATH:-}" ]]; then
    echo "sqlite"; return
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "postgres"; return
  fi
  if [[ -n "${DB_HOST:-}" || -n "${DB_NAME:-}" || -n "${DB_USER:-}" ]]; then
    echo "postgres"; return
  fi
  echo "sqlite"
}

DB_TYPE="$(detect_db_type)"

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

# --- Work directory ---------------------------------------------------------
WORK_DIR="$(mktemp -d -t lockdown-backup-XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

STAGING_DIR="${WORK_DIR}/staging"
mkdir -p "${STAGING_DIR}"

# --- 1. Database backup -----------------------------------------------------
log INFO "Detected database type: ${DB_TYPE}"

if [[ "${DB_TYPE}" == "postgres" ]]; then
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump is required for PostgreSQL backups but not found"
  PG_URL="$(resolve_pg_url)"
  [[ -z "${PG_URL}" ]] && die "Could not resolve PostgreSQL connection URL"
  log INFO "Running pg_dump (custom format)..."
  if ! PGPASSWORD="${DB_PASSWORD:-}" pg_dump --format=custom --no-password \
        --dbname="${PG_URL}" --file="${STAGING_DIR}/database.dump" 2>"${WORK_DIR}/pgdump.err"; then
    log ERROR "pg_dump failed:" >&2
    cat "${WORK_DIR}/pgdump.err" >&2
    die "Database backup failed"
  fi
  printf '%s\n' "${PG_URL}" >"${STAGING_DIR}/db-source.txt"
  log OK "PostgreSQL dump complete ($(du -h "${STAGING_DIR}/database.dump" | cut -f1))"
elif [[ "${DB_TYPE}" == "sqlite" ]]; then
  SQLITE_PATH="$(resolve_sqlite_path)"
  if [[ ! -f "${SQLITE_PATH}" ]]; then
    die "SQLite database file not found: ${SQLITE_PATH}"
  fi
  log INFO "Copying SQLite database: ${SQLITE_PATH}"
  if command -v sqlite3 >/dev/null 2>&1; then
    if ! sqlite3 "${SQLITE_PATH}" ".backup '${STAGING_DIR}/database.db'" 2>"${WORK_DIR}/sqlite.err"; then
      log WARN "sqlite3 .backup failed, falling back to file copy"
      cat "${WORK_DIR}/sqlite.err" >&2
      cp "${SQLITE_PATH}" "${STAGING_DIR}/database.db"
    fi
  else
    cp "${SQLITE_PATH}" "${STAGING_DIR}/database.db"
  fi
  printf '%s\n' "${SQLITE_PATH}" >"${STAGING_DIR}/db-source.txt"
  log OK "SQLite copy complete ($(du -h "${STAGING_DIR}/database.db" | cut -f1))"
else
  die "Unknown database type: ${DB_TYPE}"
fi

# --- 2. Secrets directory ---------------------------------------------------
if [[ -d "${PROJECT_ROOT}/secrets" ]]; then
  log INFO "Backing up secrets/ directory"
  cp -a "${PROJECT_ROOT}/secrets" "${STAGING_DIR}/secrets"
else
  log WARN "No secrets/ directory found at ${PROJECT_ROOT}/secrets"
fi

# --- 3. .env files ----------------------------------------------------------
for envfile in "${PROJECT_ROOT}/.env" "${PROJECT_ROOT}/.env.prod" "${PROJECT_ROOT}/server/.env"; do
  if [[ -f "${envfile}" ]]; then
    rel="${envfile#${PROJECT_ROOT}/}"
    mkdir -p "${STAGING_DIR}/env/$(dirname "${rel}")"
    cp "${envfile}" "${STAGING_DIR}/env/${rel}"
    log INFO "Backed up ${rel}"
  fi
done

# --- 4. Config files --------------------------------------------------------
mkdir -p "${STAGING_DIR}/config"
for cfgfile in docker-compose.yml docker-compose.prod.yml Caddyfile .env.prod.example; do
  if [[ -f "${PROJECT_ROOT}/${cfgfile}" ]]; then
    cp "${PROJECT_ROOT}/${cfgfile}" "${STAGING_DIR}/config/${cfgfile}"
    log INFO "Backed up ${cfgfile}"
  fi
done

# --- 5. Write manifest ------------------------------------------------------
{
  printf 'lockdown-backup manifest\n'
  printf 'timestamp=%s\n' "${TIMESTAMP}"
  printf 'db_type=%s\n' "${DB_TYPE}"
  printf 'hostname=%s\n' "$(hostname 2>/dev/null || echo unknown)"
  printf 'created_by=%s\n' "$(whoami 2>/dev/null || echo unknown)"
  printf 'files:\n'
  (cd "${STAGING_DIR}" && find . -type f | sort)
} >"${STAGING_DIR}/MANIFEST.txt"

# --- 6. Tar -----------------------------------------------------------------
TAR_PATH="${WORK_DIR}/backup.tar.gz"
log INFO "Creating tar archive..."
tar -czf "${TAR_PATH}" -C "${WORK_DIR}" staging
log OK "Archive created ($(du -h "${TAR_PATH}" | cut -f1))"

# --- 7. Encrypt -------------------------------------------------------------
encrypt_backup() {
  local input="$1"
  local output="$2"
  local key="${ENCRYPT_KEY}"

  local use_gpg=0
  if [[ -n "${key}" ]] && command -v gpg >/dev/null 2>&1; then
    # Heuristic: email or 8-40 char hex fingerprint/keyid.
    if [[ "${key}" == *@* ]] || [[ "${key}" =~ ^[A-Fa-f0-9]{8,40}$ ]]; then
      use_gpg=1
    fi
  fi

  if [[ "${use_gpg}" -eq 1 ]]; then
    log INFO "Encrypting with GPG (recipient: ${key})"
    if ! gpg --batch --yes --encrypt --recipient "${key}" \
             --output "${output}" "${input}" 2>"${WORK_DIR}/gpg.err"; then
      log ERROR "GPG encryption failed:" >&2
      cat "${WORK_DIR}/gpg.err" >&2
      die "Encryption failed"
    fi
    printf 'gpg\n' >"${WORK_DIR}/enc-method.txt"
  else
    if [[ -z "${key}" ]]; then
      if [[ "${CRON}" -eq 1 ]]; then
        die "No --encrypt-key provided in --cron mode (refusing to generate an unrecoverable passphrase)"
      fi
      key="$(openssl rand -hex 24)"
      log WARN "No --encrypt-key provided. Generated a random passphrase."
      log WARN "SAVE THIS PASSPHRASE — without it the backup cannot be decrypted:"
      printf 'PASSPHRASE=%s\n' "${key}" >&2
    fi
    log INFO "Encrypting with openssl (aes-256-cbc)"
    if ! openssl enc -aes-256-cbc -salt -pbkdf2 \
          -pass pass:"${key}" \
          -in "${input}" -out "${output}" 2>"${WORK_DIR}/openssl.err"; then
      log ERROR "openssl encryption failed:" >&2
      cat "${WORK_DIR}/openssl.err" >&2
      die "Encryption failed"
    fi
    printf 'openssl\n' >"${WORK_DIR}/enc-method.txt"
  fi
}

encrypt_backup "${TAR_PATH}" "${OUTPUT}"
log OK "Encrypted backup written to ${OUTPUT} ($(du -h "${OUTPUT}" | cut -f1))"

# --- 8. Verify (optional) ---------------------------------------------------
if [[ "${VERIFY}" -eq 1 ]]; then
  log INFO "Verification enabled — restoring to temp DB and comparing row counts"
  if ! bash "${BASH_SOURCE[0]}" --verify-internal "${OUTPUT}" "${ENCRYPT_KEY}" "${DB_TYPE}"; then
    die "Backup verification failed"
  fi
  log OK "Backup verified successfully"
fi

# --- Done -------------------------------------------------------------------
# Prune old backups if --retain-days was specified
if [[ "${RETAIN_DAYS}" -gt 0 ]]; then
  BACKUP_DIR="$(dirname "${OUTPUT}")"
  PRUNED=$(find "${BACKUP_DIR}" -name 'lockdown-backup-*.tar.gz.enc' -mtime +${RETAIN_DAYS} -delete -print 2>/dev/null | wc -l)
  if [[ "${PRUNED}" -gt 0 ]]; then
    log INFO "Pruned ${PRUNED} backup(s) older than ${RETAIN_DAYS} days from ${BACKUP_DIR}"
  fi
fi

if [[ "${CRON}" -eq 1 ]]; then
  printf 'BACKUP_OK path=%s size=%s db_type=%s\n' \
    "${OUTPUT}" "$(stat -c%s "${OUTPUT}" 2>/dev/null || stat -f%z "${OUTPUT}")" "${DB_TYPE}"
else
  log OK "Backup complete: ${OUTPUT}"
fi
exit 0
