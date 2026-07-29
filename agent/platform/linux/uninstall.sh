#!/bin/bash
# uninstall.sh — Linux uninstaller for the Remote Lockdown Agent
#
# Stops and disables the systemd service, then removes the unit file,
# agent binary/source, and configuration. State and log directories are
# preserved by default (pass --purge to remove them too).
#
# Usage:
#   sudo ./uninstall.sh [--purge]
#
# Must be run as root.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
INSTALL_DIR="/opt/lockdown-agent"
CONFIG_DIR="/etc/lockdown-agent"
STATE_DIR="/var/lib/lockdown-agent"
LOG_DIR="/var/log/lockdown-agent"
UNIT_NAME="lockdown-agent.service"
UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[uninstall] $*"; }
err()  { echo "[uninstall][ERROR] $*" >&2; }
ok()   { echo "[uninstall][OK] $*"; }

# ---------------------------------------------------------------------------
# Require root
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    err "This uninstaller must be run as root (use sudo)."
    exit 1
fi

# Parse args
PURGE=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        -h|--help)
            echo "Usage: sudo $0 [--purge]"
            echo "  --purge  Also remove state and log directories."
            exit 0
            ;;
        *) err "Unknown argument: $arg"; exit 1 ;;
    esac
done

# ---------------------------------------------------------------------------
# Stop and disable service
# ---------------------------------------------------------------------------
if systemctl list-unit-files | grep -q "${UNIT_NAME}"; then
    log "Stopping ${UNIT_NAME}..."
    systemctl stop lockdown-agent 2>/dev/null || true
    log "Disabling ${UNIT_NAME}..."
    systemctl disable lockdown-agent 2>/dev/null || true
else
    log "Service ${UNIT_NAME} is not installed — skipping stop/disable."
fi

# ---------------------------------------------------------------------------
# Remove systemd unit
# ---------------------------------------------------------------------------
if [[ -f "${UNIT_DEST}" ]]; then
    log "Removing unit file ${UNIT_DEST}..."
    rm -f "${UNIT_DEST}"
    systemctl daemon-reload
    systemctl reset-failed lockdown-agent 2>/dev/null || true
else
    log "Unit file not present — skipping."
fi

# ---------------------------------------------------------------------------
# Remove agent binary / source
# ---------------------------------------------------------------------------
if [[ -d "${INSTALL_DIR}" ]]; then
    log "Removing install directory ${INSTALL_DIR}..."
    rm -rf "${INSTALL_DIR}"
else
    log "Install directory not present — skipping."
fi

# ---------------------------------------------------------------------------
# Remove config
# ---------------------------------------------------------------------------
if [[ -d "${CONFIG_DIR}" ]]; then
    log "Removing config directory ${CONFIG_DIR}..."
    rm -rf "${CONFIG_DIR}"
else
    log "Config directory not present — skipping."
fi

# ---------------------------------------------------------------------------
# Optionally purge state and logs
# ---------------------------------------------------------------------------
if [[ ${PURGE} -eq 1 ]]; then
    log "--purge: removing state and log directories..."
    rm -rf "${STATE_DIR}" 2>/dev/null || true
    rm -rf "${LOG_DIR}" 2>/dev/null || true
else
    log "Preserving state (${STATE_DIR}) and logs (${LOG_DIR})."
    log "Use '$0 --purge' to remove them."
fi

ok "Lockdown Agent uninstalled."
