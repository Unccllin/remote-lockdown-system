# Skill Domain: Phase 1 — Secrets & Configuration Management

## Context

The system requires several cryptographic secrets for production:
- `JWT_SECRET` — signs admin auth tokens
- `AGENT_SHARED_KEY` — legacy pre-shared key for agent auth
- `AGENT_KEY_PEPPER` — peppers per-device API keys before hashing
- `FIELD_ENCRYPTION_KEY` — encrypts sensitive DB fields (device names, etc.)
- `LOCATION_FIELD_KEY` — encrypts location data at rest
- Recovery RSA key pair — for offline agent recovery

## Current State

- `server/.env.example` documents all vars (58 lines)
- `.env.prod.example` documents production vars (46 lines)
- `docker-compose.yml` references `./secrets/*.txt` files that don't exist
- `agent/config.ini.example` documents agent config
- **No secret generation scripts** — admins must manually generate secrets
- **No env validation** — server starts even with missing/weak secrets
- **No recovery key generation tooling**

## Research Findings

### Secret Requirements
| Secret | Min Length | Format | Source |
|--------|-----------|--------|--------|
| JWT_SECRET | 32 bytes | hex (64 chars) | `openssl rand -hex 32` |
| AGENT_SHARED_KEY | 32 bytes | hex | `openssl rand -hex 32` |
| AGENT_KEY_PEPPER | 32 bytes | hex | `openssl rand -hex 32` |
| FIELD_ENCRYPTION_KEY | 32 bytes | base64 | AES-256 key |
| LOCATION_FIELD_KEY | 32 bytes | base64 | AES-256 key |
| Recovery RSA | 4096 bits | PEM | `openssl genrsa` |

### Docker Secrets Pattern
`docker-compose.yml` mounts secrets as files under `/run/secrets/`. The server reads them via `process.env.DOCKER_SECRET_PATH` or falls back to env vars. Current compose references:
- `./secrets/jwt_secret.txt`
- `./secrets/agent_key_pepper.txt`
- `./secrets/field_encryption_key.txt`
- `./secrets/location_field_key.txt`

### Server Env Loading
`server/src/config/env.js` loads env vars via dotenv. It reads:
- `DATABASE_URL` or individual `DB_*` vars
- `JWT_SECRET`, `JWT_EXPIRES_IN`
- `AGENT_SHARED_KEY`, `AGENT_KEY_PEPPER`
- `FIELD_ENCRYPTION_KEY`, `LOCATION_FIELD_KEY`
- `CORS_ORIGIN`, `NODE_ENV`, `PORT`

### Field Encryption
`server/src/db/fieldCrypto.js` uses AES-256-GCM with the `FIELD_ENCRYPTION_KEY`. The key must be a 32-byte base64 string. If the key changes, existing encrypted data becomes undecryptable.

### Recovery Key Flow
1. Admin generates RSA key pair: private key kept offline, public key distributed to agents
2. Agent encrypts its Fernet key with the RSA public key and stores the wrapped key locally
3. If agent can't reach server, offline_recovery.py can decrypt the wrapped key using the RSA private key
4. `agent/offline_recovery.py` (167 lines) implements this — needs `recovery_master.pub` on device

## Reasoning Questions

1. **Should generate-secrets.sh write to ./secrets/ or print to stdout?**
   - Answer: Both modes. Default writes to `./secrets/`, `--stdout` prints for piping. `--dry-run` shows what would be generated without writing.

2. **Should validate-env.sh be callable from server startup?**
   - Answer: Yes. The server should call it on boot and refuse to start in production with missing/weak secrets. But validate-env.sh should also be standalone for CI.

3. **Should recovery key generation be part of generate-secrets.sh or separate?**
   - Answer: Separate script (`generate-recovery-keys.sh`). Recovery keys are managed differently — the public key is distributed to all devices, the private key is kept in a safe/HSM. Mixing them with app secrets creates operational confusion.

4. **Should secrets be rotated? Does the script need rotation support?**
   - Answer: Not in this phase. Rotation of FIELD_ENCRYPTION_KEY requires re-encrypting all DB data — that's a separate feature. Document this limitation.

## Implementation Guidelines

### scripts/generate-secrets.sh
- `--output <dir>` — output directory (default: `./secrets/`)
- `--dry-run` — show what would be generated without writing
- `--stdout` — print secrets to stdout (for piping to other tools)
- `--force` — overwrite existing secrets (default: refuse to overwrite)
- Generate all 4 Docker secrets + print env var equivalents
- Validate each secret meets minimum entropy requirements
- Print summary of generated files

### scripts/generate-recovery-keys.sh
- `--output <dir>` — output directory (default: `./keys/`)
- Generate 4096-bit RSA key pair
- Output: `recovery_master.key` (private, chmod 600) and `recovery_master.pub` (public)
- Print deployment instructions (where to put each file)
- `--force` to overwrite

### scripts/validate-env.sh
- `--check-required` — verify all required env vars are set
- `--check-strength` — verify secrets meet minimum length/entropy
- `--env-file <path>` — validate a specific .env file
- `--production` — strict mode, fail on any missing var
- `--json` — output validation results as JSON
- Exit 0 if valid, 1 if missing vars, 2 if weak secrets

## File Boundaries
- CREATE: `scripts/generate-secrets.sh`, `scripts/generate-recovery-keys.sh`, `scripts/validate-env.sh`
- DO NOT EDIT: `server/.env.example`, `.env.prod.example`, `docker-compose.yml`, `server/src/config/env.js`
