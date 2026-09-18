#!/usr/bin/env bash
# check-ruling.sh — mode guardrail.
#
# Exits 1 while .devin/PENDING-RULING.md contains open (- [ ]) items:
# the session is in DISCUSSION MODE and no code edits may proceed.
# Ambiguous imperatives ("proceed", "go", "continue") mean continue the
# ruling, not implement. Run before any code edit.
set -euo pipefail

RULING_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.devin/PENDING-RULING.md"

if [[ -s "$RULING_FILE" ]] && grep -q "^- \[ \]" "$RULING_FILE"; then
  echo "[BLOCKED] Open ruling — unanswered questions exist:"
  grep "^- \[ \]" "$RULING_FILE" | sed 's/^/  /' | head -12
  echo ""
  echo "DISCUSSION MODE: 'proceed'/'go'/'continue' mean continue the ruling."
  echo "No code edits until items are answered or the user names a task explicitly."
  exit 1
fi

echo "[OK] No open ruling items — task mode."
