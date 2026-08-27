# Architecture V2: Firmware-Persistent Anti-Theft System

> Synthesized from four primary sources:
> - *Beyond BIOS* (Zimmer, Rothman, Marisetty, 2017) — UEFI architecture and development
> - *Rootkits and Bootkits* (Matrosov, Rodionov, Bratus, 2019) — boot process security and threat model
> - *The Rootkit Arsenal* (Blunden, 2012) — persistence, evasion, self-healing architecture
> - *MDM: Fundamentals, Security, and the Modern Desktop* (Moskowitz, 2019) — device management protocols
>
> This document defines the target architecture for the redefined system.

---

## Design Goals

1. **No loopholes** — a cunning, intelligent employee cannot remove the agent by any software means
2. **Covert until ready** — agent stays dormant/silent, device remains usable, location reported silently
3. **Survives OS reinstalls** — firmware-level persistence re-injects the agent after disk wipe
4. **Central command** — DigitalOcean serverless API as the single control point for all devices
5. **Real-time tracking** — location pings picked up immediately when device comes online
6. **Law enforcement handoff** — evidence export (location history, firmware forensics, tamper logs)

---

## System Architecture (5 Layers)

```
┌─────────────────────────────────────────────────────────┐
│                    LAYER 5: DASHBOARD                      │
│            DigitalOcean Spaces + CDN                       │
│   Device fleet • Real-time map • Lockdown controls        │
│   Audit log • Evidence export • Tamper alerts              │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS API
┌────────────────────────▼────────────────────────────────┐
│              LAYER 4: SERVER (Serverless)                  │
│         DigitalOcean App Platform / Functions              │
│   Check-in API • Command queue • Location store            │
│   Key vault • Theft detection • Law enforcement export     │
│   DO Managed PostgreSQL                                     │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS polling (every 30s)
┌────────────────────────▼────────────────────────────────┐
│              LAYER 3: OS AGENT (Windows)                   │
│         Python service + C kernel watchdog                  │
│   Covert tracking • File encryption • Lock screen          │
│   BitLocker PBA • BCD/UEFI lockdown • Deadman switch      │
│   HMAC-signed HTTP • TPM-bound keys • Self-healing         │
└────────────────────────┬────────────────────────────────┘
                         │ UEFI variables (NVRAM)
┌────────────────────────▼────────────────────────────────┐
│           LAYER 2: BOOT-START DRIVER (Windows)             │
│         Signed kernel-mode driver (SERVICE_BOOT_START)     │
│   Watchdog: verifies OS agent running, restarts if killed  │
│   Re-creates service if deleted • Re-downloads agent       │
└────────────────────────┬────────────────────────────────┘
                         │ DXE phase callback
┌────────────────────────▼────────────────────────────────┐
│           LAYER 1: FIRMWARE MODULE (UEFI)                  │
│         Signed DXE runtime driver in SPI flash             │
│   Runs before OS • HTTP check-in via EFI_HTTP_PROTOCOL     │
│   Scans disk for agent, reinstalls if missing              │
│   State in UEFI variables (survives OS reinstalls)         │
│   Self-healing: re-injects all layers on every boot        │
└─────────────────────────────────────────────────────────┘
```

---

## Layer 1: Firmware Module (UEFI DXE Runtime Driver)

### What it is

A signed UEFI DXE runtime driver embedded in the SPI flash firmware volume. This is the persistence foundation — it survives OS reinstalls, disk formatting, and disk replacement. This is the same architecture used by Computrace/Absolute (600+ million deployed devices).

### Source knowledge

| Capability | Source book | Chapter/Section |
|---|---|---|
| DXE driver model, loading, protocols | Beyond BIOS | Ch 3 (Driver Model), Ch 4 (Protocols) |
| UEFI runtime services (persist into OS) | Beyond BIOS | Ch 5 (Runtime Environment) |
| UEFI variables (NVRAM persistence) | Beyond BIOS | Ch 5 (Variable Services) |
| Embedding in SPI flash via FDF | Beyond BIOS | Ch 7 (Platform Init) |
| EFI_HTTP_PROTOCOL (network from firmware) | Beyond BIOS | Ch 4 (Protocols) |
| EFI_DISK_IO_PROTOCOL (raw disk access) | Beyond BIOS | Ch 4 (Protocols) |
| Computrace firmware persistence model | Rootkit Arsenal | Ch 15 (Going Out-of-Band) |
| UEFI bootkit injection techniques | Rootkits & Bootkits | Ch 15 (Contemporary UEFI Bootkits) |
| Secure Boot signing chain | Rootkits & Bootkits | Ch 17 (How Secure Boot Works) |
| Firmware forensics for law enforcement | Rootkits & Bootkits | Ch 19 (BIOS/UEFI Forensics) |

### How it works

**Boot-time execution:**
1. System powers on → SEC phase → PEI phase → **DXE phase**
2. DXE dispatcher discovers our driver in the firmware volume
3. Our driver registers an `EFI_EVENT_GROUP_READY_TO_BOOT` callback
4. Callback fires right before OS loader — our last chance to act pre-OS

**Pre-OS actions (on every boot):**
1. Read agent state from UEFI variable (`AgentState` in NVRAM)
2. If agent is activated: scan disk via `EFI_DISK_IO_PROTOCOL` for OS agent binary
3. If OS agent missing: re-inject from firmware-embedded copy or download via `EFI_HTTP_PROTOCOL`
4. Write boot status to UEFI variable (`LastBootTime`, `AgentHealth`)
5. If device is flagged stolen: attempt HTTP check-in from firmware (reports location before OS boots)

**Communication with OS agent:**
- Firmware writes state to UEFI variables (`NON_VOLATILE | RUNTIME_ACCESS | BOOTSERVICE_ACCESS`)
- OS agent reads/writes same variables at runtime via Windows API (`GetFirmwareEnvironmentVariable`)
- This is a bidirectional channel that survives OS reinstalls

### Deployment method

**Capsule update** (field deployment, no OEM partnership needed):
1. Build UEFI driver with EDK II, sign with EV certificate
2. Package as UEFI capsule (`AntiTheftCapsule.efi`)
3. Place capsule in ESP: `/EFI/UpdateCapsule/`
4. OS triggers firmware update on next reboot
5. Firmware processes capsule, embeds driver in SPI flash

**Signing requirements:**
- EV code signing certificate (~$300-500/year)
- Microsoft Hardware Dev Center registration
- Cross-sign with Microsoft's UEFI driver signing CA
- Enroll certificate in Secure Boot `db` database

### What survives

| Event | Firmware module |
|---|---|
| OS reinstall | Survives (lives in SPI flash, not disk) |
| Disk format | Survives |
| Disk replacement | Survives |
| Windows reset/refresh | Survives |
| Agent uninstall | Survives (re-injects agent on next boot) |
| Firmware update | Survives (unless explicitly removed by signed update) |
| BIOS flash with clean image | **This is the one attack** — countered by BIOS password + SPI write protection |

---

## Layer 2: Boot-Start Kernel Driver (Windows)

### What it is

A signed kernel-mode driver registered with `SERVICE_BOOT_START` (start type 0x00). This loads during the boot loader phase, before the Windows kernel — the earliest possible OS-level loading point.

### Source knowledge

| Capability | Source book | Chapter/Section |
|---|---|---|
| SCM service installation, start types | Rootkit Arsenal | Ch 6 (Life in Kernel Space) |
| Boot-start driver loading sequence | Rootkit Arsenal | Ch 4 (System Briefing) |
| KMD template, IRP communication | Rootkit Arsenal | Ch 6 (KMD template) |
| Kernel-mode code signing (KMCS) | Rootkit Arsenal | Ch 6 (KMCS) |
| PatchGuard constraints | Rootkit Arsenal | Ch 6 (KPP/PatchGuard) |

### How it works

1. `winload.exe` scans `HKLM\SYSTEM\CurrentControlSet\Services\` for boot-start drivers
2. Our driver loads before `ntoskrnl.exe` initializes
3. Driver registers a callback for when the OS agent service should be running
4. On each check (every 60s via timer DPC):
   - Query SCM for OS agent service status
   - If service stopped → start it
   - If service deleted → re-create it from embedded copy
   - If agent binary deleted → re-download from server (via WSK kernel networking)
5. Report health status to firmware via UEFI variable

### What it does NOT do

Per the Rootkit Arsenal's guidance on stability (Ch 16):
- No SSDT hooking (triggers PatchGuard on 64-bit)
- No DKOM/EPROCESS manipulation (version-specific offsets, BSOD risk)
- No IDT/GDT modification (triggers PatchGuard)
- Uses supported APIs and registered callbacks only

### Signing

- Requires Software Publishing Certificate (SPC) for kernel-mode signing
- Must be in Windows Hardware Compatibility Center (WHCK/HLK certified) for boot-start
- This is the same signing barrier that protects us — a thief can't replace our driver without our cert

---

## Layer 3: OS Agent (Windows Service)

### What it is

The primary functional agent — a Windows service with `SERVICE_AUTO_START` running as SYSTEM. This is the evolution of the current Python agent (`agent.py`) with enhanced persistence and stealth.

### Source knowledge

| Capability | Source book | Chapter/Section |
|---|---|---|
| Covert tracking mode (silent location) | Existing codebase | agent.py lines 6-18, 1870-1876 |
| Deadman switch (offline auto-lockdown) | Existing codebase | agent.py lines 1937-1992 |
| File encryption (Fernet) | Existing codebase | agent.py lines 377-441 |
| Lock screen + guardian thread | Existing codebase | agent.py lines 596-648 |
| BCD lockdown | Existing codebase | bcd_lockdown.py |
| HP UEFI lockdown | Existing codebase | hp_uefi_lockdown.py |
| BitLocker PBA | Existing codebase | bitlocker_pba.py |
| HMAC-signed HTTP polling | Existing codebase + MDM book | agent.py + Ch 1 (OMA-DM) |
| Adaptive polling | Existing codebase + MDM book | agent.py lines 2291-2293 |
| Deceptive service naming | Rootkit Arsenal | Ch 15 (Computrace: "RPC Net") |
| Self-healing/reinforcement | Rootkit Arsenal | Ch 16 (Self-healing rootkits) |
| Memory locking (VirtualLock) | Rootkit Arsenal | Ch 9 (Defeating Live Response) |
| TPM-bound key storage | MDM book | Ch 10 (BitLocker, TPM) |

### Service configuration

```
Service name:    SystemTelemetryService
Display name:    Windows System Telemetry
Description:     Collects system performance metrics for diagnostics
Start type:      SERVICE_AUTO_START (0x02)
Account:         LocalSystem
Recovery:        Restart on failure (1st: 30s, 2nd: 60s, 3rd+: 300s)
```

Per the Rootkit Arsenal Ch 15 (Computrace model): the service name should be innocuous and blend in with existing Windows services. "System Telemetry" is believable — Windows already has multiple telemetry-related services.

### Operating modes (unchanged from current system)

| Mode | Behavior | Stealth |
|---|---|---|
| `active` | Normal check-in, no visible action, poll every 300s | Invisible |
| `track` | Covert location reporting, device fully usable, poll every 30s | Invisible |
| `lockdown` | Encrypt folder, lock screen, boot lockdown, poll every 60s | Visible (stolen banner) |
| `recover` | Decrypt folder, remove lock screen, restore boot, poll every 30s | Visible during recovery |

### Enhanced persistence (new — from Rootkit Arsenal Ch 16)

The OS agent implements self-healing with redundant persistence points:

1. **Primary: Windows service** (SCM-registered, AUTO_START)
2. **Backup 1: Registry Run key** — `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
   - Launches a repair utility that re-creates the service if deleted
3. **Backup 2: Scheduled task** — runs every 30 minutes
   - Checks service status, restarts if stopped, re-creates if deleted
4. **Backup 3: Boot-start driver** (Layer 2) — kernel watchdog
5. **Ultimate fallback: Firmware module** (Layer 1) — re-injects everything after OS reinstall

If any one persistence point is removed, the others detect and repair it within minutes.

### Communication (from Rootkit Arsenal Ch 14 + MDM book)

**Primary channel:** HTTPS to DigitalOcean API
- Legitimate-looking domain (e.g., `telemetry.yourdomain.com`)
- HMAC-signed JSON payloads (current system's approach, confirmed by MDM book)
- Agent initiates connection (connect-back) — no listening port needed

**Fallback channel:** DNS tunneling
- If HTTPS is blocked by firewall, fall back to DNS queries on port 53
- Data encoded in DNS query subdomains
- Almost all firewalls allow DNS — this is the most robust fallback
- Implemented in user-mode (simpler than WSK kernel-mode per Rootkit Arsenal Ch 14)

### TPM integration (from MDM book Ch 10)

- Agent's API key stored in TPM (not on disk — can't be extracted)
- Device identity bound to TPM hardware
- BitLocker recovery keys stored in TPM-protected context
- TPM attestation proves the agent is running on the real hardware (not a VM)

---

## Layer 4: Server (DigitalOcean Serverless)

### What it is

The central command and control point — a serverless API on DigitalOcean that all devices ping, report location to, and receive commands from.

### Architecture

```
DigitalOcean App Platform (serverless container)
├── API endpoints
│   ├── POST /api/agent/checkin      — device check-in, returns pending commands
│   ├── POST /api/agent/ack          — command acknowledgment
│   ├── POST /api/agent/location     — location report
│   ├── POST /api/agent/deadman      — deadman key upload
│   ├── GET  /api/agent/firmware     — firmware module download (for re-injection)
│   ├── GET  /api/agent/agent        — OS agent binary download (for self-healing)
│   ├── POST /api/auth/login         — admin JWT login
│   ├── CRUD /api/devices/*          — device management
│   ├── POST /api/devices/:id/flag   — flag stolen (queues lockdown command)
│   ├── POST /api/devices/:id/recover— recover device (queues unlock command)
│   ├── GET  /api/devices/:id/location — location history
│   ├── GET  /api/audit/*            — audit log
│   └── GET  /api/evidence/:id       — law enforcement evidence export
│
├── DO Managed PostgreSQL
│   ├── devices (id, hostname, status, api_key_hash, hardware_uuid, ...)
│   ├── commands (id, device_id, type, status, payload, created_at, ...)
│   ├── locations (id, device_id, lat, lon, source, accuracy, timestamp, ...)
│   ├── encryption_keys (id, device_id, key_material, created_at, ...)
│   ├── bios_passwords (id, device_id, password, type, created_at, ...)
│   ├── audit_log (id, device_id, action, actor, timestamp, details, ...)
│   └── admins (id, username, password_hash, role, ...)
│
├── DO Functions (event-driven)
│   ├── Theft alert handler — when device flagged → push command → notify law enforcement
│   ├── Stale device checker — scheduled every 60s (replaces alertScheduler.js)
│   └── Evidence generator — assembles location + firmware + tamper data for LE handoff
│
└── DO Spaces (object storage)
    ├── Agent binaries (for self-healing re-download)
    ├── Firmware capsules (for capsule update deployment)
    └── Evidence exports (PDF/CSV for law enforcement)
```

### Why DigitalOcean (not AWS/GCP)

Per the serverless research:
- Simpler than AWS (no API Gateway + Lambda + Cognito + 6 services)
- Cheaper than Azure (no $49/month API Management fixed cost)
- App Platform is a serverless container — scales to zero, auto-scales, no VM management
- Managed PostgreSQL built in
- Spaces + CDN for dashboard hosting
- All under your domain, single provider

### The alert scheduler problem (solved)

The current `alertScheduler.js` runs a 60s `setInterval` loop — incompatible with serverless. Per the Beyond BIOS and Rootkits research, this maps to:

- **DO Functions with scheduled triggers** — DigitalOcean Functions support cron-based scheduling
- Runs every 60 seconds, checks for stale devices, queues alerts
- Stateless — each invocation is independent
- No long-running process needed

### Real-time tracking

When a device in `track` mode checks in:
1. Agent POSTs location to `/api/agent/location`
2. Server stores in `locations` table
3. Server pushes update to dashboard via Server-Sent Events (SSE) or polling
4. Dashboard updates map in real-time

When a device comes online after being offline:
1. Agent drains offline location queue (already implemented in current system)
2. Server receives batch of historical locations
3. Dashboard shows full movement history

---

## Layer 5: Dashboard (DO Spaces + CDN)

### What it is

The React admin UI, served as static files from DigitalOcean Spaces + CDN. No server process needed for static hosting.

### Changes from current system

| Current | Redesigned |
|---|---|
| Express serves dashboard + API from one origin | Dashboard on CDN, API on App Platform (separate origins) |
| CORS disabled (same-origin) | CORS enabled for CDN origin |
| No real-time updates | SSE or polling for live location updates |
| Basic device list | Fleet management with groups, tags, geofences |
| Manual evidence export | One-click law enforcement evidence package |
| No tamper alerts | Real-time alerts when agent is removed/tampered |

### New dashboard features

1. **Real-time location map** — live tracking of stolen devices
2. **Tamper alerts** — notification when agent reports removal attempt
3. **Firmware status** — per-device view of firmware module health, Secure Boot status, PKFail vulnerability check
4. **Evidence export** — generates PDF with location history, firmware forensics data, tamper logs, chain of custody documentation
5. **Geofencing** — define safe zones, auto-flag when device leaves zone
6. **Command queue view** — see pending commands per device, retry failed commands
7. **Fleet health** — overview of all devices, agent status, last check-in, firmware version

---

## Threat Model: Thief Removal Attempts vs Defenses

| Thief's action | Layer 1 (Firmware) | Layer 2 (Boot driver) | Layer 3 (OS Agent) | Result |
|---|---|---|---|---|
| Kill process in Task Manager | — | Detects, restarts | Service auto-restart | Agent back in 30s |
| Disable service in services.msc | — | Detects, re-enables | Scheduled task re-enables | Agent back in 30min max |
| Delete service via sc.exe | — | Re-creates from embedded copy | Registry Run key re-creates | Agent back on next boot |
| Delete agent executable | — | Re-downloads from server | Copy in ADS/hidden dir | Agent back immediately |
| Boot into Safe Mode | — | Boot-start driver still loads | Service may be disabled | Driver re-enables service |
| Boot from USB/Live Linux | Firmware runs first | — | — | Firmware re-injects on next Windows boot |
| Reinstall Windows | Firmware detects, re-injects | — | — | Agent back on first boot |
| Format hard drive | Firmware re-downloads agent | — | — | Agent back on first boot |
| Replace hard drive | Firmware re-downloads agent | — | — | Agent back on first boot |
| Flash BIOS with clean image | **BIOS password blocks** | — | — | Blocked (unless password cracked) |
| Network firewall blocks HTTPS | Firmware uses HTTP | — | DNS tunneling fallback | Agent still phones home |
| Anti-virus scan | Signed binary, no hooks | Signed driver | Standard APIs, no suspicious behavior | Not flagged |
| Process Explorer / cross-view | — | — | Legitimate service name | Blends in |
| Registry audit | — | — | Standard service registration | Blends in |
| System Restore / DISM | Firmware re-injects | Re-creates | Multiple persistence points | Agent back on next boot |
| Group Policy restrictions | — | Runs as SYSTEM | Runs as SYSTEM | Not affected by user GPO |
| Virtualization/sandbox | — | — | TPM attestation detects VM | Agent flags sandbox attempt |

**Only successful attack:** Physical SPI flash with hardware programmer + BIOS password crack. This requires:
1. Physical possession of the motherboard
2. Hardware SPI programmer (specialized tool)
3. BIOS password (if set) or password crack
4. Knowledge of what to look for

At this point the device is physically disassembled, which is itself evidence of theft.

---

## Implementation Roadmap

### Phase 1: Server Migration to DigitalOcean (2-3 weeks)
- Migrate Express API to DO App Platform
- Migrate PostgreSQL to DO Managed Database
- Move dashboard to DO Spaces + CDN
- Replace alertScheduler.js with DO Functions scheduled trigger
- Deploy under your domain with TLS

### Phase 2: OS Agent Hardening (3-4 weeks)
- Add redundant persistence points (Run key, scheduled task)
- Add self-healing logic (agent re-downloads itself if deleted)
- Add DNS tunneling fallback communication
- Add TPM-bound key storage
- Add deceptive service naming
- Add memory locking (VirtualLock)
- Add tamper detection and reporting

### Phase 3: Boot-Start Kernel Driver (4-6 weeks)
- Develop signed kernel-mode watchdog driver
- Obtain kernel-mode code signing certificate
- WHCK/HLK certification for boot-start driver
- Implement service monitoring and re-creation logic
- Implement WSK kernel networking for agent re-download

### Phase 4: UEFI Firmware Module (8-12 weeks)
- Develop DXE runtime driver with EDK II
- Obtain EV code signing certificate
- Microsoft Hardware Dev Center registration
- Implement disk scanning and agent re-injection
- Implement EFI_HTTP_PROTOCOL check-in
- Implement UEFI variable state management
- Package as UEFI capsule for field deployment
- Test on target hardware (HP, Dell, Lenovo)

