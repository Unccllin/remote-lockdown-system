#!/usr/bin/env bash
# seed-prod-devices.sh — Enroll N devices via the admin API for load testing.
#
# Usage: ./scripts/seed-prod-devices.sh [--count N] [--url URL] [--admin USER] [--pass PASS]
set -euo pipefail

COUNT=200
URL="https://localhost"
ADMIN_USER="admin"
ADMIN_PASS="TestPass123!"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --admin) ADMIN_USER="$2"; shift 2 ;;
    --pass) ADMIN_PASS="$2"; shift 2 ;;
    *) echo "Unknown: $1" >&2; exit 2 ;;
  esac
done

echo "Logging in as $ADMIN_USER..."
TOKEN=$(curl -sk -X POST "$URL/api/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d.toString()).token))")

if [[ -z "$TOKEN" || "$TOKEN" == "undefined" ]]; then
  echo "ERROR: login failed" >&2
  exit 1
fi
echo "Got token."

echo "Enrolling $COUNT devices..."
ENROLLED=0
for i in $(seq 1 "$COUNT"); do
  idx=$(printf "%05d" "$i")
  # Use -o /dev/null to suppress response body, -s for silent
  HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$URL/api/devices" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"hostname\":\"load-test-device-$idx\",\"owner_name\":\"Load Test\"}")
  if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
    # 409 = already exists (idempotent re-run)
    ENROLLED=$((ENROLLED + 1))
  else
    echo "  Failed at device $idx: HTTP $HTTP_CODE" >&2
  fi
  if (( i % 50 == 0 )); then echo "  ... $i / $COUNT"; fi
done
echo "Enrolled $ENROLLED devices."

# Verify
DEVICE_COUNT=$(curl -sk "$URL/api/devices" -H "Authorization: Bearer $TOKEN" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d.toString()).length))")
echo "Verification: $DEVICE_COUNT devices in the database."
