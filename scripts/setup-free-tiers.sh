#!/usr/bin/env bash
#
# setup-free-tiers.sh — walks you through setting up the two free-tier
# services that complete the production stack:
#
#   1. Grafana Cloud Free — centralized logging (Loki) + monitoring (Prometheus)
#      Free tier: 10k metrics, 50GB logs, 14-day retention, 3 users
#
#   2. AWS Systems Manager Parameter Store — secrets management
#      Free tier: 10,000 standard parameters, standard throughput
#
# Run: bash scripts/setup-free-tiers.sh
#
# The wizard opens each URL, tells you exactly what to click and copy, and
# writes the captured values to .env.prod. It's idempotent — re-run it any
# time and it preserves values already saved.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

TOTAL_STAGES=0
_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env.prod}"
WRITTEN_ENV=()
WRITTEN_SECRET=()
SKIPPED=()

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=10

banner "Free-tier production setup (Grafana Cloud + AWS Parameter Store)"

# ── Stage 1: Grafana Cloud — Create account ───────────────────────────────
stage "Grafana Cloud — Create free account"
say "Grafana Cloud Free gives you hosted Loki (logs), Prometheus (metrics),"
say "and Grafana (dashboards) at no cost. No credit card required."
say ""
open_url "https://grafana.com/signup/cloud"
step "Fill in the signup form (email, password, organization name)."
step "Choose a cloud provider region (any is fine — pick the closest to you)."
step "Click 'Create free account' and verify your email if prompted."
pause "Once you're logged into your Grafana Cloud dashboard, press Enter."

# ── Stage 2: Grafana Cloud — Get Loki credentials ─────────────────────────
stage "Grafana Cloud — Get Loki credentials (for log shipping)"
say "We need 3 values from Grafana Cloud to ship logs to Loki:"
say "  1. The Loki push URL"
say "  2. Your instance ID (username)"
say "  3. An API key (password)"
say ""
open_url "https://grafana.com"
step "Click 'Sign in' → log into your Grafana Cloud instance."
step "In the left sidebar, click 'Connections' → 'Data sources'."
step "Find 'Loki' in the list and click it."
step "Copy the URL field — this is your Loki push URL."
note "It looks like: https://logs-prod-us-central1.grafana.net/loki/api/v1/push"
ask LOKI_URL "Paste the Loki URL:"
step "Scroll down to 'Authentication' — copy the 'User' value (a number like 12345)."
ask LOKI_USERNAME "Paste the Loki username (instance ID):"
step "Now create an API key: go to 'My Account' → 'API Keys' → 'Add API key'."
step "Name it 'lockdown-promtail', select 'Viewer' role (sufficient for pushing logs)."
step "Copy the generated key (starts with 'glc_')."
ask_secret LOKI_API_KEY "Paste the Grafana Cloud API key:"
write_env LOKI_URL "$LOKI_URL"
write_env LOKI_USERNAME "$LOKI_USERNAME"
write_env LOKI_API_KEY "$LOKI_API_KEY"
say ""
say "Log shipping is now configured. To enable it, start the stack with:"
note "  docker compose --env-file .env.prod -f docker-compose.prod.yml --profile logging up -d"
pause "Press Enter to continue to metrics setup."

# ── Stage 3: Grafana Cloud — Configure Prometheus scrape ─────────────────
stage "Grafana Cloud — Configure metrics scraping"
say "Grafana Cloud's hosted Prometheus can scrape your server's /metrics"
say "endpoint directly. Your server must be publicly accessible (behind Caddy"
say "with HTTPS — which the prod stack sets up automatically)."
say ""
step "Note your server's public URL (the DOMAIN from .env.prod)."
ask DOMAIN "Enter your server's public domain (e.g., lockdown.example.com):"
step "In Grafana Cloud, go to 'Connections' → 'Data sources' → 'Prometheus'."
step "Scroll to 'Prometheus endpoints' or go to 'My Account' → 'Prometheus'."
step "Click 'Add scrape target'."
step "Enter the URL: https://$DOMAIN/metrics"
step "Set the scrape interval to 15s."
step "Click 'Save & Test'. Grafana Cloud will verify it can reach your server."
say ""
say "Note: your server must be running and accessible for the test to pass."
say "If it's not running yet, you can add the scrape target later."
pause "Press Enter to continue."

