# Remote Device Lockdown System

Anti-theft system for field devices. Lets IT admins remotely flag a stolen device, encrypt its sensitive data folder, and lock the screen — all reversible when the device is recovered.

```
remote-lockdown-system/
├── server/          # Node.js / Express API + PostgreSQL + serves dashboard
├── dashboard/       # React + Vite + Tailwind admin UI (built, served by server)
├── agent/           # Python background agent (runs on managed device)
├── electron/        # Electron desktop app (packaged admin + agent installer)
├── docs/            # Legal, security, and testing documentation
└── docker-compose.prod.yml  # Cloud deployment (Postgres + Caddy + server)
```

The server serves both the API (`/api/*`) and the built dashboard (static
files + SPA fallback) from a single Express process on one origin. This
eliminates CORS configuration and ensures the dashboard loads even when
the database is down — the React app handles API failures via error toasts.

---

## Quick Start

### Option A: Install as Desktop App (Recommended)

1. Download the installer from [GitHub Releases](https://github.com/unccllin/remote-lockdown-system/releases)
   - **Windows:** `Remote-Lockdown-Admin-Setup-x.y.z.exe`
   - **macOS:** `Remote-Lockdown-Admin-x.y.z.dmg`
   - **Linux:** `Remote-Lockdown-Admin-x.y.z.AppImage`
2. Run the installer and launch "Remote Lockdown Admin"
3. Create your admin account on first run
4. Click "Enroll New Device" to enroll a device and download the agent installer

The desktop app bundles the admin server, dashboard, and agent installer
generator. No separate server setup needed. Auto-updates via GitHub Releases.

See [electron/README.md](electron/README.md) for build + sign instructions.

### Option B: Cloud Deployment (Docker)

```bash
cp .env.prod.example .env.prod
# Edit .env.prod with your domain, DB password, JWT secret, etc.
# Dev/test stack (SQLite-free server, Docker secrets):
make dev-up          # generates ./secrets on first run, then starts the stack

# Production stack (Postgres + Caddy):
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
```

This starts PostgreSQL, the admin server, and Caddy (auto-HTTPS).
Navigate to `https://your-domain.com` and create your admin account.

### Option C: Development Setup

#### 1. Prerequisites
- Node.js 20+, npm
- PostgreSQL 14+ (or use SQLite for development)
- Python 3.10+

#### 2. Server

```bash
cd server
npm install

# Copy and fill in your values
cp .env.example .env

# Create the DB, then run migrations
createdb lockdown_db
node src/db/migrate.js

# Start dev server
npm run dev
```

#### 3. Dashboard

```bash
cd dashboard
npm install
npm run dev
# Open http://localhost:5173
```

Create your first admin account by POSTing to `/api/setup/create-admin`
(this endpoint only works while no admin exists — it returns 403 once the
first admin has been created, so it cannot be used to create rogue accounts):
```bash
curl -X POST http://localhost:3001/api/setup/create-admin \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"yourpassword"}'
```

#### 4. Agent (run on a VM/sandbox only)

```bash
cd agent
pip install -r requirements.txt
cp config.ini.example config.ini
# Edit config.ini with your server URL and shared key
python agent.py
```

---

## Architecture

```
Admin Dashboard (React SPA)
        │  same-origin, JWT auth
        ▼
  Express API (Node) ── also serves dashboard/dist (static + SPA fallback)
        │  Reads/writes
        ▼
  PostgreSQL
   ┌─────────────────────┐
   │ devices             │
   │ commands (queue)    │
   │ encryption_keys     │
   │ audit_log           │
   └─────────────────────┘
        ▲  Poll every 30s / x-agent-key
        │
  Python Agent (device)
```

## Lockdown Flow

1. Admin clicks **Flag as Stolen** → types hostname to confirm → server sets `status=stolen`, queues `lockdown` command
2. Agent polls → receives command → encrypts `LOCKDOWN_FOLDER` with a fresh Fernet key → applies lock screen → sends key to server → wipes local key copy → ACKs command
3. Dashboard shows **"Lockdown confirmed"** — audit log records everything

## Recovery Flow

1. Admin clicks **Recover Device** → types hostname → server queues `unlock`, releases key to agent endpoint
2. Agent decrypts folder, removes lock screen, ACKs
3. `device.status` → `active`

---

## Safety Rules

- **Only encrypts** `LOCKDOWN_FOLDER` (default: `~/SecureData`) — never system files or full disk
- **Key never stored locally** after locking — lives only in the server DB
- **TLS required** — set `verify_tls = true` in agent config
- **Two-step confirmation** on all destructive actions (must type device hostname)
- **Test on a VM only** — never run the agent on a production machine

---

## Environment Variables

### Server (`server/.env`)
| Variable | Description |
|---|---|
| `DB_*` | PostgreSQL connection |
| `JWT_SECRET` | Long random secret for signing tokens |
| `JWT_EXPIRES_IN` | Token lifetime (default `8h`) |
| `AGENT_SHARED_KEY` | Pre-shared key the agent uses to authenticate |
| `CORS_ORIGIN` | Optional. Dashboard origin for dev (e.g., `http://localhost:5173` for Vite). When unset, CORS is disabled (production same-origin). |

### Agent (env vars or `config.ini`)
| Variable | Description |
|---|---|
| `SERVER_URL` | Full URL of the server |
| `AGENT_SHARED_KEY` | Must match server's `AGENT_SHARED_KEY` |
| `DEVICE_HOSTNAME` | Hostname registered in the dashboard |
| `LOCKDOWN_FOLDER` | Folder to encrypt on lockdown |
| `POLL_INTERVAL` | Seconds between check-ins (default `30`) |

---

## Documentation

| Document | Description |
|----------|-------------|
| [docs/PRIVACY_POLICY.md](docs/PRIVACY_POLICY.md) | Privacy policy (GDPR/CCPA compliant) |
| [docs/TERMS_OF_SERVICE.md](docs/TERMS_OF_SERVICE.md) | Terms of service / EULA |
| [docs/GDPR_LIA.md](docs/GDPR_LIA.md) | GDPR Legitimate Interest Assessment |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model + security architecture |
| [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) | Code signing guide (Windows + macOS) |
| [docs/E2E_TEST.md](docs/E2E_TEST.md) | End-to-end test guide |
| [electron/README.md](electron/README.md) | Electron app build + sign instructions |

---

## Testing

```bash
# Agent tests (Python)
cd agent && pip install -r requirements.txt && pip install pytest && pytest tests/ -v

# Server tests (Node.js)
cd server && npm install && npm test

# Dashboard tests (React)
cd dashboard && npm install && npm test
```

See [docs/E2E_TEST.md](docs/E2E_TEST.md) for the full end-to-end test flow.
