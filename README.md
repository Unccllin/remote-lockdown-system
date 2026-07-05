# Remote Device Lockdown System

Anti-theft system for field devices. Lets IT admins remotely flag a stolen device, encrypt its sensitive data folder, and lock the screen — all reversible when the device is recovered.

```
remote-lockdown-system/
├── server/          # Node.js / Express API + PostgreSQL
├── dashboard/       # React + Vite + Tailwind admin UI
└── agent/           # Python background agent (runs on managed device)
```

---

## Quick Start

### 1. Prerequisites
- Node.js 18+, npm
- PostgreSQL 14+
- Python 3.10+

### 2. Server

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

### 3. Dashboard

```bash
cd dashboard
npm install
npm run dev
# Open http://localhost:5173
```

Create your first admin account by POSTing to `/api/auth/register`:
```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"yourpassword"}'
```

### 4. Agent (run on a VM/sandbox only)

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
Admin Dashboard (React)
        │  JWT auth
        ▼
  Express API (Node)
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
| `CORS_ORIGIN` | Dashboard origin (default `http://localhost:5173`) |

### Agent (env vars or `config.ini`)
| Variable | Description |
|---|---|
| `SERVER_URL` | Full URL of the server |
| `AGENT_SHARED_KEY` | Must match server's `AGENT_SHARED_KEY` |
| `DEVICE_HOSTNAME` | Hostname registered in the dashboard |
| `LOCKDOWN_FOLDER` | Folder to encrypt on lockdown |
| `POLL_INTERVAL` | Seconds between check-ins (default `30`) |