# ── Stage 4: Grafana Cloud — Import dashboard ────────────────────────────
stage "Grafana Cloud — Import the lockdown dashboard"
say "A pre-built dashboard is included in the repo. Let's import it."
say ""
open_url "https://grafana.com"
step "Log into your Grafana Cloud instance."
step "In the left sidebar, click 'Dashboards'."
step "Click 'New' → 'Import' → 'Upload dashboard JSON file'."
step "Upload this file from the repo:"
note "  monitoring/grafana/dashboards/lockdown-overview.json"
step "Select 'Prometheus' as the data source."
step "Click 'Import'. You should see the lockdown dashboard with 6 panels."
pause "Once the dashboard is imported, press Enter to continue."

# ── Stage 5: AWS — Create account / sign in ───────────────────────────────
stage "AWS — Sign in or create account"
say "AWS Systems Manager Parameter Store (Standard tier) is free: 10,000"
say "parameters at no cost. We'll store your production secrets there."
say ""
open_url "https://console.aws.amazon.com"
step "If you have an AWS account, sign in."
step "If not, click 'Create a new AWS account' and follow the steps."
note "AWS requires a credit card for identity verification, but Parameter"
note "Store Standard tier is free — you won't be charged for 10,000 parameters."
pause "Once you're logged into the AWS Console, press Enter."

# ── Stage 6: AWS — Create IAM user ────────────────────────────────────────
stage "AWS — Create IAM user for Parameter Store access"
say "We'll create a dedicated IAM user with read-only access to Parameter Store."
say "This user's credentials will let the server fetch secrets at startup."
say ""
open_url "https://console.aws.amazon.com/iam/home#/users"
step "Click 'Create user'."
step "User name: lockdown-server"
step "Select 'Attach policies directly'."
step "Search for and check 'AmazonSSMReadOnlyAccess'."
note "This policy allows reading Parameter Store values — nothing else."
step "Click 'Next' → 'Create user'."
pause "Once the user is created, press Enter."

# ── Stage 7: AWS — Get access keys ────────────────────────────────────────
stage "AWS — Get access keys"
say "Now we'll create access keys for the lockdown-server user."
say ""
step "Click on the 'lockdown-server' user you just created."
step "Go to the 'Security credentials' tab."
step "Scroll to 'Access keys' → click 'Create access key'."
step "Select 'Application running outside AWS' → click Next."
step "Click 'Create access key'."
step "Copy the 'Access key ID' (starts with 'AKIA...')."
ask_secret AWS_ACCESS_KEY_ID "Paste the AWS access key ID:"
step "Copy the 'Secret access key' (shown only once — save it now!)."
ask_secret AWS_SECRET_ACCESS_KEY "Paste the AWS secret access key:"
step "Choose a region (e.g., us-east-1). This must match where you'll create parameters."
ask AWS_REGION "Enter the AWS region (default: us-east-1):"
write_env AWS_ACCESS_KEY_ID "$AWS_ACCESS_KEY_ID"
write_env AWS_SECRET_ACCESS_KEY "$AWS_SECRET_ACCESS_KEY"
write_env AWS_REGION "$AWS_REGION"
pause "Press Enter to continue to parameter creation."

# ── Stage 8: AWS — Create parameters in Parameter Store ───────────────────
stage "AWS — Create parameters in Parameter Store"
say "Now we'll create a parameter for each production secret. The server"
say "fetches all parameters under the /lockdown/prod/ prefix at startup."
say ""
say "You need to create a SecureString parameter for each of these:"
note "  /lockdown/prod/JWT_SECRET"
note "  /lockdown/prod/AGENT_SHARED_KEY"
note "  /lockdown/prod/AGENT_KEY_PEPPER"
note "  /lockdown/prod/FIELD_ENCRYPTION_KEY"
note "  /lockdown/prod/LOCATION_FIELD_KEY"
note "  /lockdown/prod/BACKUP_ENCRYPT_KEY"
note "  /lockdown/prod/POSTGRES_PASSWORD"
note "  /lockdown/prod/GRAFANA_ADMIN_PASSWORD"
say ""
say "You can create them in the AWS Console, or I can generate the AWS CLI"
say "commands for you to run (if you have the AWS CLI installed)."
say ""
if confirm "Do you have the AWS CLI installed and configured?"; then
  step "Great! I'll generate the commands for you."
  say ""
  say "Run these commands (replace the placeholder values with your actual secrets):"
  say ""
  for param in JWT_SECRET AGENT_SHARED_KEY AGENT_KEY_PEPPER FIELD_ENCRYPTION_KEY LOCATION_FIELD_KEY BACKUP_ENCRYPT_KEY POSTGRES_PASSWORD GRAFANA_ADMIN_PASSWORD; do
    printf '  %saws ssm put-parameter \\\n' "$DIM"
    printf '    --name "/lockdown/prod/%s" \\\n' "$param"
    printf '    --value "REPLACE_WITH_YOUR_%s" \\\n' "$param"
    printf '    --type SecureString \\\n' "$RESET"
    printf '    --region %s\n\n' "${AWS_REGION:-us-east-1}"
  done
  note "After running these commands, your secrets are stored in AWS Parameter Store."
