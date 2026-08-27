# Session Capture — 2026-08-21 — sess-008

## Context
- Task: Built 5-layer defense-in-depth for lockdown state protection: fail-secure logic, TPM 2.0 sealed storage, DPAPI+HMAC encryption, Windows service installer with auto-restart watchdog, and Cloudflare Worker serverless endpoint
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- Fail-secure (CWE-636): missing sentinel + deadman says stolen = locked, not unlocked. This is the highest-impact, lowest-complexity change.
- TPM 2.0 sealing via Windows CNG MS_PLATFORM_CRYPTO_PROVIDER: creates RSA key in TPM, encrypts AES data key with RSA, encrypts state with AES-256-GCM. Survives disk wipe, OS reinstall, drive swap, CMOS clear. Does NOT survive TPM clear or motherboard replacement.
- DPAPI (CryptProtectData) binds encrypted state to machine+user. Falls back to XOR on non-Windows for testing. HMAC-SHA256 provides tamper detection (encrypt-then-MAC).
- Windows scheduled task watchdog: runs every 5 min as SYSTEM, checks if agent process is alive, re-launches if killed. Registry run key as backup persistence. Innocuous name 'SystemHealthMonitor'.
- Cloudflare Worker with KV storage: full API (ping, command-ack, enroll, list devices, flag stolen, recover). HMAC-SHA256 agent auth, bearer token admin auth. Replaces need for always-on server.
- Agent already had deadman switch (24h timeout), offline queue, recovery key file (RSA-wrapped), pending ACK file (crash safety), Session 0 detection. The new layers build on this existing infrastructure.

## Mistakes / Corrections
- Initial test for is_encrypted_state_file used Path.read_bytes(size) which doesn't accept a size parameter. Fixed to use open() with f.read(N).
- vitest couldn't parse TypeScript syntax in .js file. Fixed by renaming worker.js to worker.ts and worker.test.js to worker.test.ts, and updating vitest.config.js include patterns.
- TPM seal/unseal round-trip test failed because unseal_state checks _is_windows() first. Fixed by adding @patch.object(tpm_seal, '_is_windows', return_value=True) to the test.

## Open Questions
- <none recorded>

## File References
- agent/agent.py (startup_check rewritten with fail-secure logic + _read_deadman_state helper)
- agent/state_crypto.py (NEW: DPAPI + HMAC state encryption module)
- agent/tpm_seal.py (NEW: TPM 2.0 sealed storage module)
- agent/service_installer.py (NEW: Windows service/scheduled task installer)
- agent/tests/test_agent.py (3 new fail-secure tests)
- agent/tests/test_state_crypto.py (NEW: 21 tests)
- agent/tests/test_tpm_seal.py (NEW: 19 tests)
- agent/tests/test_service_installer.py (NEW: 16 tests)
- serverless/worker.ts (NEW: Cloudflare Worker endpoint)
- serverless/worker.test.ts (NEW: 8 tests)
- serverless/wrangler.toml (NEW: deployment config)
- serverless/package.json (NEW: npm config)
- serverless/vitest.config.js (NEW: vitest config)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
