# Skill Domain: Phase 3 — Code Hardening & Security Review

## Context

The system handles encryption keys, authentication, and remote device control.
Security flaws could cause data loss (failed decryption) or unauthorized access
(bypassed auth). This phase reviews and hardens existing code without changing
functionality.

## Current State

### Server
- `server/src/routes/agent.js` (556 lines) — agent checkin, command ACK, key release
- `server/src/routes/devices.js` (498 lines) — device CRUD, flag stolen, recover
- `server/src/middleware/auth.js` — JWT auth with algorithm allowlist
- `server/src/middleware/hmacAuth.js` (181 lines) — HMAC signing with replay protection
- `server/src/db/fieldCrypto.js` — AES-256-GCM field encryption
- `server/src/db/apiKey.js` — per-device API key management

### Agent
- `agent/agent.py` (1669 lines) — polling, encryption, lock screen, key management
- `agent/hp_uefi_lockdown.py` (681 lines) — HP UEFI BIOS password
- `agent/bcd_lockdown.py` — Windows BCD lockdown
- `agent/offline_recovery.py` (167 lines) — offline recovery tool

## Research Findings

### Error Handling Patterns
- Server routes use try/catch with Express error middleware
- Agent uses try/except with logging but some exception handlers are bare `pass`
- Key concern: **what happens when encryption fails mid-operation?**
  - If Fernet encryption fails partway through LOCKDOWN_FOLDER, some files may be encrypted and others not
  - The agent should track which files were encrypted and support resumption
  - Current code: need to verify if partial-failure recovery exists

### Crypto Edge Cases
1. **Fernet key generation**: Must use `cryptography.fernet.Fernet.generate_key()` — NOT `os.urandom` base64
2. **Key wipe**: After sending key to server, agent must securely wipe the local key copy. `del key` is insufficient — need `ctypes.memset` or similar to zero the memory
3. **Key in transit**: Key is sent over HTTPS to server. Verify the agent endpoint uses POST (not GET) so key doesn't appear in logs
4. **Concurrent lockdown commands**: If two lockdown commands arrive, agent must not double-encrypt. Check for idempotency
5. **Decryption with wrong key**: If server releases wrong key, Fernet will raise `InvalidToken`. Agent must handle this gracefully

### Auth Security
1. **JWT algorithm**: `auth.js` has an algorithm allowlist — verify it rejects `none` algorithm
2. **HMAC replay protection**: `hmacAuth.js` uses nonce cache — verify nonces expire properly
3. **Rate limiting**: `express-rate-limit` is a dependency — verify it's applied to auth and agent endpoints
4. **SQL injection**: `sqli.regression.test.js` exists — verify it covers all routes
5. **CORS**: Verify `CORS_ORIGIN` is not `*` in production

### Input Validation
- Device hostname is used in confirmation (must type hostname to confirm). Verify hostname is sanitized before display (XSS prevention in dashboard)
- Agent config values: verify `SERVER_URL` is a valid URL, `LOCKDOWN_FOLDER` is an absolute path
- File paths: verify no path traversal in agent's file operations

### Lock Screen Security
- Agent applies a lock screen on lockdown. Verify:
  1. The lock screen can't be bypassed by killing the agent process (watchdog should restart it)
  2. The lock screen doesn't expose a way to open a terminal or file manager
  3. On Linux, the lock screen mechanism (is it X11 lock? VT switch? Both?) is robust

## Reasoning Questions

1. **Should we change the crypto implementation or just add tests?**
   - Answer: Primarily add tests that verify edge cases. Only change code if tests reveal actual bugs. Changing crypto code without a clear bug introduces risk.

2. **Should the key wipe use ctypes.memset or a simpler approach?**
   - Answer: Use `cryptography.fernet.Fernet`'s built-in key object. When the Fernet object is garbage collected, the key bytes are freed. For explicit wipe, use `ctypes.memset` on the key string's buffer. But Python strings are immutable, so the key should be stored as a `bytearray` for mutable wiping.

3. **Should we add rate limiting to agent endpoints?**
   - Answer: Yes, but with higher limits than auth endpoints. Agents poll every 30s, so limit to ~10 requests/minute per device. Use the device's API key as the rate limit key.

4. **Should the security test file be separate or integrated into existing tests?**
   - Answer: Separate file (`security.test.js`). Security tests have different concerns and should be runnable independently. They also serve as documentation of security requirements.

5. **Should we fix the bare `pass` exception handlers in the agent?**
   - Answer: Yes — replace with logging. Silent exception swallowing hides bugs. Each `pass` should become `logger.warning(...)` or `logger.error(...)` with the exception details.

## Implementation Guidelines

### server/tests/security.test.js
Test cases:
- JWT with `alg: none` is rejected
- JWT with expired token is rejected
- HMAC with replayed nonce is rejected
- HMAC with stale timestamp is rejected
- Rate limiting kicks in after threshold
- SQL injection attempts on all input params
- CORS headers correct (not `*` in production mode)
- Field encryption: encrypt → decrypt roundtrip
- Field encryption: wrong key produces error, not garbage
- API key: pepper is applied before hashing

### agent/tests/test_hardening.py
Test cases:
- Fernet key generation produces valid key
- Key wipe zeroes the bytearray
- Concurrent lockdown commands are idempotent
- Decryption with wrong key raises InvalidToken (not crash)
- Config validation: invalid SERVER_URL raises error
- Config validation: relative LOCKDOWN_FOLDER raises error
- Lock screen: agent process restart triggers watchdog
- File encryption: partial failure is tracked

### Code Fixes (only if tests reveal bugs)
- Replace bare `pass` in exception handlers with logging
- Add rate limiting to agent routes if missing
- Sanitize hostname before dashboard display
- Validate agent config on startup

## File Boundaries
- CREATE: `server/tests/security.test.js`, `agent/tests/test_hardening.py`
- EDIT (targeted fixes only): `server/src/routes/agent.js`, `server/src/routes/devices.js`, `server/src/middleware/hmacAuth.js`, `agent/agent.py`
- DO NOT REWRITE: any existing route logic, crypto implementation, or auth flow
- DO NOT EDIT: `server/src/db/fieldCrypto.js`, `server/src/db/migrations/`, `agent/hp_uefi_lockdown.py`, `agent/bcd_lockdown.py`
