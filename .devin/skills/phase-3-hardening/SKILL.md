---
name: phase-3-hardening
description: Code hardening, security review, and edge-case test coverage for crypto, auth, and lock screen
---

# Phase 3 — Code Hardening & Security Review

## Context

The system handles encryption keys, authentication, and remote device control.
Security flaws could cause data loss (failed decryption) or unauthorized access
(bypassed auth). This phase reviews and hardens existing code without changing
functionality.

## Current State

### Server (hardened)
- `server/src/routes/agent.js` — agent checkin, command ACK, key release
- `server/src/routes/devices.js` — device CRUD, flag stolen, recover
- `server/src/middleware/auth.js` — JWT auth with algorithm allowlist (rejects `none`)
- `server/src/middleware/hmacAuth.js` — HMAC signing with replay protection (nonce cache with expiry)
- `server/src/db/fieldCrypto.js` — AES-256-GCM field encryption
- `server/src/db/apiKey.js` — per-device API key management with pepper
- Rate limiting applied to auth and agent endpoints via `express-rate-limit`
- `server/tests/security.test.js` — security test suite covering:
  - JWT with `alg: none` rejected, expired tokens rejected
  - HMAC replayed nonce rejected, stale timestamp rejected
  - Rate limiting kicks in after threshold
  - SQL injection attempts on all input params
  - CORS headers correct (not `*` in production)
  - Field encryption roundtrip, wrong key produces error
  - API key pepper applied before hashing
- `server/tests/sqli.regression.test.js` — SQL injection regression tests

### Agent (hardened)
- `agent/agent.py` — polling, encryption, lock screen, key management
- `agent/hp_uefi_lockdown.py` — HP UEFI BIOS password (model-aware setting names)
- `agent/bcd_lockdown.py` — Windows BCD lockdown (with BitLocker awareness)
- `agent/offline_recovery.py` — offline recovery tool
- `agent/tests/test_hardening.py` — agent hardening tests covering:
  - Fernet key generation produces valid key
  - Key wipe zeroes the bytearray
  - Concurrent lockdown commands are idempotent
  - Decryption with wrong key raises InvalidToken (not crash)
  - Config validation: invalid SERVER_URL raises error, relative LOCKDOWN_FOLDER raises error
  - Lock screen: agent process restart triggers watchdog
  - File encryption: partial failure is tracked (blocked files reported)
- Bare `pass` exception handlers replaced with logging

### Crypto Edge Cases (all handled)
1. Fernet key generation uses `Fernet.generate_key()` (not `os.urandom`)
2. Key wipe uses `ctypes.memset` on `bytearray` (mutable) for secure zeroing
3. Key sent over HTTPS via POST (not GET) — doesn't appear in logs
4. Concurrent lockdown commands are idempotent (no double-encrypt)
5. Decryption with wrong key raises `InvalidToken` — handled gracefully

## Verification

```bash
# Run server security tests
cd server && npx jest tests/security.test.js --verbose

# Run agent hardening tests
cd agent && python3 -m pytest tests/test_hardening.py -v

# Run SQL injection regression tests
cd server && npx jest tests/sqli.regression.test.js --verbose

# Lint all components
make lint

# Full verification sweep
make full-verify
```

## Regression checks

1. **Verify JWT rejects `none` algorithm**: `cd server && npx jest tests/security.test.js -t "none"`
2. **Verify HMAC replay protection works**: `cd server && npx jest tests/security.test.js -t "replay"`
3. **Verify rate limiting on agent endpoints**: `cd server && npx jest tests/security.test.js -t "rate"`
4. **Verify Fernet key generation is correct**: `cd agent && python3 -m pytest tests/test_hardening.py -k "fernet" -v`
5. **Verify key wipe zeroes bytearray**: `cd agent && python3 -m pytest tests/test_hardening.py -k "wipe" -v`
6. **Verify no bare `pass` in exception handlers**: `grep -rn "except.*:" agent/*.py | grep -A1 "pass"` should show no bare pass
7. **Verify CORS is not `*` in production**: `grep -r "CORS_ORIGIN" server/src/`

## Gotchas

- Changing crypto code without a clear bug introduces risk — only change if tests reveal actual bugs
- Python strings are immutable — key must be stored as `bytearray` for mutable wiping via `ctypes.memset`
- Agent rate limits are higher than auth (agents poll every 30s, ~10 req/min per device)
- Lock screen can't be bypassed by killing agent process — watchdog restarts it

## Graph Integration

**Phase node**: `P3` in `.devin/graph/GRAPH-SPEC.yaml` — status: COMPLETE

This phase is part of the node graph — the center and heart of the project.
Before working on this phase, an agent MUST:

1. Read `.devin/graph/GRAPH-SPEC.yaml` — locate the `P3` node
2. Read `.devin/graph/current-state.md` — compact session state (read FIRST)
3. Read `docs/adr/DEBT-LEDGER.md` — check for open debt items blocking this phase
4. Complete RULE-ZERO (read this skill file + source code before coding)
5. At session end, append a status block to `trace.md` and run `make gen-state`

**Verification nodes gating this phase**: V-SERVER, V-AGENT, V-LINT-SERVER, V-LINT-AGENT

**Enforcement paths touched by this phase**: E-ENCRYPT, E-DECRYPT, E-LOCK-SCREEN, E-GUARDIAN, E-BCD, E-HP-UEFI, E-ACK, E-RECOVERY, E-TRACK, E-DEADMAN

**Debt items related to this phase**: D-007 (CLOSED), D-008 (CLOSED), D-009 (CLOSED), D-010 (CLOSED), D-011 (CLOSED)

**Graph invariants that apply**:
- I1: Phase dependencies must be COMPLETE before this phase runs
- I5: RULE-ZERO must be complete before any code changes
- I7: If this phase is COMPLETE, its `.complete` file must have a commit hash + artifact ref (D-002 CLOSED)
