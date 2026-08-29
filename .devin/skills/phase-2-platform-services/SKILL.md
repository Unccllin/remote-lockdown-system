---
name: phase-2-platform-services
description: Platform service installers for Windows (NSSM), Linux (systemd), and macOS (launchd)
---

# Phase 2 — Platform Service Installers

## Context

The agent runs as a background service on managed devices across three platforms:
- **Windows**: NSSM-based service installation
- **Linux**: systemd service
- **macOS**: launchd daemon

## Current State

### Windows (existing + enhanced)
- `agent/install_service.ps1` — installs agent as Windows service via NSSM
- `agent/install_watchdog_service.ps1` — installs watchdog service
- `agent/uninstall_service.ps1` — removes service
- `agent/platform/windows/install-service-enhanced.ps1` — enhanced installer
  - Auto-downloads NSSM if not found at `bin/nssm.exe`
  - Sets service recovery options (restart on failure, 3 attempts)
  - Configures log rotation
  - Better error handling and colored output
  - Creates SafeBoot registry entries (D-015 CLOSED)
- NSSM binary expected at `agent/bin/nssm.exe` (not bundled)
- Service name: "LockdownAgent"

### Linux (implemented)
- `agent/platform/linux/lockdown-agent.service` — systemd unit file
  - Service type: `simple`, User: `root`, Restart: `always` with `RestartSec=10`
  - Hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp=yes`
  - `ReadWritePaths=/var/lib/lockdown-agent /home` (agent needs filesystem access)
  - Dependencies: `After=network-online.target`, `Wants=network-online.target`
- `agent/platform/linux/install.sh` — installs agent as systemd service
  - Detects root, detects binary vs Python script, copies to `/opt/lockdown-agent/`
  - Creates config at `/etc/lockdown-agent/`, installs systemd unit, enables service
- `agent/platform/linux/uninstall.sh` — stops service, removes files

### macOS (implemented)
- `agent/platform/macos/com.lockdown.agent.plist` — LaunchDaemon plist
  - Label: `com.lockdown.agent`, RunAtLoad: true, KeepAlive: true
  - StandardOutPath/StandardErrorPath to `/var/log/lockdown-agent/`
  - Installed at `/Library/LaunchDaemons/` (runs as root)
- `agent/platform/macos/install.sh` — installs LaunchDaemon
  - Detects root, copies binary to `/usr/local/libexec/lockdown-agent/`
  - Creates config, installs plist, `launchctl load -w`
- `agent/platform/macos/uninstall.sh` — unloads and removes

### Cross-Platform Paths
- Agent binary: Linux `/opt/lockdown-agent/`, macOS `/usr/local/libexec/lockdown-agent/`, Windows `C:\Program Files\LockdownAgent\`
- Config: Linux/macOS `/etc/lockdown-agent/config.ini`, Windows `C:\Program Files\LockdownAgent\config.ini`

## Verification

```bash
# Verify all platform files exist
ls agent/platform/linux/lockdown-agent.service agent/platform/linux/install.sh agent/platform/linux/uninstall.sh
ls agent/platform/macos/com.lockdown.agent.plist agent/platform/macos/install.sh agent/platform/macos/uninstall.sh
ls agent/platform/windows/install-service-enhanced.ps1

# Shell syntax check on install/uninstall scripts
bash -n agent/platform/linux/install.sh agent/platform/linux/uninstall.sh
bash -n agent/platform/macos/install.sh agent/platform/macos/uninstall.sh

# PowerShell syntax check (if pwsh available)
pwsh -NoProfile -Command "Get-Content agent/platform/windows/install-service-enhanced.ps1 | Out-Null" 2>/dev/null

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify Linux installer detects binary vs Python**: `grep -c "dist/lockdown-agent\|python3" agent/platform/linux/install.sh`
2. **Verify systemd hardening is moderate (ProtectSystem=strict + ReadWritePaths)**: `grep "ProtectSystem\|ReadWritePaths" agent/platform/linux/lockdown-agent.service`
3. **Verify macOS plist is LaunchDaemon (not LaunchAgent)**: `grep "LaunchDaemons" agent/platform/macos/install.sh`
4. **Verify installers handle config file creation**: `grep -c "config" agent/platform/linux/install.sh agent/platform/macos/install.sh`
5. **Verify uninstall scripts exist for all platforms**: `ls agent/platform/*/uninstall.sh agent/uninstall_service.ps1`

## Gotchas

- Agent needs root for lock screen and file encryption — Linux systemd uses `User=root`, macOS uses LaunchDaemon (not LaunchAgent)
- `ProtectSystem=strict` requires `ReadWritePaths` for the agent's data directory and LOCKDOWN_FOLDER — can't be fully locked down
- NSSM binary is NOT bundled — `install-service-enhanced.ps1` auto-downloads it if missing

## Graph Integration

**Phase node**: `P2` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P2` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SHELL-SYNTAX, V-ELECTRON-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: D-015 (CLOSED — SafeBoot registry entries added to install-service-enhanced.ps1)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
