# Session Capture — 2026-08-28 — sess-022

## Context
- Task: Implemented 3 workstreams in parallel: (1) complete tamper protection (check_tamper in loop + TPM sealing), (2) covert duress trigger (duress code + hidden file trigger), (3) streamlined enrollment (token-based, QR code, one-line installer command). 1002 tests pass.
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
- check_tamper() now runs every 5 min in agent main loop. If tampering detected AND device is stolen/locked, agent re-asserts lockdown (re-encrypt, re-lock screen, restart guardian).
- TPM 2.0 sealing integrated into _read_deadman_state() and update_deadman_timer(). Tries TPM format (magic TPM1) first, falls back to DPAPI (LDS1), then plaintext. Import guards make it work on Linux.
- Duress code: dashboard 'Release with Duress Code' button sends duress_code:true. Agent pretends to unlock, re-encrypts with new key after 60s, re-locks after 5 min. Invisible.
- Hidden file trigger: .system_cache_cleanup file in state dir triggers immediate lockdown. Innocuous filename. Checked every loop iteration. Deleted after acting.
- Enrollment tokens: POST /api/enroll/token (admin, 15-min, single-use) + POST /api/enroll/claim (installer, no admin auth). Token stored in KV, deleted after claim.
- EnrollDevicePage: token generation, QR code (api.qrserver.com), one-line command, countdown timer, device polling. Route /devices/enroll.
- installer.py: --token argument for token-based enrollment. Backward compat with --admin-token.
- duress.py uses injected callbacks for platform-specific ops (encrypt, lock screen, guardian) — testable on Linux.
- Electron app tested on Windows: built win-unpacked, launched via WSL interop, setup wizard appeared, Worker URL validated, config saved, dashboard loaded.
- Agent Windows .exe built via WSL interop: python.exe -m PyInstaller agent.spec. PyInstaller does NOT cross-compile — must run on target OS.
- @noble/hashes override needed for Node 20.18 compat with electron-builder.

## Mistakes / Corrections
- No failures. All 3 workstreams completed in parallel without conflicts (disjoint file sets).

## Open Questions
- <none recorded>

## File References
- agent/agent.py
- agent/duress.py
- agent/installer.py
- agent/tests/test_tamper_integration.py
- agent/tests/test_duress.py
- agent/tests/test_installer.py
- serverless/worker.ts
- serverless/worker.test.ts
- dashboard/src/pages/EnrollDevicePage.jsx
- dashboard/src/pages/DeviceDetailPage.jsx
- dashboard/src/App.jsx
- dashboard/tests/EnrollDevicePage.test.jsx
- electron/test-simulation.js

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
