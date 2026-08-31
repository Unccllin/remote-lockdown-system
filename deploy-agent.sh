#!/bin/bash
# deploy-agent.sh — Deploy the lockdown agent to the local Windows machine
#
# Downloads the installer from the Cloudflare Worker and runs it.
# The installer (lockdown-setup.exe) is a GUI wizard that:
#   1. Auto-elevates to admin (UAC prompt)
#   2. Collects enrollment token (paste from dashboard)
#   3. Enrolls the device, installs the agent, starts the service
#   4. Installs the scheduled task watchdog (auto-restart every 5 min + on boot)
#
# Usage:
#   ./deploy-agent.sh                # Download and run the installer GUI
#   ./deploy-agent.sh --silent       # Non-interactive (needs enrollment token)
#   ./deploy-agent.sh --token <TOK>  # Non-interactive with enrollment token
#
# Prerequisites:
#   - The admin must generate an enrollment token in the dashboard first
#   - Windows with internet access

set -euo pipefail

WORKER_BASE="https://lockdown-serverless.mainacollins196.workers.dev"
WIN_TEMP="/mnt/c/Users/CLLIN/Downloads"

# Colors
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m[INFO]\033[0m %s\n' "$*"; }

# --- Parse args ---
ENROLL_TOKEN=""
SILENT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) ENROLL_TOKEN="$2"; SILENT=1; shift 2 ;;
    --silent) SILENT=1; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# --- Step 1: Download the installer from the Worker ---
info "Downloading lockdown-setup.exe from Cloudflare Worker..."
INSTALLER="$WIN_TEMP/lockdown-setup.exe"
curl -s -L "$WORKER_BASE/api/download/installer" -o "$INSTALLER"
if [ ! -f "$INSTALLER" ] || [ "$(stat -c%s "$INSTALLER" 2>/dev/null || echo 0)" -lt 1000000 ]; then
  red "ERROR: Download failed or file too small"
  exit 1
fi
green "Downloaded: $(du -h "$INSTALLER" | cut -f1) -> $INSTALLER"

# --- Step 2: Download the agent binary (the installer needs it) ---
info "Downloading lockdown-agent.exe from Cloudflare Worker..."
AGENT="$WIN_TEMP/lockdown-agent.exe"
curl -s -L "$WORKER_BASE/api/download/agent" -o "$AGENT"
if [ ! -f "$AGENT" ] || [ "$(stat -c%s "$AGENT" 2>/dev/null || echo 0)" -lt 1000000 ]; then
  red "ERROR: Download failed or file too small"
  exit 1
fi
green "Downloaded: $(du -h "$AGENT" | cut -f1) -> $AGENT"

# --- Step 2b: Download the lock screen overlay ---
info "Downloading lockdown-lockscreen.exe from Cloudflare Worker..."
LOCKSCREEN="$WIN_TEMP/lockdown-lockscreen.exe"
curl -s -L "$WORKER_BASE/api/download/lockscreen" -o "$LOCKSCREEN"
if [ ! -f "$LOCKSCREEN" ] || [ "$(stat -c%s "$LOCKSCREEN" 2>/dev/null || echo 0)" -lt 1000000 ]; then
  yellow "WARNING: Lock screen overlay download failed — lockdown will fall back to LockWorkStation"
else
  green "Downloaded: $(du -h "$LOCKSCREEN" | cut -f1) -> $LOCKSCREEN"
fi

# --- Step 3: Launch the installer ---
if [ "$SILENT" -eq 1 ] && [ -n "$ENROLL_TOKEN" ]; then
  info "Running installer with enrollment token (non-interactive)..."
  # The installer GUI accepts token via command-line or we can pre-enroll
  # For now, just launch it — the user pastes the token in the GUI
  WIN_INSTALLER=$(wslpath -w "$INSTALLER")
  powershell.exe -NoProfile -Command "Start-Process '$WIN_INSTALLER' -Verb RunAs" 2>&1
else
  info "Launching installer GUI (will prompt for UAC elevation)..."
  echo ""
  yellow "============================================"
  yellow "  INSTRUCTIONS:"
  yellow "============================================"
  echo ""
  echo "  1. The installer GUI will appear (UAC prompt first)"
  echo "  2. Paste your enrollment token from the dashboard"
  echo "  3. Click Install — the agent will be:"
  echo "     - Enrolled with the Worker"
  echo "     - Installed to C:\\ProgramData\\LockdownAgent"
  echo "     - Set up as a scheduled task (auto-restart + boot persistence)"
  echo "     - Added to Defender exclusions"
  echo ""
  echo "  To generate an enrollment token:"
  echo "    - Open the dashboard -> Enroll Device page"
  echo "    - Click 'Generate Token'"
  echo "    - Copy the token (valid for 15 minutes)"
  echo ""
  WIN_INSTALLER=$(wslpath -w "$INSTALLER")
  powershell.exe -NoProfile -Command "Start-Process '$WIN_INSTALLER' -Verb RunAs" 2>&1
fi

green "Installer launched. Check your Windows desktop for the setup wizard."
