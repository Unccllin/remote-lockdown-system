#!/usr/bin/env bash
#
# validate-docker.sh — Validate Docker deployment configuration for the
# Remote Lockdown System.
#
# Validates the production Docker stack without requiring Docker to be
# installed. Each check degrades gracefully: if a native tool (docker,
# caddy, hadolint) is available it is used for a real syntax check;
# otherwise a basic structural check is performed so the script remains
# useful in CI and on developer laptops.
#
# Usage:
#   ./scripts/validate-docker.sh [options]
#
# Options:
#   --config       Validate docker-compose.prod.yml syntax
#   --env          Validate .env.prod has all keys from .env.prod.example
#   --caddy        Validate Caddyfile syntax
#   --dockerfile   Validate Dockerfile.server syntax
#   --live         Start the stack, health-check, and clean up (requires Docker)
#   --all          Run all non-live checks (config, env, caddy, dockerfile)
#   -h, --help     Show this help message
#
# Exit codes:
#   0 — all selected checks passed
#   1 — one or more checks failed

set -uo pipefail

# --- Configuration ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

COMPOSE_FILE="$PROJECT_ROOT/docker-compose.prod.yml"
TEST_COMPOSE_FILE="$PROJECT_ROOT/docker-compose.test.yml"
ENV_EXAMPLE="$PROJECT_ROOT/.env.prod.example"
ENV_FILE="$PROJECT_ROOT/.env.prod"
CADDYFILE="$PROJECT_ROOT/Caddyfile"
DOCKERFILE="$PROJECT_ROOT/Dockerfile.server"

# --- Defaults / state -------------------------------------------------------
RUN_CONFIG=0
RUN_ENV=0
RUN_CADDY=0
RUN_DOCKERFILE=0
RUN_LIVE=0
FAILURES=0

# --- Help -------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# --- Argument parsing -------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)     RUN_CONFIG=1;     shift ;;
    --env)        RUN_ENV=1;        shift ;;
    --caddy)      RUN_CADDY=1;      shift ;;
    --dockerfile) RUN_DOCKERFILE=1; shift ;;
    --live)       RUN_LIVE=1;       shift ;;
    --all)
      RUN_CONFIG=1
      RUN_ENV=1
      RUN_CADDY=1
      RUN_DOCKERFILE=1
      shift
      ;;
    -h|--help) usage ;;
    *)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 64
      ;;
  esac
done

# Default: if no flag is given, run all non-live checks.
if [[ $RUN_CONFIG -eq 0 && $RUN_ENV -eq 0 && $RUN_CADDY -eq 0 \
   && $RUN_DOCKERFILE -eq 0 && $RUN_LIVE -eq 0 ]]; then
  RUN_CONFIG=1
  RUN_ENV=1
  RUN_CADDY=1
  RUN_DOCKERFILE=1
fi

# --- Helpers ----------------------------------------------------------------
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }
warn() { echo "WARN: $1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- Check: compose config --------------------------------------------------
check_config() {
  echo "== validate-docker: compose config =="
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    fail "compose file not found: $COMPOSE_FILE"
    return
  fi

  if have docker; then
    # Use the real compose config command for a full validation.
    if docker compose -f "$COMPOSE_FILE" config --quiet >/dev/null 2>&1; then
      pass "docker compose config accepted $COMPOSE_FILE"
    else
      fail "docker compose config rejected $COMPOSE_FILE"
      docker compose -f "$COMPOSE_FILE" config >/dev/null 2>&1 || true
    fi
  elif have python3; then
    # Fallback: parse the YAML structurally.
    if python3 -c "import yaml,sys; yaml.safe_load(open('$COMPOSE_FILE'))" 2>/dev/null; then
      pass "python3 parsed $COMPOSE_FILE as valid YAML (docker not available)"
    else
      fail "$COMPOSE_FILE is not valid YAML"
    fi
  else
    warn "neither docker nor python3 available — skipping compose config check"
  fi
}

# --- Check: env vars --------------------------------------------------------
check_env() {
  echo "== validate-docker: env vars =="
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    fail "env example not found: $ENV_EXAMPLE"
    return
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "env file not found: $ENV_FILE (copy .env.prod.example to .env.prod and fill in values)"
    return
  fi

  # Extract non-commented KEY= lines from the example.
  mapfile -t EXAMPLE_KEYS < <(
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_EXAMPLE" \
      | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/' \
      | sort -u
  )

  missing=()
  for key in "${EXAMPLE_KEYS[@]}"; do
    if ! grep -qE "^${key}=" "$ENV_FILE"; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    pass "all ${#EXAMPLE_KEYS[@]} env keys from .env.prod.example are present in .env.prod"
  else
    fail "missing env keys in .env.prod:"
    printf '  - %s\n' "${missing[@]}" >&2
  fi

  # Warn about placeholder values that were never replaced.
  placeholders=()
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    case "$val" in
      CHANGE_ME*|"") placeholders+=("$key") ;;
    esac
  done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")
  if [[ ${#placeholders[@]} -gt 0 ]]; then
    warn "placeholder values still present in .env.prod (replace before deploying):"
    printf '  - %s\n' "${placeholders[@]}" >&2
  fi
}

# --- Check: Caddyfile -------------------------------------------------------
check_caddy() {
  echo "== validate-docker: Caddyfile =="
  if [[ ! -f "$CADDYFILE" ]]; then
    fail "Caddyfile not found: $CADDYFILE"
    return
  fi

  if have caddy; then
    if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
      pass "caddy validate accepted $CADDYFILE"
    else
      fail "caddy validate rejected $CADDYFILE"
      caddy validate --config "$CADDYFILE" 2>&1 || true
    fi
  else
    # Basic structural check: must contain a site block and a reverse_proxy
    # directive. The {$DOMAIN} placeholder should be present.
    local site_block=0 reverse_proxy=0 domain_var=0 brace_balance=0
    grep -q '{[[:space:]]*$' "$CADDYFILE" && site_block=1
    grep -q 'reverse_proxy' "$CADDYFILE" && reverse_proxy=1
    grep -q '{\$DOMAIN}' "$CADDYFILE" && domain_var=1
    open=$(grep -o '{' "$CADDYFILE" | wc -l)
    close=$(grep -o '}' "$CADDYFILE" | wc -l)
    [[ "$open" -eq "$close" ]] && brace_balance=1

    if [[ $site_block -eq 1 && $reverse_proxy -eq 1 \
       && $domain_var -eq 1 && $brace_balance -eq 1 ]]; then
      pass "Caddyfile basic structure OK (caddy not available for full validation)"
    else
      fail "Caddyfile basic structure check failed"
      [[ $site_block -eq 0 ]]    && echo "  - missing site block (line ending with '{')" >&2
      [[ $reverse_proxy -eq 0 ]] && echo "  - missing reverse_proxy directive" >&2
      [[ $domain_var -eq 0 ]]    && echo "  - missing {\$DOMAIN} placeholder" >&2
      [[ $brace_balance -eq 0 ]] && echo "  - unbalanced braces ({ vs })" >&2
    fi
  fi
}

# --- Check: Dockerfile ------------------------------------------------------
check_dockerfile() {
  echo "== validate-docker: Dockerfile.server =="
  if [[ ! -f "$DOCKERFILE" ]]; then
    fail "Dockerfile not found: $DOCKERFILE"
    return
  fi

  if have hadolint; then
    if hadolint "$DOCKERFILE" >/dev/null 2>&1; then
      pass "hadolint accepted $DOCKERFILE"
    else
      fail "hadolint reported issues in $DOCKERFILE"
      hadolint "$DOCKERFILE" 2>&1 || true
    fi
  else
    # Basic structural check: must start with a FROM, have a CMD or ENTRYPOINT.
    local has_from=0 has_cmd=0 has_expose=0
    grep -qiE '^FROM ' "$DOCKERFILE" && has_from=1
    grep -qiE '^(CMD|ENTRYPOINT)' "$DOCKERFILE" && has_cmd=1
    grep -qiE '^EXPOSE ' "$DOCKERFILE" && has_expose=1

    if [[ $has_from -eq 1 && $has_cmd -eq 1 ]]; then
      pass "Dockerfile.server basic structure OK (hadolint not available for lint)"
      [[ $has_expose -eq 0 ]] && warn "Dockerfile.server has no EXPOSE directive"
    else
      fail "Dockerfile.server basic structure check failed"
      [[ $has_from -eq 0 ]] && echo "  - missing FROM instruction" >&2
      [[ $has_cmd -eq 0 ]]  && echo "  - missing CMD or ENTRYPOINT instruction" >&2
    fi
  fi
}

# --- Check: live stack ------------------------------------------------------
check_live() {
  echo "== validate-docker: live stack =="
  if ! have docker; then
    warn "docker not available — skipping live stack check"
    return
  fi

  if ! docker info >/dev/null 2>&1; then
    warn "docker daemon not running — skipping live stack check"
    return
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    fail "cannot run live check without .env.prod (copy .env.prod.example to .env.prod)"
    return
  fi

  # --env-file loads .env.prod for ${VAR} interpolation in the compose file.
  # Docker Compose only auto-loads .env (not .env.prod), so this is required
  # for POSTGRES_PASSWORD, JWT_SECRET, etc. to reach the containers.
  local compose_cmd=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  echo "  building and starting stack..."
  if ! "${compose_cmd[@]}" up -d --build >/dev/null 2>&1; then
    fail "docker compose up failed"
    "${compose_cmd[@]}" down --volumes >/dev/null 2>&1 || true
    return
  fi

  # Wait for the server health endpoint to respond.
  local healthy=0 waited=0 max_wait=60
  while [[ $waited -lt $max_wait ]]; do
    if curl -sf "http://localhost/health" >/dev/null 2>&1 \
       || curl -sf "http://localhost/api/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  if [[ $healthy -eq 1 ]]; then
    pass "live stack health check succeeded (waited ${waited}s)"
  else
    fail "live stack did not become healthy within ${max_wait}s"
    "${compose_cmd[@]}" logs --tail=50 server >&2 || true
  fi

  echo "  cleaning up..."
  "${compose_cmd[@]}" down --volumes >/dev/null 2>&1 || true
}

# --- Run selected checks ----------------------------------------------------
if [[ $RUN_CONFIG -eq 1 ]]; then     check_config;     fi
if [[ $RUN_ENV -eq 1 ]]; then        check_env;        fi
if [[ $RUN_CADDY -eq 1 ]]; then      check_caddy;      fi
if [[ $RUN_DOCKERFILE -eq 1 ]]; then check_dockerfile; fi
if [[ $RUN_LIVE -eq 1 ]]; then       check_live;       fi

# --- Summary ----------------------------------------------------------------
echo
if [[ $FAILURES -eq 0 ]]; then
  echo "validate-docker: all checks passed."
  exit 0
else
  echo "validate-docker: $FAILURES check(s) failed." >&2
  exit 1
fi