else
  step "No problem — create them manually in the AWS Console."
  say ""
  open_url "https://console.aws.amazon.com/systems-manager/parameters/"
  step "Click 'Create parameter'."
  step "Name: /lockdown/prod/JWT_SECRET"
  step "Tier: Standard (free)"
  step "Type: SecureString"
  step "Value: paste your JWT_SECRET (generate with: openssl rand -hex 32)"
  step "Click 'Create parameter'."
  step "Repeat for each secret listed above."
  note "Generate strong values with: openssl rand -hex 32"
  note "For POSTGRES_PASSWORD, use a strong password (not a hex string)."
fi
pause "Once all 8 parameters are created, press Enter to continue."

# ── Stage 9: Enable SSM in .env.prod ──────────────────────────────────────
stage "Enable AWS SSM in .env.prod"
say "Now we'll enable SSM in your .env.prod so the server knows to fetch"
say "secrets from AWS instead of the .env file."
say ""
write_env AWS_SSM_ENABLED "true"
write_env AWS_SSM_PREFIX "/lockdown/prod/"
note "When AWS_SSM_ENABLED=true, the server fetches secrets from Parameter"
note "Store at startup. Values in .env.prod still take precedence — you can"
note "keep some secrets in .env.prod and others in SSM."
pause "Press Enter to continue."

# ── Stage 10: Summary + verification ──────────────────────────────────────
stage "Summary — verify your setup"
say "Your free-tier production setup is complete! Here's what was configured:"
say ""
printf '  %sGrafana Cloud Free%s\n' "$BOLD" "$RESET"
note "  • Loki (logs): $LOKI_URL"
note "  • Prometheus: scrape https://$DOMAIN/metrics (configured in Grafana UI)"
note "  • Dashboard: imported from monitoring/grafana/dashboards/lockdown-overview.json"
note "  • Enable with: --profile logging"
say ""
printf '  %sAWS Parameter Store%s\n' "$BOLD" "$RESET"
note "  • Region: ${AWS_REGION:-us-east-1}"
note "  • Prefix: /lockdown/prod/"
note "  • 8 SecureString parameters created"
note "  • Server fetches secrets at startup when AWS_SSM_ENABLED=true"
say ""
printf '  %sTo start the full stack with logging:%s\n' "$BOLD" "$RESET"
note "  docker compose --env-file .env.prod -f docker-compose.prod.yml \\"
note "    --profile monitoring --profile logging up -d --build"
say ""
printf '  %sTo verify SSM is working:%s\n' "$BOLD" "$RESET"
note "  docker compose --env-file .env.prod -f docker-compose.prod.yml logs server | grep ssm"
note "  You should see: '[ssm] Secrets loaded from AWS Parameter Store'"
say ""
printf '  %sTo verify Loki is receiving logs:%s\n' "$BOLD" "$RESET"
note "  In Grafana Cloud → Explore → Loki, run: {service=\"server\"}"
say ""
if confirm "Would you like to test the AWS SSM connection now?"; then
  step "Testing SSM connection..."
  if command -v aws >/dev/null 2>&1; then
    if aws ssm get-parameters-by-path \
        --path "/lockdown/prod/" \
        --region "${AWS_REGION:-us-east-1}" \
        --with-decryption \
        --query 'Parameters[].Name' \
        --output text 2>/dev/null; then
      printf '  %s✓ SSM connection successful%s\n' "$GREEN" "$RESET"
    else
      warn "SSM connection failed — check your AWS credentials and region."
      note "Make sure your access key has AmazonSSMReadOnlyAccess policy."
    fi
  else
    warn "AWS CLI not installed — skipping live test."
    note "Install with: pip install awscli  or  brew install awscli"
    note "Then test: aws ssm get-parameters-by-path --path /lockdown/prod/ --region ${AWS_REGION:-us-east-1}"
  fi
fi
pause "Press Enter to finish."

finish
