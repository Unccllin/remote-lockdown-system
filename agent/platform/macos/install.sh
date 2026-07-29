#!/bin/bash
# install.sh — macOS installer for the Remote Lockdown Agent
#
# Installs the agent as a LaunchDaemon (runs as root, starts at boot).
# Supports both the PyInstaller binary (dist/lockdown-agent) and the
# Python source (agent.py run via python3).
#
# Usage:
#   sudo ./install.sh
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
PLIST_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${PLIST_NAME}"
PLIST_DEST="/Library/LaunchDaemons/${PLIST_NAME}"

# Script directory (where this installer lives — platform/macos)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Agent source tree root (parent of platform/macos)
AGENT_SRC_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[install] $*"; }
err()  { echo "[install][ERROR] $*" >&2; }
ok()   { echo "[install][OK] $*"; }

# ---------------------------------------------------------------------------
# Require root
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    err "This installer must be run as root (use sudo)."
    exit 1
fi

# ---------------------------------------------------------------------------
# Detect agent binary vs Python script
# ---------------------------------------------------------------------------
BINARY_PATH=""
RUN_VIA_PYTHON=0

if [[ -f "${AGENT_SRC_DIR}/dist/lockdown-agent" ]]; then
    BINARY_PATH="${AGENT_SRC_DIR}/dist/lockdown-agent"
    log "Found PyInstaller binary: ${BINARY_PATH}"
elif [[ -f "${SCRIPT_DIR}/lockdown-agent" ]]; then
    BINARY_PATH="${SCRIPT_DIR}/lockdown-agent"
    log "Found standalone binary: ${BINARY_PATH}"
elif [[ -f "${AGENT_SRC_DIR}/agent.py" ]]; then
    RUN_VIA_PYTHON=1
    log "No binary found — will run agent.py via python3."
    if [[ ! -x /usr/bin/python3 && ! -x /usr/local/bin/python3 ]]; then
        err "python3 is required when running from source but was not found."
        exit 1
    fi
else
    err "Could not find agent binary or agent.py under ${AGENT_SRC_DIR}."
    err "Build the binary first (./build.sh) or run from the agent source tree."
    exit 1
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------
log "Creating directories..."
install -d -m 0755 "${INSTALL_DIR}"
install -d -m 0755 "${CONFIG_DIR}"
install -d -m 0755 "${STATE_DIR}"
install -d -m 0755 "${LOG_DIR}"

# ---------------------------------------------------------------------------
# Copy agent to install directory
# ---------------------------------------------------------------------------
if [[ ${RUN_VIA_PYTHON} -eq 1 ]]; then
    log "Copying Python source to ${INSTALL_DIR}..."
    cp -f "${AGENT_SRC_DIR}/agent.py" "${INSTALL_DIR}/agent.py"
    for mod in bcd_lockdown.py hp_uefi_lockdown.py offline_recovery.py watchdog.py; do
        if [[ -f "${AGENT_SRC_DIR}/${mod}" ]]; then
            cp -f "${AGENT_SRC_DIR}/${mod}" "${INSTALL_DIR}/${mod}"
        fi
    done
    if [[ -f "${AGENT_SRC_DIR}/requirements.txt" ]]; then
        cp -f "${AGENT_SRC_DIR}/requirements.txt" "${INSTALL_DIR}/requirements.txt"
    fi
    chmod 0755 "${INSTALL_DIR}/agent.py"
else
    log "Copying binary to ${INSTALL_DIR}/lockdown-agent..."
    cp -f "${BINARY_PATH}" "${INSTALL_DIR}/lockdown-agent"
    chmod 0755 "${INSTALL_DIR}/lockdown-agent"
fi

# ---------------------------------------------------------------------------
# Config file
# ---------------------------------------------------------------------------
log "Setting up configuration..."
if [[ -f "${AGENT_SRC_DIR}/config.ini.example" ]]; then
    if [[ ! -f "${CONFIG_DIR}/config.ini" ]]; then
        cp -f "${AGENT_SRC_DIR}/config.ini.example" "${CONFIG_DIR}/config.ini"
        log "Copied config template to ${CONFIG_DIR}/config.ini"
    else
        log "Existing ${CONFIG_DIR}/config.ini preserved."
    fi
fi

# Prompt for required values (written into the plist EnvironmentVariables)
prompt() {
    local prompt_text="$1"
    local default_val="${2:-}"
    local var
    if [[ -n "${default_val}" ]]; then
        read -r -p "${prompt_text} [${default_val}]: " var
        echo "${var:-${default_val}}"
    else
        read -r -p "${prompt_text}: " var
        echo "${var}"
    fi
}

SERVER_URL="$(prompt "Server URL (e.g. https://lockdown.example.com)" "")"
AGENT_KEY="$(prompt "Agent / device API key" "")"
HOSTNAME="$(prompt "Device hostname" "$(hostname)")"

if [[ -z "${SERVER_URL}" || -z "${AGENT_KEY}" ]]; then
    err "server_url and agent_key are required."
    exit 1
fi

# ---------------------------------------------------------------------------
# Install plist (patch ProgramArguments if running via python3)
# ---------------------------------------------------------------------------
log "Installing LaunchDaemon plist to ${PLIST_DEST}..."
if [[ ${RUN_VIA_PYTHON} -eq 1 ]]; then
    # Rewrite ProgramArguments to invoke python3 agent.py
    /usr/bin/sed -e "s|/usr/local/libexec/lockdown-agent/lockdown-agent|/usr/bin/env python3 ${INSTALL_DIR}/agent.py|" \
        "${PLIST_SRC}" > "${PLIST_DEST}"
else
    cp -f "${PLIST_SRC}" "${PLIST_DEST}"
fi

# Patch the EnvironmentVariables values in the installed plist
/usr/bin/sed -i '' \
    -e "s|<string>https://lockdown.example.com</string>|<string>${SERVER_URL}</string>|" \
    -e "s|<string>change_this_to_match_server_AGENT_SHARED_KEY</string>|<string>${AGENT_KEY}</string>|" \
    -e "s|<string>DEVICE-HOSTNAME-001</string>|<string>${HOSTNAME}</string>|" \
    "${PLIST_DEST}"

# LaunchDaemon plists must be root:wheel and 0644
chown root:wheel "${PLIST_DEST}"
chmod 0644 "${PLIST_DEST}"

# Validate plist
if ! plutil -lint "${PLIST_DEST}" >/dev/null 2>&1; then
    err "Installed plist failed validation (plutil -lint). Aborting."
    plutil -lint "${PLIST_DEST}"
    exit 1
fi

# ---------------------------------------------------------------------------
# Load and start the daemon
# ---------------------------------------------------------------------------
log "Loading LaunchDaemon..."
# Unload first if already loaded (idempotent re-install)
launchctl unload "${PLIST_DEST}" 2>/dev/null || true
launchctl load -w "${PLIST_DEST}"

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
sleep 2
if launchctl list | grep -q "com.lockdown.agent"; then
    ok "LaunchDaemon 'com.lockdown.agent' is loaded."
    echo ""
    echo "  Status:   sudo launchctl list | grep lockdown"
    echo "  Logs:     ${LOG_DIR}/agent.log  and  agent_error.log"
    echo "  Config:   ${CONFIG_DIR}/config.ini  (plist env vars override)"
    echo "  Uninstall: sudo ${SCRIPT_DIR}/uninstall.sh"
else
    err "LaunchDaemon did not load cleanly. Check:"
    err "  sudo launchctl list | grep lockdown"
    err "  ${LOG_DIR}/agent_error.log"
    exit 1
fi
