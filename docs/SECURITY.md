# Security Architecture & Threat Model

This document describes the security architecture of the Remote Lockdown
System and provides a threat model table identifying assets, threats,
and mitigations.

---

## Security Architecture

### Authentication
- **Admin authentication:** JWT-based (HS256), bcrypt password hashing (cost 12)
- **Agent authentication:** Per-device API keys (hashed with SHA-256)
- **Request integrity:** HMAC-SHA256 signing for agent-to-server communication
- **Rate limiting:** Login attempts rate-limited to prevent brute-force attacks

### Encryption
- **At rest (database):**
  - Sensitive fields (encryption keys, BIOS passwords, location data) encrypted
    with AES-256-GCM using `FIELD_ENCRYPTION_KEY` / `LOCATION_FIELD_KEY`
  - Dual-mode read: decrypts if encrypted, falls back to plaintext for migration
  - Nonces + tags stored alongside ciphertext
- **In transit:** HTTPS/TLS for all client-server and agent-server communication
- **Agent encryption:** Fernet (AES-128-CBC + HMAC-SHA256) for file encryption
- **Recovery key:** RSA-OAEP wrapped with server's public key (A8)

### Access Control
- JWT required for all admin API endpoints (`requireAuth` middleware)
- Per-device API keys prevent cross-device access
- HMAC signing prevents request tampering and replay attacks
- Two-step confirmation (type hostname) for destructive actions

### Data Minimization
- Location data only collected when device is flagged as stolen
- Location data auto-purged after retention period (default 90 days)
- No content monitoring (no files, browsing, keystrokes, audio, video)
- Device release deletes all associated data (GDPR right to erasure)

### Audit Trail
- All administrative actions logged in `audit_log` table
- Agent command execution logged with status (executed/failed/not_now)
- Failed operations logged with error details
- Audit entries retained even after device release (anonymized)

---

## Threat Model

### Assets

| Asset | Description | Sensitivity |
|-------|-------------|-------------|
| Encryption keys | Fernet keys that encrypt locked folders | Critical — loss = data loss |
| BIOS/UEFI passwords | Boot-level protection passwords | Critical |
| Location data | GPS/IP/WiFi location of stolen devices | High — personal data |
| Admin credentials | JWT secret + admin passwords | Critical — system access |
| Agent API keys | Per-device authentication keys | High — device impersonation |
| Device records | Hostname, owner, MAC, UUID | Medium — PII |
| Audit logs | Administrative action history | Medium — accountability |

### Threats and Mitigations

| Threat | Vector | Impact | Mitigation | Residual Risk |
|--------|--------|--------|------------|---------------|
| **Admin credential theft** | Phishing, brute-force, JWT leak | Full system compromise | bcrypt(12), JWT expiry (8h), rate limiting, HTTPS | Low — requires strong password policy |
| **Agent API key theft** | Network sniffing, device compromise | Device impersonation, false check-ins | HTTPS/TLS, HMAC request signing, key hashing | Low — key not stored in plaintext on server |
| **Encryption key interception** | MITM during key transmission | Data decryption by attacker | HTTPS/TLS, HMAC-signed requests, key transmitted only once | Low — TLS provides confidentiality |
| **Database breach** | SQL injection, DB credential leak | All data exposed | Parameterized queries, AES-256-GCM field encryption, `pg_advisory_lock` | Medium — encrypted fields need FIELD_ENCRYPTION_KEY |
| **FIELD_ENCRYPTION_KEY leak** | Server compromise, env var leak | All encrypted fields decryptable | 32-byte random secret, stored in env (not in code), separate keys for location vs keys | Medium — key management is manual |
| **Replay attack** | Captured valid request re-sent | False check-ins, false ACKs | HMAC with timestamp + nonce, command UUIDs for idempotency | Low — timestamp window validation |
| **Agent tampering** | Attacker modifies agent binary | Agent disabled, lockdown bypassed | Watchdog process monitors agent, binary hot-swap for updates | Medium — determined attacker can kill both |
| **Boot bypass** | Attacker boots from USB/CD | Access to unencrypted system files | BCD lockdown, UEFI/BIOS password (HP), full-disk encryption not in scope | Medium — only HP UEFI supported; BCD is bypassable with tools |
| **Disk removal** | Attacker removes hard drive | Access to locked folder (encrypted) | Folder encryption with Fernet, key not on device after lockdown | Low — files are encrypted, key is on server |
| **Factory reset** | Attacker wipes device | Device lost, but data safe | Encryption prevents data access; device becomes unenrollable | Low — data is protected, device is lost |
| **Location data leak** | DB breach, unauthorized admin access | Privacy violation | AES-256-GCM encryption, admin auth required, auto-purge after 90 days | Low — encrypted at rest |
| **SQL injection** | Malicious input in API parameters | Data exfiltration/destruction | Parameterized queries throughout, input validation | Very Low — no string concatenation in SQL |
| **XSS** | Malicious content in dashboard | Admin session hijack | React auto-escaping, no `dangerouslySetInnerHTML`, CSP headers | Very Low — React prevents XSS by default |
| **CSRF** | Malicious site triggers admin action | Unauthorized device action | JWT in Authorization header (not cookies), same-origin policy | Very Low — no cookie-based auth |
| **Supply chain attack** | Compromised npm/pip package | Malicious code in agent/server | `package-lock.json`, minimum release age policy, code review | Medium — dependency scanning recommended |
| **Insider threat** | Malicious admin | False lockdown, data access | Audit logging, two-step confirmation, release requires hostname match | Medium — admin has full access by design |
| **Agent process kill** | Attacker kills agent service | Lockdown not applied | Watchdog process restarts agent, dead man's switch triggers on timeout | Medium — both can be killed by determined attacker |
| **Network partition** | Device offline when stolen | Lockdown command not received | Dead man's switch (auto-lockdown after offline threshold), offline ACK queue | Low — dead man's switch covers this |
| **Key loss** | Server DB corruption, key not transmitted | Device permanently locked, data unrecoverable | Pending ACK file (File A) preserves key for retry, recovery key file (File B) | Low — multiple redundancy layers |
| **False recovery** | Attacker triggers unlock | Device unlocked by unauthorized party | Admin auth + hostname confirmation required, audit logged | Low — requires admin credentials |

