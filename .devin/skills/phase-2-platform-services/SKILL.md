# Skill Domain: Phase 2 — Platform Service Installers

## Context

The agent runs as a background service on managed devices. Currently:
- **Windows**: `agent/install_service.ps1` exists (uses NSSM)
- **Linux**: No systemd unit — must be created manually
- **macOS**: No launchd plist — must be created manually

## Current State

### Windows (existing)
- `agent/install_service.ps1` — installs agent as Windows service via NSSM
- `agent/install_watchdog_service.ps1` — installs watchdog service
- `agent/uninstall_service.ps1` — removes service
- NSSM binary expected at `agent/bin/nssm.exe` (not bundled)
- Service name: "LockdownAgent"

### Linux (missing)
- Agent is a Python script that needs to run as a systemd service
- No systemd unit file exists
- No install/uninstall scripts
- Agent binary (from PyInstaller) would be at `agent/dist/lockdown-agent`

### macOS (missing)
- Agent needs to run as a launchd daemon (runs as root, starts at boot)
- No plist file exists
- No install/uninstall scripts

## Research Findings

### systemd Service Design
- Service type: `simple` (agent runs in foreground, not forking)
- User: `root` (needed for lock screen, file encryption)
- Restart policy: `always` with `RestartSec=10`
- ExecStart: path to agent binary or `python3 agent.py`
- WorkingDirectory: agent installation directory
- EnvironmentFile: path to agent's config.ini or .env
- Hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`
- BUT: agent needs filesystem access to LOCKDOWN_FOLDER, so can't be too restrictive
- Dependencies: `After=network-online.target`, `Wants=network-online.target`

### launchd plist Design
- Label: `com.lockdown.agent`
- ProgramArguments: path to agent binary
- RunAtLoad: true
- KeepAlive: true (restart on crash)
- StandardOutPath / StandardErrorPath: log files
- Must be installed at `/Library/LaunchDaemons/com.lockdown.agent.plist` (runs as root)
- Use `launchctl load` to install

### NSSM Enhancement (Windows)
- Current `install_service.ps1` works but could be enhanced:
  - Auto-download NSSM if not present
  - Better error messages
  - Service recovery options (restart on failure)
  - Log rotation configuration

### Cross-Platform Considerations
- Agent binary path differs by platform:
  - Linux: `/opt/lockdown-agent/lockdown-agent`
  - macOS: `/usr/local/libexec/lockdown-agent/lockdown-agent`
  - Windows: `C:\Program Files\LockdownAgent\lockdown-agent.exe`
- Config file path:
  - Linux: `/etc/lockdown-agent/config.ini`
  - macOS: `/etc/lockdown-agent/config.ini` or `/Library/Application Support/LockdownAgent/config.ini`
  - Windows: `C:\Program Files\LockdownAgent\config.ini`

## Reasoning Questions

1. **Should the Linux installer use the PyInstaller binary or run Python directly?**
   - Answer: Support both. Default to binary if `dist/lockdown-agent` exists, fall back to `python3 agent.py`. The installer detects which is available.

2. **Should systemd hardening directives be aggressive or minimal?**
   - Answer: Moderate. The agent needs network access (polling), filesystem access (LOCKDOWN_FOLDER), and process control (lock screen). Use `ProtectSystem=strict` but with `ReadWritePaths` for the agent's data directory and LOCKDOWN_FOLDER. `PrivateTmp=yes` is safe.

3. **Should the macOS plist be a LaunchDaemon or LaunchAgent?**
   - Answer: LaunchDaemon (runs as root, starts at boot). The agent needs root for lock screen and file encryption. LaunchAgents run as the user and only start at login.

4. **Should installers handle config file creation?**
   - Answer: Yes. The installer should create the config directory, copy `config.ini.example` to `config.ini`, and prompt for required values (server_url, agent_key, hostname).

5. **Should we provide uninstall scripts?**
   - Answer: Yes. Each platform gets an uninstall script that stops the service, removes service files, and optionally removes the agent binary and config.

## Implementation Guidelines

### agent/platform/linux/lockdown-agent.service
```ini
[Unit]
Description=Remote Lockdown Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/lockdown-agent/lockdown-agent
WorkingDirectory=/opt/lockdown-agent
EnvironmentFile=/etc/lockdown-agent/config.ini.env
Restart=always
RestartSec=10
User=root
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/lockdown-agent /home

[Install]
WantedBy=multi-user.target
```

### agent/platform/linux/install.sh
- Detect if running as root (fail if not)
- Detect agent binary vs Python script
- Copy binary to `/opt/lockdown-agent/`
- Create `/etc/lockdown-agent/` and copy config template
- Prompt for server_url, agent_key, hostname
- Install systemd unit to `/etc/systemd/system/`
- `systemctl daemon-reload && systemctl enable --now lockdown-agent`
- Verify service is running

### agent/platform/macos/com.lockdown.agent.plist
- Standard LaunchDaemon plist XML
- KeepAlive with successful exit retry
- StandardOutPath/StandardErrorPath to `/var/log/lockdown-agent/`

### agent/platform/macos/install.sh
- Detect if running as root
- Copy binary to `/usr/local/libexec/lockdown-agent/`
- Create config directory
- Install plist to `/Library/LaunchDaemons/`
- `launchctl load -w /Library/LaunchDaemons/com.lockdown.agent.plist`
- Verify service is running

### agent/platform/windows/install-service-enhanced.ps1
- Enhanced version of existing install_service.ps1
- Auto-download NSSM if not found at `bin/nssm.exe`
- Set service recovery options (restart on failure, 3 attempts)
- Configure log rotation
- Better error handling and colored output

## File Boundaries
- CREATE: `agent/platform/linux/lockdown-agent.service`, `agent/platform/linux/install.sh`, `agent/platform/linux/uninstall.sh`
- CREATE: `agent/platform/macos/com.lockdown.agent.plist`, `agent/platform/macos/install.sh`, `agent/platform/macos/uninstall.sh`
- CREATE: `agent/platform/windows/install-service-enhanced.ps1`
- DO NOT EDIT: `agent/install_service.ps1`, `agent/uninstall_service.ps1` (existing Windows scripts)
- DO NOT EDIT: `agent/agent.py` or any other Python source

## Graph Integration

**Phase node**: `P2` in `.devin/graph/GRAPH-SPEC.yaml`

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P2` node
2. Read `.devin/graph/trace.md` — check last session's context
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md`

**Verification nodes gating this phase**: V-SHELL-SYNTAX,V-ELECTRON-SYNTAX

**Enforcement paths touched by this phase**: —

**Debt items related to this phase**: —

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref

