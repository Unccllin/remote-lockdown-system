# Remote Lockdown System — Build Plan

> Synthesized from 7 parallel research agents covering: competitive landscape, desktop packaging, agent persistence, cloud deployment, security/legal, MDM architecture, and Node-vs-Python agent feasibility.

---

## 1. What the research found

### 1.1 The market today
- **Absolute Computrace** is the only solution with true firmware-level persistence — it's patented (US 8,418,226), requires OEM partnerships (Dell/HP/Lenovo), and behaves rootkit-like. **Not replicable in open source.**
- **Prey Project** is the closest open-source analog (GPLv3 agent, proprietary server). Cannot survive factory reset. Uses standard Windows service + heartbeat polling.
- **Apple Find My / Google Find My Device** use OS-level persistence + crowdsourced BLE networks. Free, but locked to their ecosystems.
- **Enterprise MDM** (Intune, Jamf, Workspace ONE) uses push+pull hybrid, certificate auth, command queues — but is expensive ($4-30/device/month) and complex.
- **Open-source MDMs** (Fleet, MicroMDM, NanoMDM, Headwind) exist but are fragmented and platform-specific.

### 1.2 Market gaps we can fill
1. **Self-hosted, privacy-first anti-theft** — no open-source solution matches Prey's capabilities with a self-hostable server.
2. **Single installable app** — no competitor offers a one-click desktop app bundling server + dashboard + agent enrollment.
3. **Transparent and ethical** — Absolute got sued for secret webcam capture; we can differentiate by being fully transparent.
4. **Cost-effective for small orgs** — commercial MDMs are $4-30/dev/month; we can be free (self-hosted) or ~$5/month (cloud).

### 1.3 Critical technical findings
| Topic | Finding | Decision |
|---|---|---|
| Desktop framework | Electron is the **only** framework that runs Node/Express in-process. Tauri/Wails can't. | **Use Electron** |
| Embedded DB | **PGlite is BROKEN in Electron 33/34** (WASM/V8 issues). `better-sqlite3` is the production choice. | **Migrate PGlite → better-sqlite3** |
| Agent language | Porting Python→Node is 4-6 weeks high-risk (1200+ lines of boot lockdown). Keeping Python is 1-2 weeks (PyInstaller + electron-builder extraResources). | **Keep Python agent** |
| Firmware persistence | Patented by Absolute, requires OEM partnerships, would brick devices if done wrong. | **Don't attempt. Use defense-in-depth software persistence.** |
| Agent auth | Shared key in binary is extractable. Per-device keys + HMAC + nonce + timestamp is the standard. | **Implement per-device HMAC auth** |
| Encryption | Fernet (AES-128-CBC) is weaker than AES-256-GCM. But Fernet is already deployed and cross-language compatible. | **Keep Fernet for v1, plan AES-256-GCM migration** |
| Cloud deploy | Cheapest: Hetzner CX23 €3.49/mo. Easiest: Railway $8-13/mo. Best balance: Railway. | **Support both Electron-local and cloud deploy** |
| Polling interval | 30s (current) is too aggressive. Industry standard: 5-15min normal, 30s when tracking. | **Adaptive polling** |
| Add/Remove Programs | Hiding from ARP is unethical and legally risky (Absolute/Computrace precedent). | **Show in ARP, document clearly** |

### 1.4 Legal/ethical requirements (must do before shipping)
- GDPR: legitimate interest assessment, data minimization, user rights (access/delete)
- US state laws: affirmative consent for location tracking (CA, IL, others)
- Disclosure: software must be visible in Add/Remove Programs
- CFAA risk: actions must be strictly limited to anti-theft, documented, authorized
- Ownership transfer: must support transferring/surrendering device ownership (sold-device scenario)

---

## 2. Architecture decision

### 2.1 The anti-theft constraint (revisited)
The core problem you identified: **if the server runs on the stolen machine, you can't lock it remotely.** Research confirms every viable anti-theft solution separates the server (on a machine you control) from the agent (on the device that might be stolen).

### 2.2 Solution: One app, two install modes

The unified app you wanted — but at first launch it asks **"Is this the admin machine, or a managed device?"** and installs the right components:

```
┌─────────────────────────────────────────────────────────────┐
│  Remote Lockdown App (one codebase, one installer)          │
│                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────┐  │
│  │  ADMIN MODE          │    │  AGENT MODE              │  │
│  │  (your machine/VPS)  │    │  (managed laptops)       │  │
│  │                      │    │                          │  │
│  │  • Electron window   │    │  • Python agent (silent) │  │
│  │  • Express server    │    │  • NSSM service          │  │
│  │  • better-sqlite3 DB │    │  • Watchdog              │  │
│  │  • React dashboard   │    │  • BCD/UEFI lockdown     │  │
│  │  • "Generate Agent   │    │  • No UI, no dashboard   │  │
│  │    Installer" button │    │  • Shows in ARP          │  │
│  └──────────┬───────────┘    └────────────▲─────────────┘  │
│             │                             │                │
│             │  Admin clicks "Generate     │                │
│             │  Agent Installer" → produces│                │
│             │  small agent-only .exe      │                │
│             └─────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

**Admin mode** runs on a machine you control (your PC, an office server, or a cloud VPS via the included `docker-compose.prod.yml`). It contains the server, dashboard, and DB. It has a button that generates a **small agent-only installer** pre-configured with your server URL + per-device enrollment token.

**Agent mode** is what gets installed on managed laptops. It's just the Python agent + NSSM service + watchdog + boot lockdown. No dashboard, no server. It phones home to your admin server over HTTPS.

This solves the anti-theft constraint: stolen laptops only ever have the agent. The server stays on a machine you control.

### 2.3 Communication architecture (from MDM research)

```
Admin Dashboard (React, in Electron window)
        │  Electron IPC (no HTTP port — avoids conflicts)
        ▼
  Express API (in Electron main process)
        │  Reads/writes
        ▼
  better-sqlite3 (in userData dir, encrypted)
        │
        ▲  HTTPS + HMAC-SHA256 + per-device key + nonce + timestamp
        │  Adaptive polling: 5min normal, 30sec when tracking
        │
  Python Agent (on managed laptops, NSSM service)
        │  Local SQLite queue for offline periods
        │  Watchdog process for crash recovery
        │  BCD/UEFI lockdown (HP WMI) for defense-in-depth
