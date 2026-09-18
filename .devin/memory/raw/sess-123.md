# Session Capture — 2026-09-18 — sess-123

## Context
- Task: S0.6 — detached-signature agent updates + pinned key + key-domain separation (B-006)
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
- Server /update now Ed25519-signs 'v1:{version}:{sha256}' via UPDATE_SIGNING_KEY (path or inline PEM); broken configured key fails closed HTTP 500.
- Agent verify_update_signature pins update_public_key (Ed25519-only), strict b64; configured key makes signature mandatory — missing/invalid refuses + cleans tmp.
- Key-domain separation checked by key MATERIAL not path strings (_check_key_domain_separation).
- Degraded mode: no pinned key → SHA-256-only path works but logs unauthenticated warning; signal file records signature_verified provenance.
- Node crypto.sign(null, payload, pem) does Ed25519; cryptography lib verifies identically.
- Bare 'npx jest' fails on pglite dynamic-import — must use npm test (--experimental-vm-modules).

## Mistakes / Corrections
- mistake: conftest.py lacks sys.path insert — new test files must add sys.path.insert themselves; corrected after first ImportError.
- mistake: first server test run used npx jest not npm test — env flag failure was not a regression.

## Open Questions
- <none recorded>

## File References
- agent/agent.py
- agent/tests/test_agent_update_signature.py
- agent/config.ini.example
- server/src/routes/agent.js
- server/tests/agent.routes.test.js
- server/.env.example
- .devin/brain/beliefs.yaml
- docs/wayfinder/next-gen-lockdown-map.md
- .devin/graph/trace.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
