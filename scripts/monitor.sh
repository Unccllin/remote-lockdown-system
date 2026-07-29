#!/usr/bin/env bash
#
# monitor.sh — CLI health monitoring for the remote-lockdown-system server.
#
# Checks /health (liveness) and /health/ready (readiness) on a loop and
# reports status to stdout. On failure, optionally POSTs an alert to a
# webhook and exits non-zero (suitable for cron / systemd timer integration).
#
# Usage:
#   scripts/monitor.sh --url http://localhost:3001 --interval 60 --alert-webhook https://hooks.example.com/alert
#   scripts/monitor.sh --once --url http://localhost:3001
#
# Options:
#   --url <server-url>      Server to monitor (default: http://localhost:3001)
#   --interval <seconds>    Check interval in seconds (default: 60)
#   --alert-webhook <url>   Webhook to POST alerts to on failure
#   --once                  Run a single check instead of looping
#   -h, --help              Show this help message

set -euo pipefail

URL="http://localhost:3001"
INTERVAL=60
ALERT_WEBHOOK=""
ONCE=0

usage() {
  sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      URL="$2"; shift 2 ;;
    --interval)
      INTERVAL="$2"; shift 2 ;;
    --alert-webhook)
      ALERT_WEBHOOK="$2"; shift 2 ;;
    --once)
      ONCE=1; shift ;;
    -h|--help)
      usage ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2 ;;
  esac
done

# Send an alert to the configured webhook (if any).
# $1 = JSON payload (string)
send_alert() {
  if [[ -n "$ALERT_WEBHOOK" ]]; then
    curl -fsS -m 10 -X POST "$ALERT_WEBHOOK" \
      -H 'Content-Type: application/json' \
      -d "$1" >/dev/null 2>&1 || true
  fi
}

# Run a single health check cycle.
# Returns 0 on success, non-zero on failure.
check_once() {
  local ts liveness_code readiness_code readiness_body

  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # 1. Liveness probe — is the process up?
  liveness_code="$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "${URL}/api/health" 2>/dev/null || echo "000")"

  if [[ "$liveness_code" != "200" ]]; then
    echo "[$ts] FAIL  liveness  ${URL}/api/health -> HTTP ${liveness_code}"
    send_alert "{\"event\":\"health_check_failed\",\"probe\":\"liveness\",\"url\":\"${URL}\",\"http_code\":\"${liveness_code}\",\"timestamp\":\"${ts}\"}"
    return 1
  fi

  # 2. Readiness probe — can the server handle requests (DB connected)?
  readiness_body="$(curl -fsS -m 5 "${URL}/api/health/ready" 2>/dev/null || echo '')"
  readiness_code="$(curl -fsS -m 5 -o /dev/null -w '%{http_code}' "${URL}/api/health/ready" 2>/dev/null || echo "000")"

  if [[ "$readiness_code" != "200" ]]; then
    echo "[$ts] FAIL  readiness ${URL}/api/health/ready -> HTTP ${readiness_code}"
    send_alert "{\"event\":\"health_check_failed\",\"probe\":\"readiness\",\"url\":\"${URL}\",\"http_code\":\"${readiness_code}\",\"body\":\"${readiness_body}\",\"timestamp\":\"${ts}\"}"
    return 1
  fi

  echo "[$ts] OK    liveness=200 readiness=200 ${URL}"
  return 0
}

# --- Main loop ---

if [[ "$ONCE" -eq 1 ]]; then
  check_once
  exit $?
fi

echo "Monitoring ${URL} every ${INTERVAL}s$( [[ -n "$ALERT_WEBHOOK" ]] && echo " (alerts -> ${ALERT_WEBHOOK})" )"
echo "Press Ctrl+C to stop."

while true; do
  if ! check_once; then
    # On failure in loop mode, exit non-zero so a cron/systemd wrapper
    # can surface the alert. (Loop mode continues only when healthy.)
    exit 1
  fi
  sleep "$INTERVAL"
done