```

---

## 3. Build plan — phased

### Phase 0: Security hardening (before any packaging)
*The research flagged real vulnerabilities in the current implementation. Fix these first so we don't ship a broken system inside a shiny app.*

- [ ] **Per-device agent keys** — replace the single `AGENT_SHARED_KEY` with a unique key generated per device at enrollment, stored hashed in DB
- [ ] **HMAC request signing** — agent signs every request with `HMAC-SHA256(device_key, timestamp + nonce + body)`; server validates timestamp window (±5min) + nonce uniqueness + signature
- [ ] **Nonce replay cache** — server stores recent nonces (TTL 10min) in DB to reject replays
- [ ] **Rate limiting per device** — `express-rate-limit` keyed on device ID, not just IP
- [ ] **JWT hardening** — short-lived access tokens (15min) + httpOnly refresh token cookies (7d), explicit algorithm allowlist
- [ ] **Audit log integrity** — append-only with hash chain (each entry includes hash of previous)
- **Verification:** existing test suite passes + new auth tests

### Phase 1: Database migration (PGlite → better-sqlite3)
*Research found PGlite is broken in Electron 33/34. We must migrate before building the Electron shell.*

- [ ] Add `better-sqlite3` to server deps; create `src/db/betterSqlitePool.js` with same query interface as `pool.js`
- [ ] Port migrations to SQLite syntax (PG-specific features → SQLite equivalents: `JSONB`→`JSON`, `gen_random_uuid()`→`lower(hex(randomblob(16)))`, `TIMESTAMP`→`TEXT ISO8601`)
- [ ] Add SQLCipher (`better-sqlite3-multiple-ciphers`) for encryption-at-rest; key stored via Electron `safeStorage` (OS keychain)
- [ ] Update `dev-start.js` to use better-sqlite3 when `USE_SQLITE=true`
- [ ] Keep PGlite path for non-Electron dev (server-only mode)
- **Verification:** `npm run test:server` passes; manual lockdown→recover flow works on SQLite

### Phase 2: Electron shell (admin mode foundation)
- [ ] Create `desktop/` directory with Electron app (`main.js`, `preload.js`, `package.json`)
- [ ] `desktop/main.js`: on launch, set env, start Express in main process (reuse `server/dev-start.js` logic), open `BrowserWindow` loading `dashboard/dist/index.html`
- [ ] First-run secrets: generate `JWT_SECRET`, `AGENT_KEY_PEPPER`, admin password hash; store in `app.getPath('userData')/config.json` (encrypted via `safeStorage`)
- [ ] SQLite DB file in `userData/lockdown.db` (persists across app updates)
- [ ] Auto-pick free port for agent-facing HTTP (try 3001, fall back to `:0`); write chosen port to config
- [ ] Dashboard↔server via Electron IPC (no HTTP for in-app traffic); preload exposes `window.lockdownAPI.*`
- [ ] `dashboard/src/api/client.js`: detect Electron, use IPC if present, else HTTP (for browser dev)
- **Verification:** `npm run electron:dev` → window opens → dashboard loads → can register admin → can log in

### Phase 3: First-run UX + agent enrollment
- [ ] First-launch wizard: "Admin or Agent?" mode selector
- [ ] Admin mode first-run: create admin account (no default `admin/admin123` in production builds)
- [ ] "Generate Agent Installer" button in dashboard settings:
  - Generates a per-device enrollment token (one-time use, expires in 24h)
  - Invokes PyInstaller on the bundled agent spec with config pointing at this server's URL + token
  - Produces `LockdownAgent-<hostname>-setup.exe` in `userData/agent-installers/`
  - Admin downloads it, pushes to the target machine
- [ ] Agent mode: runs the agent-only installer, prompts for enrollment token, registers with server, installs as NSSM service
- **Verification:** fresh VM → install admin app → create admin → generate agent installer → install agent on another VM → device appears in dashboard → "Locate Now" works

### Phase 4: Bundle the Python agent
- [ ] PyInstaller spec (`agent/agent.spec`) — `--onefile`, include `hp_uefi_lockdown.py`, `bcd_lockdown.py`, `watchdog.py`, `offline_recovery.py`
- [ ] electron-builder `extraResources`: ship PyInstaller'd `agent.exe` + `nssm.exe` inside the admin app's `resources/`
- [ ] Admin app's "Generate Agent Installer" uses the bundled `agent.exe` as a template, injects config, wraps in NSIS installer
- [ ] Agent auto-update: watchdog checks server `/api/agent/update` on each checkin; if new version, download to temp, verify SHA-256, stop service, replace, restart
- **Verification:** built admin app contains `agent.exe`; generated agent installer is <30MB; agent installs as service and survives reboot

### Phase 5: Adaptive polling + offline queue
- [ ] Server sends `poll_interval` in checkin response (5min normal, 30sec when device status=stolen/tracking)
- [ ] Agent local SQLite queue: stores commands when offline, syncs on reconnect
- [ ] Command expiration: commands older than 30 days auto-expire (configurable)
- [ ] Command idempotency: client-generated `command_uuid`, server dedupes
- [ ] Server-side command queue status: `pending` → `acknowledged` / `failed` / `not_now` / `expired`
- **Verification:** agent offline for 1hr → comes back → receives queued lockdown command → executes → ACKs

### Phase 6: Packaging + installer
- [ ] `electron-builder` config in `desktop/package.json`:
  - Windows: NSIS `.exe` (primary), MSI (enterprise)
  - macOS: DMG (later)
  - Linux: AppImage (later)
- [ ] App icon, name "Remote Lockdown", version from root `package.json`
- [ ] Code signing: document process (Azure Trusted Signing for Windows ~$10/mo, Apple Developer $99/yr)
- [ ] Auto-update for the admin app via `electron-updater` + GitHub Releases
- [ ] `docker-compose.prod.yml` for cloud deploy (admin server + Caddy + Postgres) — for users who want cloud instead of desktop
- **Verification:** built installer → install on clean Windows VM → full lockdown→recover flow works end-to-end

### Phase 7: Legal + ethical hardening (before any public release)
- [ ] Privacy policy + terms of service (draft from Prey's as template)
- [ ] GDPR legitimate interest assessment document
- [ ] Agent visible in Add/Remove Programs (NSIS registers uninstaller)
- [ ] Agent installer shows EULA + discloses tracking capabilities
- [ ] Ownership transfer flow in dashboard (release device from account)
- [ ] Data retention settings (auto-delete location data after N days)
- [ ] In-app notification when device is marked stolen (if agent can show UI)
- **Verification:** legal review of docs; fresh install shows all disclosures

### Phase 8: Verification + docs
- [ ] Run full test suite (`npm test`) on all platforms
- [ ] End-to-end test: install admin → enroll agent → flag stolen → verify lockdown → recover → verify unlock
- [ ] `desktop/README.md` with build + sign instructions
- [ ] Update root `README.md` with "Install as App" quick start
- [ ] Threat model table in `docs/SECURITY.md`

---

## 4. What we're explicitly NOT doing (and why)

| Not doing | Reason |
|---|---|
| Firmware/UEFI persistence | Patented by Absolute, requires OEM partnerships, would brick devices. Not feasible for open source. |
| Porting agent to Node.js | 4-6 weeks high-risk vs 1-2 weeks to bundle Python. Boot lockdown (1200 lines) is the blocker. No clear benefit. |
| Using PGlite in Electron | Broken in Electron 33/34 (WASM/V8 incompatibility). better-sqlite3 is the production choice. |
| Hiding agent from Add/Remove Programs | Unethical, legally risky (Absolute/Computrace lawsuits), damages trust. |
| WebSocket for agent↔server | Overkill, proxy-unfriendly. Adaptive polling + optional long-polling is sufficient. |
| Multi-tenant in v1 | Adds complexity. Single-tenant first, schema designed with `tenant_id` for future. |
| Crowdsourced BLE tracking network | Requires massive network effect. Out of scope. |
| Migrating Fernet → AES-256-GCM in v1 | Fernet works, is cross-language compatible, already deployed. Plan for v2. |

---

## 5. Installer size budget

| Component | Size |
|---|---|
| Electron runtime (Chromium + Node) | ~150 MB |
| better-sqlite3 native module | ~5 MB |
| React dashboard bundle | ~3 MB |
| Python agent (PyInstaller onefile) | ~25 MB |
| NSSM + bundled tools | ~2 MB |
| **Total admin app installer** | **~185 MB** |
| **Agent-only installer (generated)** | **~30 MB** |

Acceptable for a security/management tool (comparable to Prey ~40MB, Absolute agent ~50MB).

---

## 6. Cost to run

| Setup | Monthly cost | Best for |
|---|---|---|
| Electron app on your own PC (LAN/VPN) | $0 | Single admin, small fleet on same network |
| Cloud VPS (Hetzner CX23) + docker-compose.prod | ~$4 | Always-on, reachable from anywhere |
| Railway Hobby + Neon Postgres free | $5-13 | Easiest cloud, no server admin |

---

## 7. Open questions for you

Before I start Phase 0, I need answers to:

1. **Cloud vs local admin?** Should the admin app support both (Electron on your PC + optional cloud deploy via docker-compose), or pick one?
2. **First build target?** Windows first (you mentioned Windows earlier), or all three?
3. **Code signing budget?** Are you willing to pay ~$10/mo (Azure Trusted Signing) for Windows signing, or ship unsigned for now (users see SmartScreen warning)?
4. **Phase 0 security hardening first, or jump to Phase 2 (Electron shell) and harden later?** Research says harden first; but if you want to see the app working sooner, we can defer some hardening.

Reply with answers and I'll start building.
