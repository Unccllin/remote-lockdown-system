#!/bin/bash
# install.sh — Linux installer for the Remote Lockdown Agent
#
# Installs the agent as a systemd service under /opt/lockdown-agent.
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
INSTALL_DIR="/opt/lockdown-agent"
CONFIG_DIR="/etc/lockdown-agent"
STATE_DIR="/var/lib/lockdown-agent"
LOG_DIR="/var/log/lockdown-agent"
UNIT_NAME="lockdown-agent.service"
UNIT_DEST="/etc/systemd/system/${UNIT_NAME}"
ENV_FILE="${CONFIG_DIR}/config.ini.env"
CONFIG_INI="${CONFIG_DIR}/config.ini"

# Script directory (where this installer lives — agent source tree root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Walk up to find the agent source directory (parent of platform/linux)
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

# Option 1: PyInstaller binary in dist/
if [[ -f "${AGENT_SRC_DIR}/dist/lockdown-agent" ]]; then
    BINARY_PATH="${AGENT_SRC_DIR}/dist/lockdown-agent"
    log "Found PyInstaller binary: ${BINARY_PATH}"
elif [[ -f "${SCRIPT_DIR}/lockdown-agent" ]]; then
    BINARY_PATH="${SCRIPT_DIR}/lockdown-agent"
    log "Found standalone binary: ${BINARY_PATH}"
elif [[ -f "${AGENT_SRC_DIR}/agent.py" ]]; then
    RUN_VIA_PYTHON=1
    log "No binary found — will run agent.py via python3."
    if ! command -v python3 >/dev/null 2>&1; then
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
    # Copy support modules referenced by agent.py if present
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

# Copy the INI template if present (for reference / manual editing)
if [[ -f "${AGENT_SRC_DIR}/config.ini.example" ]]; then
    if [[ ! -f "${CONFIG_INI}" ]]; then
        cp -f "${AGENT_SRC_DIR}/config.ini.example" "${CONFIG_INI}"
        log "Copied config template to ${CONFIG_INI}"
    else
        log "Existing ${CONFIG_INI} preserved."
    fi
fi

# Prompt for required values
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

# Write the systemd EnvironmentFile (KEY=value, no quotes around values)
# These map to the environment variables agent.py reads in load_config().
log "Writing environment file ${ENV_FILE}..."
cat > "${ENV_FILE}" <<EOF
# Managed by lockdown-agent install.sh — do not edit while service is running.
# These environment variables are read by agent.py load_config().
SERVER_URL=${SERVER_URL}
DEVICE_API_KEY=${AGENT_KEY}
DEVICE_HOSTNAME=${HOSTNAME}
POLL_INTERVAL=30
LOCKDOWN_FOLDER=/home/fieldagent/SecureData
LOCK_SENTINEL=${STATE_DIR}/.locked
PENDING_ACK_FILE=${STATE_DIR}/.pending_ack
RECOVERY_KEY_FILE=${STATE_DIR}/.recovery_key
EOF
chmod 0640 "${ENV_FILE}"
chown root:root "${ENV_FILE}"

# ---------------------------------------------------------------------------
# Install systemd unit
# ---------------------------------------------------------------------------
log "Installing systemd unit..."
# If running via python, patch ExecStart in the unit to use python3
if [[ ${RUN_VIA_PYTHON} -eq 1 ]]; then
    sed -e "s|^ExecStart=.*|ExecStart=/usr/bin/env python3 ${INSTALL_DIR}/agent.py|" \
        "${SCRIPT_DIR}/lockdown-agent.service" > "${UNIT_DEST}"
else
    cp -f "${SCRIPT_DIR}/lockdown-agent.service" "${UNIT_DEST}"
fi
chmod 0644 "${UNIT_DEST}"

# ---------------------------------------------------------------------------
# Enable and start
# ---------------------------------------------------------------------------
log "Reloading systemd daemon..."
systemctl daemon-reload

log "Enabling and starting ${UNIT_NAME}..."
systemctl enable --now lockdown-agent

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
sleep 2
if systemctl is-active --quiet lockdown-agent; then
    ok "Service 'lockdown-agent' is running."
    echo ""
    echo "  Status:   systemctl status lockdown-agent"
    echo "  Logs:     journalctl -u lockdown-agent -f"
    echo "  Config:   ${ENV_FILE}"
    echo "  Uninstall: sudo ${SCRIPT_DIR}/uninstall.sh"
else
    err "Service did not start cleanly. Check logs:"
    err "  journalctl -u lockdown-agent -n 50 --no-pager"
    systemctl status lockdown-agent --no-pager || true
    exit 1
fi
