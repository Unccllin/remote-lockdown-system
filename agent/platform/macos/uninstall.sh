#!/bin/bash
# uninstall.sh — macOS uninstaller for the Remote Lockdown Agent
#
# Unloads the LaunchDaemon, then removes the plist, agent binary/source,
# and configuration. State and log directories are preserved by default
# (pass --purge to remove them too).
#
# Usage:
#   sudo ./uninstall.sh [--purge]
#
# Must be run as root.

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
INSTALL_DIR="/usr/local/libexec/lockdown-agent"
CONFIG_DIR="/etc/lockdown-agent"
STATE_DIR="/var/lib/lockdown-agent"
LOG_DIR="/var/log/lockdown-agent"
PLIST_NAME="com.lockdown.agent.plist"
PLIST_DEST="/Library/LaunchDaemons/${PLIST_NAME}"
LABEL="com.lockdown.agent"

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
# Unload the daemon
# ---------------------------------------------------------------------------
if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
    log "Unloading LaunchDaemon ${LABEL}..."
    launchctl unload -w "${PLIST_DEST}" 2>/dev/null || true
else
    log "LaunchDaemon ${LABEL} is not loaded — skipping unload."
fi

# ---------------------------------------------------------------------------
# Remove plist
# ---------------------------------------------------------------------------
if [[ -f "${PLIST_DEST}" ]]; then
    log "Removing plist ${PLIST_DEST}..."
    rm -f "${PLIST_DEST}"
else
    log "Plist not present — skipping."
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