### Phase 5: Dashboard Enhancement (2-3 weeks)
- Real-time location map with SSE
- Tamper alert system
- Firmware status monitoring
- Evidence export for law enforcement
- Geofencing
- Fleet health dashboard

### Phase 6: Security Hardening & Testing (2-3 weeks)
- Penetration testing (simulate thief removal attempts)
- Firmware forensics validation
- Law enforcement evidence package validation
- Stability testing across Windows versions
- Secure Boot compatibility testing

---

## What We Keep vs What We Build New

### Keep from existing system (proven, tested, 753 tests passing)
- File encryption (Fernet) — agent.py `encrypt_folder()`
- Lock screen + guardian thread — agent.py `apply_lock_screen()`
- BCD lockdown — bcd_lockdown.py
- HP UEFI lockdown — hp_uefi_lockdown.py
- BitLocker PBA — bitlocker_pba.py
- Deadman switch — agent.py `check_deadman()`
- Covert tracking mode — agent.py `handle_track()`
- HMAC-signed HTTP polling — agent.py `checkin()`
- Adaptive polling — agent.py lines 2291-2293
- Offline location queue — agent.py `drain_offline_queue()`
- Pending ACK crash recovery — agent.py `write_pending_ack()`
- RSA-wrapped recovery keys — agent.py `write_recovery_key()`
- Command queue + ACK dedup — server routes
- JWT admin auth — server routes
- Audit log — server routes

### Build new
- UEFI DXE runtime driver (Layer 1) — firmware persistence
- Boot-start kernel watchdog driver (Layer 2) — OS-level persistence reinforcement
- Redundant OS persistence points (Run key, scheduled task) — Layer 3 hardening
- DNS tunneling fallback — communication resilience
- TPM-bound key storage — key extraction resistance
- Self-healing agent re-download — binary deletion resilience
- DO App Platform deployment — serverless hosting
- DO Functions scheduled trigger — replaces alertScheduler.js
- DO Spaces + CDN dashboard hosting — static serving
- Real-time dashboard updates (SSE) — live tracking
- Evidence export system — law enforcement handoff
- Tamper alert system — removal attempt detection
- Geofencing — location-based policies
- Firmware capsule packaging — field deployment mechanism

---

## Source Reference Index

| Architecture decision | Primary source | Chapter/Section |
|---|---|---|
| Firmware persistence (DXE driver in SPI flash) | Beyond BIOS | Ch 3, 5, 7 |
| Computrace hybrid model (firmware + OS agent) | Rootkit Arsenal | Ch 15 |
| UEFI HTTP check-in from firmware | Beyond BIOS | Ch 4 (EFI_HTTP_PROTOCOL) |
| UEFI variable state persistence | Beyond BIOS | Ch 5 (Variable Services) |
| Secure Boot signing chain | Rootkits & Bootkits | Ch 17 |
| Boot-start driver loading | Rootkit Arsenal | Ch 4, 6 |
| SCM service persistence | Rootkit Arsenal | Ch 6 |
| Self-healing redundant persistence | Rootkit Arsenal | Ch 16 |
| Deceptive service naming | Rootkit Arsenal | Ch 15 (Computrace) |
| DNS tunneling fallback | Rootkit Arsenal | Ch 14 |
| Memory locking (VirtualLock) | Rootkit Arsenal | Ch 9 |
| TPM-bound key storage | MDM book | Ch 10 |
| Adaptive polling pattern | MDM book | Ch 1 (confirmed existing impl) |
| HMAC message authentication | MDM book | Ch 1 (confirmed existing impl) |
| Firmware forensics for law enforcement | Rootkits & Bootkits | Ch 19 |
| UEFI bootkit threat model | Rootkits & Bootkits | Ch 14, 15, 16 |
| SMM/Intel ME vulnerabilities | Rootkits & Bootkits | Ch 16 |
| PKFail vulnerability check | Rootkits & Bootkits | Ch 17 |
| PatchGuard constraints (no SSDT/DKOM) | Rootkit Arsenal | Ch 6 |
| Stability best practices | Rootkit Arsenal | Ch 16 |
| Gradual enhancement approach | Rootkit Arsenal | Ch 16 |
