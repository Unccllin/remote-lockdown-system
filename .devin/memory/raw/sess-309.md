# Session Capture — 2026-11-19 — sess-309

## Context
- Task: Exercise ADR-010 key rotation end to end on this host (the S309 next opening)
- Environment: real Express server on 3311 with throwaway SQLite; real agent modules; no hardware, no Cloudflare creds
- Duration: <not specified>

## Decisions Made
- drive all four contract states (key A, key B, empty->null, unset) rather than just the happy path
- record host-level as emulated on the evidence ladder, not hardware
- do not push a secret to the deployed Worker: wrangler shows it holds only ADMIN_TOKEN and a real key is operator-held

## Actions Taken
- wrote a throwaway driver (/tmp/probe_rotation.py) that boots the real server per phase and calls the real agent functions
- fixed two probe-side blockers: ALLOW_NON_PROD + non-placeholder secrets, then USE_SQLITE=true
- got 13/13 PASS, cleaned up servers, captured the verbatim output into docs/artifacts/s310-rotation-live-probe.txt
- committed d756729

## Outcomes
- What worked: - the rotation semantics are now observed rather than argued: null clears the override and the install-time key reappears
- asserting file mtime catches the no-rewrite behaviour that a value check would miss
- What failed: - first two probe runs failed for environment reasons (no USE_SQLITE, placeholder secrets), not product reasons
- What was unexpected: - SQLite mode is selected by USE_SQLITE=true only; SQLITE_PATH alone leaves the server talking to Postgres while health returns 200 and setup says 'Database not initialized'
- the deployed Worker has exactly ONE secret (ADMIN_TOKEN), so no device in production can be receiving a settings object today

## Learnings
- a health 200 does not mean the database the caller expects is the one being used; check the driver in the boot log
- when wrapping a CLI in a probe, kill by captured PID: pkill -f matches the probe's own command line

## Mistakes / Corrections
- mistake: assumed SQLITE_PATH selects SQLite; correction: pool.js:24 keys on USE_SQLITE=true and scrubs DATABASE_URL

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s310-rotation-live-probe.txt
- /tmp/probe_rotation.py (throwaway driver, not added to the repo)
- server/src/db/pool.js (read: the USE_SQLITE switch)
- agent/agent.py (exercised: checkin, _reconcile_runtime_settings, _effective_google_key)

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