### Threats NOT Mitigated (Known Limitations)

| Threat | Why not mitigated | Workaround |
|--------|-------------------|------------|
| **Full disk encryption bypass** | System only encrypts `LOCKDOWN_FOLDER`, not full disk | Use BitLocker/LUKS alongside this system |
| **Hardware attack** | Attacker with physical access can modify hardware | Use TPM-backed encryption (BitLocker with TPM) |
| **Firmware rootkit** | Attacker installs firmware-level malware | Secure Boot + TPM measurement required |
| **Zero-day in dependencies** | Unknown vulnerabilities in Node.js/Python/Electron | Keep dependencies updated, monitor CVEs |
| **Compromised admin** | Malicious admin can lock/unlock any device | Principle of least privilege, audit logs, multi-admin review |
| **BIOS password clearing** | Most BIOS passwords can be cleared by removing CMOS battery | HP UEFI lockdown is more resistant; full-disk encryption is the real protection |

---

## Security Configuration

### Required Environment Variables

| Variable | Purpose | Requirements |
|----------|---------|--------------|
| `JWT_SECRET` | Signs admin JWTs | 32+ bytes, high entropy |
| `FIELD_ENCRYPTION_KEY` | Encrypts sensitive DB fields | 32 bytes, high entropy |
| `LOCATION_FIELD_KEY` | Encrypts location data | 32 bytes, high entropy |
| `DB_PASSWORD` | PostgreSQL password | Strong password |
| `AGENT_SHARED_KEY` | Legacy agent auth (if used) | 32+ bytes |

### Security Headers (Caddy)

The Caddy reverse proxy (cloud deployment) sets:
- `Strict-Transport-Security`: enforce HTTPS
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`

### Rate Limiting

- Login endpoint: rate-limited to prevent brute-force
- Agent check-in: no rate limit (legitimate agents check in frequently)
- Admin API: rate-limited per IP

---

## Security Recommendations

1. **Use strong, unique secrets** for `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`,
   and `LOCATION_FIELD_KEY`. Generate with: `openssl rand -hex 32`
2. **Enable TLS** in production (Caddy provides automatic HTTPS)
3. **Set `verify_tls = true`** in agent config to prevent MITM
4. **Regularly rotate API keys** if you suspect compromise
5. **Monitor audit logs** for suspicious activity
6. **Keep dependencies updated** — run `npm audit` and `pip audit` regularly
7. **Use full-disk encryption** (BitLocker/LUKS) alongside this system for
   defense in depth
8. **Restrict admin access** to trusted personnel only
9. **Back up the database** regularly — encryption keys are in the DB
10. **Secure the backup** — if the backup is compromised, all keys are too

---

## Vulnerability Reporting

If you discover a security vulnerability, please report it responsibly:
- **Email:** research@remotelockdown.com
- **Do NOT** open a public GitHub issue for security vulnerabilities
- Include: description, reproduction steps, potential impact
- We will acknowledge within 48 hours and provide a fix timeline

---

## Security Review Checklist

- [ ] All secrets are 32+ bytes and high entropy
- [ ] TLS is enabled for all communication
- [ ] `verify_tls = true` in agent config
- [ ] Database backups are encrypted
- [ ] Admin accounts use strong passwords
- [ ] Audit logs are monitored
- [ ] Dependencies are up to date
- [ ] Rate limiting is enabled
- [ ] Security headers are set (Caddy)
- [ ] Code signing is enabled for releases
- [ ] Location retention period is configured
- [ ] Dead man's switch timeout is configured
